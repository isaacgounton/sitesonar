import { chromium, type BrowserContext, type Page } from 'playwright';
import type { BrowserPool } from '../../browser.js';
import { deriveProxy } from '../../proxy.js';
import { Lead, MapsBlockedError } from './types.js';
import { extractPhone, extractAddress, pickWebsite, extractRating } from './maps-parse.js';

export interface ScrapeArgs {
  browser: BrowserPool;
  query: string;
  max: number;
  proxyUrl?: string;
  proxyBypass?: string;
  timeoutMs: number;
  /**
   * When true, open each result's detail panel to extract website, phone, full
   * address, review count, and category — fields the list view doesn't expose.
   * One navigation per result, so it's slower; bounded by the overall timeout.
   */
  details: boolean;
}

const CONTEXT_OPTS = {
  viewport: { width: 1280, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  locale: 'en-US',
  // Force English regardless of the egress IP's geo. Without this an EU-hosted
  // IP gets German Maps ("Sterne"/"Geschlossen"), which breaks rating/address
  // parsing. Reinforced by the hl=en&gl=us query params on the search URL.
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
};

export async function scrapeGoogleMaps(
  args: ScrapeArgs,
): Promise<{ leads: Lead[]; warnings: string[] }> {
  const proxy = args.proxyUrl
    ? deriveProxy({ proxyUrl: args.proxyUrl, proxyBypass: args.proxyBypass })
    : undefined;

  // A per-request proxy gets its own short-lived Chromium (proxy must be set at
  // launch on this Playwright version); otherwise reuse the shared pool, which
  // already carries the global PROXY_URL.
  if (proxy) {
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
      proxy,
    });
    try {
      const context = await browser.newContext(CONTEXT_OPTS);
      return await runScrape(context, args);
    } finally {
      await browser.close();
    }
  }

  const context = await args.browser.acquire(CONTEXT_OPTS);
  try {
    return await runScrape(context, args);
  } finally {
    await args.browser.release(context);
  }
}

/**
 * Click through the Google consent interstitial (consent.google.com). Tries a
 * few button variants (the page localises and restructures often); each click
 * is raced against the URL leaving consent.google.com so we proceed as soon as
 * any one works. No-op if none match — the caller re-checks the URL.
 */
async function acceptConsent(page: Page): Promise<void> {
  const offConsent = (u: URL): boolean => !u.toString().includes('consent.google.com');
  const selectors = [
    'button[aria-label*="Accept all" i]',
    'button[aria-label*="Reject all" i]',
    'form[action*="consent"] button[type="submit"]',
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    'button:has-text("I agree")',
  ];
  for (const sel of selectors) {
    try {
      await Promise.all([
        page.waitForURL(offConsent, { timeout: 20_000 }),
        page.click(sel, { timeout: 3_000 }),
      ]);
      return;
    } catch {
      /* selector absent or navigation didn't fire — try the next variant */
    }
  }
}

async function runScrape(
  context: BrowserContext,
  args: ScrapeArgs,
): Promise<{ leads: Lead[]; warnings: string[] }> {
  const warnings: string[] = [];
  const leads: Lead[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + args.timeoutMs;

  await context.addInitScript(
    "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})",
  );

  // Pre-accept Google's EU cookie consent so the search isn't redirected to
  // consent.google.com, which otherwise hides every result behind an
  // interstitial (seen on EU-hosted IPs). Best-effort — a stale cookie is
  // harmless, and acceptConsent() below is the interactive fallback.
  await context.addCookies([
    { name: 'CONSENT', value: 'YES+', domain: '.google.com', path: '/' },
    {
      name: 'SOCS',
      value: 'CAESHAgBEhJnd3NfMjAyMzA3MjUtMF9SQzEaAmVuIAEaBgiAo_CmBg',
      domain: '.google.com',
      path: '/',
    },
  ]);

  const page = await context.newPage();
  const url = `https://www.google.com/maps/search/${encodeURIComponent(args.query)}?hl=en&gl=us`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForTimeout(8_000);
  }

  const landed = page.url();
  if (landed.includes('accounts.google.com') || landed.includes('/sorry/')) {
    throw new MapsBlockedError(landed);
  }

  // EU consent wall: if Google still redirected to consent.google.com, click
  // through it. If we can't get past it, surface a clear block error rather
  // than an opaque "no results".
  if (page.url().includes('consent.google.com')) {
    await acceptConsent(page);
    if (page.url().includes('consent.google.com')) {
      throw new MapsBlockedError(page.url());
    }
  }

  // Dismiss consent (best-effort).
  try {
    await page.click('button[aria-label*="accept" i]', { timeout: 3_000 });
  } catch {
    /* no popup */
  }

  try {
    await page.waitForSelector('a[href^="https://www.google.com/maps/place"]', {
      timeout: 15_000,
    });
  } catch {
    warnings.push('no results appeared within 15s');
    return { leads, warnings };
  }

  const feed =
    (await page.$('[role="feed"]')) ??
    (await page.$('[aria-label*="Results" i]')) ??
    (await page.$('div[role="main"]'));

  while (leads.length < args.max && Date.now() < deadline) {
    const cards = await page.$$('a[href^="https://www.google.com/maps/place"]');
    let added = 0;
    for (const card of cards) {
      const href = (await card.getAttribute('href')) ?? '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const lead = await parseCard(card, href);
      if (lead) {
        leads.push(lead);
        added += 1;
      }
      if (leads.length >= args.max) break;
    }
    if (!feed) break;
    const prev = await feed.evaluate((el) => el.scrollTop);
    await feed.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(2_000);
    const next = await feed.evaluate((el) => el.scrollTop);
    if (next <= prev && added === 0) break;
  }

  leads.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const finalLeads = leads.slice(0, args.max);

  // Optional second pass: open each place's detail panel for the fields the
  // list cards omit (website, phone, full address, review count, category).
  // Reuse the same page; stop when the time budget is nearly spent.
  if (args.details) {
    for (const lead of finalLeads) {
      if (Date.now() > deadline - 5_000) {
        warnings.push('detail extraction stopped at time budget');
        break;
      }
      try {
        await augmentWithDetails(page, lead);
      } catch {
        warnings.push(`${lead.title}: detail panel fetch failed`);
      }
    }
  }

  return { leads: finalLeads, warnings };
}

