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
  return { leads: leads.slice(0, args.max), warnings };
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