/**
 * Open a place's detail panel (via its Maps link) and fill in fields the list
 * card doesn't carry. Mutates `lead` in place, only overwriting when the panel
 * yields a value. Selectors use Google's stable-ish `data-item-id` panel
 * attributes (`authority` = website, `phone:tel:` = phone, `address`).
 */
async function augmentWithDetails(page: Page, lead: Lead): Promise<void> {
  if (!lead.googleMapsLink) return;
  await page.goto(lead.googleMapsLink, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('h1', { timeout: 10_000 }).catch(() => {});

  const d = await page.evaluate(() => {
    const text = (el: Element | null): string => (el?.textContent ?? '').trim();
    const website =
      (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null)?.href ?? '';

    const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
    const phone = phoneBtn
      ? (phoneBtn.getAttribute('data-item-id') ?? '').replace('phone:tel:', '')
      : '';

    const addrBtn = document.querySelector('button[data-item-id="address"]');
    const address = addrBtn
      ? (addrBtn.getAttribute('aria-label') ?? '').replace(/^Address:\s*/i, '')
      : '';

    const category = text(document.querySelector('button[jsaction*="category"]'));
    const name = text(document.querySelector('h1'));

    // The header rating block reads like "4.5(1,234)" or "4.5 (1,234 reviews)".
    let rating = 0;
    let reviewCount = 0;
    const ratingText = text(document.querySelector('div.F7nice'));
    const m = ratingText.match(/([\d.]+)\D+([\d,]+)/);
    if (m) {
      rating = Number.parseFloat(m[1] ?? '') || 0;
      reviewCount = Number.parseInt((m[2] ?? '').replace(/,/g, ''), 10) || 0;
    }

    return { website, phone, address, category, name, rating, reviewCount };
  });

  if (d.website) lead.website = d.website;
  if (d.phone) lead.phone = d.phone;
  if (d.address) lead.address = d.address;
  if (d.category) lead.category = d.category;
  if (d.name) lead.title = d.name;
  if (d.rating) lead.rating = d.rating;
  if (d.reviewCount) lead.reviewCount = d.reviewCount;
}

async function parseCard(
  card: import('playwright').ElementHandle<SVGElement | HTMLElement>,
  href: string,
): Promise<Lead | null> {
  // The card anchor's nearest ancestor that holds the full result block.
  const container = await card.evaluateHandle((el) => {
    let c: Element | null = el as Element;
    for (let i = 0; i < 12 && c; i++) {
      c = c.parentElement;
      if (c && (c.textContent ?? '').length > 40) return c;
    }
    return el as Element;
  });
  const el = container.asElement();
  if (!el) return null;

  const data = await el.evaluate((node) => {
    const titleEl = node.querySelector(
      '.fontHeadlineSmall, .qBF1Pd, .fontHeadlineLarge, [aria-level]',
    );
    const ratingImg = node.querySelector('[role="img"]');
    const anchors = Array.from(node.querySelectorAll('a[href]')).map(
      (a) => (a as HTMLAnchorElement).href,
    );
    return {
      title: ((titleEl?.textContent ?? '').trim() || (node.getAttribute('aria-label') ?? '').split(',')[0]?.trim()) ?? '',
      ratingAria: ratingImg?.getAttribute('aria-label') ?? '',
      text: (node as HTMLElement).innerText ?? '',
      anchors,
    };
  });

  if (!data.title) return null;
  const { rating, reviewCount } = extractRating(data.ratingAria);

  return {
    title: data.title,
    rating,
    reviewCount,
    phone: extractPhone(data.text),
    address: extractAddress(data.text),
    website: pickWebsite(data.anchors),
    googleMapsLink: href,
  };
}
