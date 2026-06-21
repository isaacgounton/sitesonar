# Leads Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three stateless `/v1/leads/*` endpoints to sitesonar — Google Maps scrape, website-crawl enrichment, and HubSpot contact push — ported from the MapLeads project onto sitesonar's TypeScript/Fastify/Playwright stack.

**Architecture:** Each endpoint is a Fastify route plugin backed by a service module under `src/services/leads/`. The scrape/enrich/hubspot logic is split into pure helper functions (regex/cheerio/string ops — unit-tested against fixtures) and thin orchestrators (Playwright/fetch — exercised manually). Endpoints are stateless; the caller chains the JSON output of one into the next. The scrape endpoint accepts an optional per-request proxy, falling back to the global `PROXY_URL`.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, Playwright 1.60, cheerio 1.0, zod 4, vitest 2. Node `dns/promises` for MX checks. No new npm dependencies.

## Global Constraints

- **No new npm dependencies.** Use `playwright`, `cheerio`, `zod`, and Node built-ins (`node:dns/promises`, `fetch`) only. No HubSpot SDK.
- **ESM imports use the `.js` extension** in relative import paths (e.g. `import { x } from './types.js'`) — this repo is `"type": "module"` with NodeNext resolution.
- **Every `/v1` route** sets `tags`, `security: [{ bearerAuth: [] }]`, and validates the body with a zod `safeParse`, returning `400 { error: 'bad_request', issues }` on failure — mirror `src/routes/company.ts` and `src/routes/extract.ts`.
- **Browser usage** must `acquire` a context and `release` it in a `finally` block — mirror `src/routes/extract.ts:78-140`.
- **Proxy parsing** reuses `deriveProxy()` from `src/proxy.ts`. Do not re-implement URL parsing.
- **Tests** are colocated as `*.test.ts` next to the source, using `vitest` (`describe`/`it`/`expect`). Run with `npm test`. Fixtures live under `test/fixtures/<group>/`.
- **Commits** end with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Work happens on branch `feat/leads-pipeline` (already created).

---

## File Structure

**Create:**
- `src/services/leads/types.ts` — `Lead` interface, shared error classes, `composeQuery`.
- `src/services/leads/maps-parse.ts` — pure card-extraction helpers (`extractPhone`, `extractAddress`, `pickWebsite`, `extractRating`).
- `src/services/leads/maps-parse.test.ts`
- `src/services/leads/maps.ts` — Playwright scrape orchestrator (`scrapeGoogleMaps`).
- `src/services/leads/enrich-extract.ts` — pure HTML helpers (`extractEmails`, `extractPhones`, `extractSocialLinks`, `bestEmail`, `candidateUrls`).
- `src/services/leads/enrich-extract.test.ts`
- `src/services/leads/enrich.ts` — enrichment orchestrator (`enrichLeads`, `guessEmail`).
- `src/services/leads/enrich.test.ts`
- `src/services/leads/hubspot-map.ts` — pure mapping (`industryToTag`, `mapContactProperties`, `firstLastFromTitle`).
- `src/services/leads/hubspot-map.test.ts`
- `src/services/leads/hubspot.ts` — HubSpot fetch client (`pushContacts`).
- `src/services/leads/hubspot.test.ts`
- `src/routes/leads.ts` — the three route handlers (`leadsRoutes`).
- `test/fixtures/leads/maps-card.html` — fixture for the card parser.
- `test/fixtures/leads/contact-page.html` — fixture for the enrich extractor.

**Modify:**
- `src/config.ts` — add `hubspotToken`, `leadsScrapeTimeoutMs`, `leadsEnrichTimeoutMs`, `leadsMaxResults`.
- `src/server.ts` — register `leadsRoutes`, add the `leads` OpenAPI tag.
- `.env.example` — document the new env vars.

---

## Task 1: Shared types, config, and Maps parse helpers

**Files:**
- Create: `src/services/leads/types.ts`
- Create: `src/services/leads/maps-parse.ts`
- Create: `src/services/leads/maps-parse.test.ts`
- Modify: `src/config.ts` (add 4 keys to schema + loader mapping)
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `Lead` interface (see code below) — used by every later task.
  - `MapsBlockedError`, `HubspotNotConfiguredError` classes.
  - `composeQuery(opts: { query?: string; industry?: string; location?: string }): string`
  - `extractPhone(text: string): string`
  - `extractAddress(text: string): string`
  - `pickWebsite(hrefs: string[]): string`
  - `extractRating(ariaLabel: string): { rating: number; reviewCount: number }`
  - Config keys: `config.hubspotToken?: string`, `config.leadsScrapeTimeoutMs: number`, `config.leadsEnrichTimeoutMs: number`, `config.leadsMaxResults: number`.

- [ ] **Step 1: Write `src/services/leads/types.ts`**

```ts
/** A lead flows through scrape -> enrich -> hubspot, each stage adding fields. */
export interface Lead {
  // From /scrape
  title: string;
  rating?: number;
  reviewCount?: number;
  phone?: string;
  category?: string;
  address?: string;
  website?: string;
  googleMapsLink?: string;
  // Added by /enrich
  email?: string;
  emailConfidence?: 'scraped' | 'guessed';
  description?: string;
  linkedin?: string;
  facebook?: string;
  instagram?: string;
  // Added by /hubspot
  hubspotId?: string;
}

/** Google redirected to /sorry/ or a sign-in wall — IP likely blocked. */
export class MapsBlockedError extends Error {
  constructor(public url: string) {
    super(`Google blocked the request (url: ${url}). Configure a residential proxy.`);
    this.name = 'MapsBlockedError';
  }
}

/** No HubSpot token in the request body or HUBSPOT_TOKEN env. */
export class HubspotNotConfiguredError extends Error {
  constructor() {
    super('No HubSpot token provided (set request `token` or HUBSPOT_TOKEN env).');
    this.name = 'HubspotNotConfiguredError';
  }
}

/** Compose the Maps search text. Raw `query` wins; else "<industry> <location>". */
export function composeQuery(opts: {
  query?: string;
  industry?: string;
  location?: string;
}): string {
  if (opts.query && opts.query.trim()) return opts.query.trim();
  const parts = [opts.industry?.trim(), opts.location?.trim()].filter(Boolean);
  return parts.join(' ');
}
```

- [ ] **Step 2: Write the failing test `src/services/leads/maps-parse.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { composeQuery } from './types.js';
import {
  extractPhone,
  extractAddress,
  pickWebsite,
  extractRating,
} from './maps-parse.js';

describe('composeQuery', () => {
  it('prefers a raw query', () => {
    expect(composeQuery({ query: 'plumbers nyc', industry: 'x', location: 'y' })).toBe('plumbers nyc');
  });
  it('composes industry + location', () => {
    expect(composeQuery({ industry: 'immigration lawyer', location: 'New York' })).toBe(
      'immigration lawyer New York',
    );
  });
  it('handles industry only', () => {
    expect(composeQuery({ industry: 'dentist' })).toBe('dentist');
  });
});

describe('extractPhone', () => {
  it('pulls a US phone from card text', () => {
    expect(extractPhone('Open now · (212) 555-0188 · 5 Main St')).toBe('(212) 555-0188');
  });
  it('returns empty when absent', () => {
    expect(extractPhone('Open now · 5 Main St')).toBe('');
  });
});

describe('extractAddress', () => {
  it('pulls a street address and strips status words', () => {
    expect(extractAddress('Law firm5 Main StreetOpen')).toContain('5 Main Street');
  });
});

describe('pickWebsite', () => {
  it('returns the first external non-Google link', () => {
    expect(
      pickWebsite([
        'https://www.google.com/maps/place/x',
        'https://lh3.googleusercontent.com/p',
        'https://acmelaw.com',
      ]),
    ).toBe('https://acmelaw.com');
  });
  it('returns empty when only google links', () => {
    expect(pickWebsite(['https://www.google.com/maps/place/x'])).toBe('');
  });
});

describe('extractRating', () => {
  it('parses stars + review count', () => {
    expect(extractRating('4.8 stars 312 Reviews')).toEqual({ rating: 4.8, reviewCount: 312 });
  });
  it('returns zeros when not a rating', () => {
    expect(extractRating('Photo of business')).toEqual({ rating: 0, reviewCount: 0 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- maps-parse`
Expected: FAIL — cannot resolve `./maps-parse.js` (module not yet created).

- [ ] **Step 4: Write `src/services/leads/maps-parse.ts`**

```ts
/** Pure helpers for parsing a single Google Maps result card. */

const PHONE_RE = /(\+\d{1,2}\s)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/;

export function extractPhone(text: string): string {
  const m = text.match(PHONE_RE);
  return m ? m[0].trim() : '';
}

const ADDR_RE = /\d+\s[\w\s]+(?:#\s*\d+|Suite\s*\d+|Apt\s*\d+)?/;

export function extractAddress(text: string): string {
  const m = text.match(ADDR_RE);
  if (!m) return '';
  let addr = m[0].trim();
  addr = addr.replace(/\b(?:Closed|Open\s24\shours|24\shours|Open)\b/g, '');
  addr = addr.replace(/(\w)(Open|Closed)/g, '$1');
  return addr.trim();
}

// Hosts that appear on a Maps card but are never the firm's own site.
const NON_WEBSITE_HOSTS = [
  'google.com',
  'google.',
  'gstatic.com',
  'ggpht.com',
  'googleusercontent.com',
  'schema.org',
  'youtube.com',
];

export function pickWebsite(hrefs: string[]): string {
  for (const href of hrefs) {
    if (!/^https?:\/\//i.test(href)) continue;
    const lowered = href.toLowerCase();
    if (NON_WEBSITE_HOSTS.some((host) => lowered.includes(host))) continue;
    return href;
  }
  return '';
}

export function extractRating(ariaLabel: string): { rating: number; reviewCount: number } {
  if (!/stars/i.test(ariaLabel)) return { rating: 0, reviewCount: 0 };
  const parts = ariaLabel.trim().split(/\s+/);
  const rating = Number.parseFloat(parts[0] ?? '');
  let reviewCount = 0;
  if (parts.length >= 3) {
    reviewCount = Number.parseInt((parts[2] ?? '').replace(/,/g, ''), 10) || 0;
  }
  return { rating: Number.isFinite(rating) ? rating : 0, reviewCount };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- maps-parse`
Expected: PASS (all cases green).

- [ ] **Step 6: Add config keys to `src/config.ts`**

In the `ConfigSchema` object (after the `companyTimeoutMs` line near the end of the schema), add:

```ts
  hubspotToken: z.string().optional(),
  leadsScrapeTimeoutMs: z.coerce.number().int().positive().default(120_000),
  leadsEnrichTimeoutMs: z.coerce.number().int().positive().default(15_000),
  leadsMaxResults: z.coerce.number().int().positive().default(120),
```

In the `loadConfig()` parse object (after the `companyTimeoutMs: process.env.COMPANY_TIMEOUT_MS,` line), add:

```ts
    hubspotToken: process.env.HUBSPOT_TOKEN,
    leadsScrapeTimeoutMs: process.env.LEADS_SCRAPE_TIMEOUT_MS,
    leadsEnrichTimeoutMs: process.env.LEADS_ENRICH_TIMEOUT_MS,
    leadsMaxResults: process.env.LEADS_MAX_RESULTS,
```

- [ ] **Step 7: Document env vars in `.env.example`**

Append a new section at the end of `.env.example`:

```bash
# --- Leads pipeline (/v1/leads/*) ---
# Optional fallback HubSpot private-app token used by POST /v1/leads/hubspot
# when the request body omits `token`. Needs crm.objects.contacts read+write
# (and crm.schemas.contacts.write to auto-create the type_contact enum).
HUBSPOT_TOKEN=
# Overall wall-clock budget for a single Maps scrape (ms).
LEADS_SCRAPE_TIMEOUT_MS=120000
# Per-lead website enrichment budget (ms).
LEADS_ENRICH_TIMEOUT_MS=15000
# Hard cap on the scrape `max` field.
LEADS_MAX_RESULTS=120
```

- [ ] **Step 8: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/services/leads/types.ts src/services/leads/maps-parse.ts \
  src/services/leads/maps-parse.test.ts src/config.ts .env.example
git commit -m "feat(leads): add Lead types, config, and Maps parse helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Maps scrape orchestrator + route

**Files:**
- Create: `src/services/leads/maps.ts`
- Create: `src/routes/leads.ts` (scrape handler only; enrich/hubspot added in later tasks)
- Modify: `src/server.ts` (register route + add `leads` tag)

**Interfaces:**
- Consumes: `Lead`, `MapsBlockedError`, `composeQuery` from `./types.js`; `extractPhone`, `extractAddress`, `pickWebsite`, `extractRating` from `./maps-parse.js`; `BrowserPool` from `../../browser.js`; `deriveProxy` from `../../proxy.js`; `Config` from `../../config.js`.
- Produces:
  - `scrapeGoogleMaps(args: ScrapeArgs): Promise<{ leads: Lead[]; warnings: string[] }>` where
    `ScrapeArgs = { browser: BrowserPool; query: string; max: number; proxyUrl?: string; proxyBypass?: string; timeoutMs: number }`.
  - `leadsRoutes(deps: { browser: BrowserPool; config: Config }): FastifyPluginAsync` exposing `POST /v1/leads/scrape`.

- [ ] **Step 1: Write `src/services/leads/maps.ts`**

```ts
import { chromium, type BrowserContext } from 'playwright';
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
  const page = await context.newPage();
  const url = `https://www.google.com/maps/search/${encodeURIComponent(args.query)}`;

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
      title: (titleEl?.textContent ?? '').trim() || (node.getAttribute('aria-label') ?? '').split(',')[0].trim(),
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
```

- [ ] **Step 2: Write `src/routes/leads.ts` (scrape handler)**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { composeQuery, MapsBlockedError } from '../services/leads/types.js';
import { scrapeGoogleMaps } from '../services/leads/maps.js';

interface LeadsDeps {
  browser: BrowserPool;
  config: Config;
}

const ScrapeBody = z
  .object({
    query: z.string().min(2).max(200).optional(),
    industry: z.string().min(2).max(120).optional(),
    location: z.string().min(2).max(120).optional(),
    max: z.number().int().min(1).default(20),
    proxyUrl: z.string().url().optional(),
    proxyBypass: z.string().optional(),
  })
  .refine((b) => Boolean(b.query) || Boolean(b.industry), {
    message: 'Provide `query` or `industry` (with optional `location`).',
  });

export const leadsRoutes =
  (deps: LeadsDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/leads/scrape',
      {
        schema: {
          description:
            'Scrape Google Maps for businesses. Provide `query` (raw) or `industry` (+ optional `location`). Optional `proxyUrl` routes this scrape through a per-request proxy (falls back to the global PROXY_URL). Synchronous and long-running; bounded by `max` and LEADS_SCRAPE_TIMEOUT_MS.',
          tags: ['leads'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 2, maxLength: 200 },
              industry: { type: 'string', minLength: 2, maxLength: 120 },
              location: { type: 'string', minLength: 2, maxLength: 120 },
              max: { type: 'integer', minimum: 1, default: 20 },
              proxyUrl: { type: 'string', format: 'uri' },
              proxyBypass: { type: 'string' },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = ScrapeBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const query = composeQuery(body);
        const max = Math.min(body.max, deps.config.leadsMaxResults);

        try {
          const { leads, warnings } = await scrapeGoogleMaps({
            browser: deps.browser,
            query,
            max,
            proxyUrl: body.proxyUrl,
            proxyBypass: body.proxyBypass,
            timeoutMs: deps.config.leadsScrapeTimeoutMs,
          });
          return {
            query,
            count: leads.length,
            leads,
            warnings,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          if (err instanceof MapsBlockedError) {
            return reply.code(502).send({ error: 'maps_blocked', message: err.message });
          }
          req.log.warn({ err }, 'leads scrape failed');
          return reply.code(502).send({
            error: 'scrape_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
```

- [ ] **Step 3: Register the route in `src/server.ts`**

Add the import alongside the other route imports:

```ts
import { leadsRoutes } from './routes/leads.js';
```

Add the `leads` tag to the `tags` array in the swagger `openapi` config (after the `company` tag):

```ts
        { name: 'leads', description: 'Lead-gen pipeline: Maps scrape, enrich, HubSpot push' },
```

Register the route after `companyRoutes` (note it needs `browser`):

```ts
  await app.register(leadsRoutes({ browser, config }));
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Manual smoke test (no network assertion)**

Run: `npm run build && API_KEYS=test123456 node dist/server.js &` then
`curl -s -XPOST localhost:8080/v1/leads/scrape -H 'authorization: Bearer test123456' -H 'content-type: application/json' -d '{}'`
Expected: HTTP body `{"error":"bad_request",...}` (validation rejects empty body — proves the route is wired without needing live Google). Kill the server afterward.

- [ ] **Step 6: Commit**

```bash
git add src/services/leads/maps.ts src/routes/leads.ts src/server.ts
git commit -m "feat(leads): add Google Maps scrape endpoint with per-request proxy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Enrichment extract helpers

**Files:**
- Create: `src/services/leads/enrich-extract.ts`
- Create: `src/services/leads/enrich-extract.test.ts`
- Create: `test/fixtures/leads/contact-page.html`

**Interfaces:**
- Consumes: `cheerio` (already a dependency).
- Produces:
  - `extractEmails(html: string): string[]`
  - `extractPhones(html: string): string[]`
  - `extractSocialLinks(html: string): { linkedin?: string; facebook?: string; instagram?: string }`
  - `bestEmail(emails: string[], domain: string): string`
  - `candidateUrls(base: string, homepageHtml: string, maxPages: number): string[]`
  - `extractMeta(html: string): { name?: string; description?: string }`

- [ ] **Step 1: Create the fixture `test/fixtures/leads/contact-page.html`**

```html
<!doctype html>
<html>
  <head>
    <title>Acme Law — Immigration Attorneys</title>
    <meta name="description" content="Immigration lawyers in New York." />
    <meta property="og:site_name" content="Acme Law" />
  </head>
  <body>
    <a href="mailto:info@acmelaw.com">Email us</a>
    <p>Call (212) 555-0188 or reach partners@acmelaw.com</p>
    <a href="https://www.linkedin.com/company/acme-law">LinkedIn</a>
    <a href="https://www.facebook.com/acmelaw">Facebook</a>
    <a href="/contact">Contact</a>
    <a href="/about-us">About</a>
    <a href="https://twitter.com/acmelaw">Twitter</a>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test `src/services/leads/enrich-extract.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractEmails,
  extractPhones,
  extractSocialLinks,
  bestEmail,
  candidateUrls,
  extractMeta,
} from './enrich-extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(
  resolve(here, '../../../test/fixtures/leads/contact-page.html'),
  'utf8',
);

describe('extractEmails', () => {
  it('finds mailto and inline emails, deduped', () => {
    const emails = extractEmails(html);
    expect(emails).toContain('info@acmelaw.com');
    expect(emails).toContain('partners@acmelaw.com');
    expect(new Set(emails).size).toBe(emails.length);
  });
});

describe('extractPhones', () => {
  it('finds a phone number', () => {
    expect(extractPhones(html)).toContain('(212) 555-0188');
  });
});

describe('extractSocialLinks', () => {
  it('captures linkedin/facebook, ignores twitter', () => {
    const s = extractSocialLinks(html);
    expect(s.linkedin).toBe('https://www.linkedin.com/company/acme-law');
    expect(s.facebook).toBe('https://www.facebook.com/acmelaw');
    expect(s.instagram).toBeUndefined();
  });
});

describe('bestEmail', () => {
  it('prefers an on-domain email over a generic one', () => {
    expect(bestEmail(['x@gmail.com', 'info@acmelaw.com'], 'acmelaw.com')).toBe('info@acmelaw.com');
  });
  it('returns first when none match domain', () => {
    expect(bestEmail(['a@x.com', 'b@y.com'], 'acmelaw.com')).toBe('a@x.com');
  });
  it('returns empty for no emails', () => {
    expect(bestEmail([], 'acmelaw.com')).toBe('');
  });
});

describe('candidateUrls', () => {
  it('prioritizes contact/about pages discovered on the homepage', () => {
    const urls = candidateUrls('https://acmelaw.com', html, 5);
    expect(urls[0]).toBe('https://acmelaw.com');
    expect(urls).toContain('https://acmelaw.com/contact');
    expect(urls).toContain('https://acmelaw.com/about-us');
    expect(urls.length).toBeLessThanOrEqual(5);
  });
});

describe('extractMeta', () => {
  it('reads og:site_name and description', () => {
    const meta = extractMeta(html);
    expect(meta.name).toBe('Acme Law');
    expect(meta.description).toBe('Immigration lawyers in New York.');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- enrich-extract`
Expected: FAIL — cannot resolve `./enrich-extract.js`.

- [ ] **Step 4: Write `src/services/leads/enrich-extract.ts`**

```ts
import * as cheerio from 'cheerio';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+\d{1,2}\s)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;

// Image/asset emails that are never real contacts.
const EMAIL_JUNK = /\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i;

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const $ = cheerio.load(html);
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = ($(el).attr('href') ?? '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (addr) found.add(addr.toLowerCase());
  });
  for (const m of html.matchAll(EMAIL_RE)) {
    const addr = m[0].toLowerCase();
    if (!EMAIL_JUNK.test(addr)) found.add(addr);
  }
  return [...found];
}

export function extractPhones(html: string): string[] {
  const text = cheerio.load(html).text();
  const found = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) found.add(m[0].trim());
  return [...found];
}

const SOCIAL_HOSTS: Array<[keyof SocialLinks, RegExp]> = [
  ['linkedin', /linkedin\.com/i],
  ['facebook', /facebook\.com/i],
  ['instagram', /instagram\.com/i],
];

interface SocialLinks {
  linkedin?: string;
  facebook?: string;
  instagram?: string;
}

export function extractSocialLinks(html: string): SocialLinks {
  const $ = cheerio.load(html);
  const out: SocialLinks = {};
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    for (const [key, re] of SOCIAL_HOSTS) {
      if (!re.test(href)) continue;
      const current = out[key];
      // Upgrade a personal LinkedIn to a company page if found later.
      if (!current || (key === 'linkedin' && /\/company\//.test(href) && !/\/company\//.test(current))) {
        out[key] = href;
      }
    }
  });
  return out;
}

export function bestEmail(emails: string[], domain: string): string {
  if (emails.length === 0) return '';
  const root = domain.replace(/^www\./i, '').toLowerCase();
  const onDomain = emails.find((e) => e.toLowerCase().endsWith(`@${root}`));
  return onDomain ?? emails[0];
}

const PRIORITY_PATHS = ['contact', 'contact-us', 'about', 'about-us', 'team'];

export function candidateUrls(base: string, homepageHtml: string, maxPages: number): string[] {
  const urls: string[] = [base];
  const seen = new Set([base]);
  const $ = cheerio.load(homepageHtml);
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
    let abs: string;
    try {
      abs = new URL(href, base).toString().replace(/#.*$/, '');
    } catch {
      return;
    }
    if (new URL(abs).host !== new URL(base).host) return;
    links.push(abs);
  });
  // Prioritize contact/about-style pages.
  const ranked = [...links].sort((a, b) => pathRank(a) - pathRank(b));
  for (const u of ranked) {
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
    if (urls.length >= maxPages) break;
  }
  return urls.slice(0, maxPages);
}

function pathRank(url: string): number {
  const path = url.toLowerCase();
  const i = PRIORITY_PATHS.findIndex((p) => path.includes(p));
  return i === -1 ? PRIORITY_PATHS.length : i;
}

export function extractMeta(html: string): { name?: string; description?: string } {
  const $ = cheerio.load(html);
  const name =
    $('meta[property="og:site_name"]').attr('content')?.trim() || $('title').text().trim() || undefined;
  const description = $('meta[name="description"]').attr('content')?.trim() || undefined;
  return { name, description };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- enrich-extract`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/leads/enrich-extract.ts src/services/leads/enrich-extract.test.ts \
  test/fixtures/leads/contact-page.html
git commit -m "feat(leads): add website enrichment extract helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Enrichment orchestrator + route

**Files:**
- Create: `src/services/leads/enrich.ts`
- Create: `src/services/leads/enrich.test.ts`
- Modify: `src/routes/leads.ts` (add `/v1/leads/enrich`)

**Interfaces:**
- Consumes: `Lead` from `./types.js`; all helpers from `./enrich-extract.js`; `BrowserPool` from `../../browser.js`; Node `node:dns/promises`.
- Produces:
  - `guessEmail(domain: string, opts: { verifyMx: boolean; resolveMx?: typeof import('node:dns/promises').resolveMx }): Promise<string>`
  - `enrichLeads(args: EnrichArgs): Promise<{ leads: Lead[]; warnings: string[] }>` where
    `EnrichArgs = { browser: BrowserPool; leads: Lead[]; guessEmails: boolean; verifyMx: boolean; headlessFallback: boolean; concurrency: number; timeoutMs: number }`.

- [ ] **Step 1: Write the failing test `src/services/leads/enrich.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { guessEmail } from './enrich.js';

describe('guessEmail', () => {
  it('returns a role email when MX verification passes', async () => {
    const resolveMx = vi.fn().mockResolvedValue([{ exchange: 'mx.acmelaw.com', priority: 10 }]);
    const email = await guessEmail('acmelaw.com', { verifyMx: true, resolveMx });
    expect(email).toBe('info@acmelaw.com');
    expect(resolveMx).toHaveBeenCalledWith('acmelaw.com');
  });

  it('returns empty when MX lookup fails', async () => {
    const resolveMx = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const email = await guessEmail('acmelaw.com', { verifyMx: true, resolveMx });
    expect(email).toBe('');
  });

  it('skips MX verification when disabled', async () => {
    const resolveMx = vi.fn();
    const email = await guessEmail('acmelaw.com', { verifyMx: false, resolveMx });
    expect(email).toBe('info@acmelaw.com');
    expect(resolveMx).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/leads/enrich.test.ts`
Expected: FAIL — cannot resolve `./enrich.js`.

- [ ] **Step 3: Write `src/services/leads/enrich.ts`**

```ts
import { resolveMx as nodeResolveMx } from 'node:dns/promises';
import type { BrowserPool } from '../../browser.js';
import { Lead } from './types.js';
import {
  extractEmails,
  extractPhones,
  extractSocialLinks,
  bestEmail,
  candidateUrls,
  extractMeta,
} from './enrich-extract.js';

const GUESS_PREFIXES = ['info', 'contact', 'hello', 'office'];

export async function guessEmail(
  domain: string,
  opts: { verifyMx: boolean; resolveMx?: typeof nodeResolveMx },
): Promise<string> {
  const root = domain.replace(/^www\./i, '').toLowerCase();
  if (opts.verifyMx) {
    const resolver = opts.resolveMx ?? nodeResolveMx;
    try {
      const records = await resolver(root);
      if (!records || records.length === 0) return '';
    } catch {
      return '';
    }
  }
  return `${GUESS_PREFIXES[0]}@${root}`;
}

function domainFromWebsite(website: string): string {
  try {
    return new URL(website).host.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

async function fetchStatic(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; sitesonar-leads/1.0)' },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(t);
  }
}

async function fetchHeadless(browser: BrowserPool, url: string, timeoutMs: number): Promise<string> {
  const context = await browser.acquire();
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return await page.content();
  } catch {
    return '';
  } finally {
    await browser.release(context);
  }
}

export interface EnrichArgs {
  browser: BrowserPool;
  leads: Lead[];
  guessEmails: boolean;
  verifyMx: boolean;
  headlessFallback: boolean;
  concurrency: number;
  timeoutMs: number;
}

async function enrichOne(lead: Lead, args: EnrichArgs, warnings: string[]): Promise<Lead> {
  if (!lead.website) {
    warnings.push(`${lead.title}: no website to enrich`);
    return lead;
  }
  const domain = domainFromWebsite(lead.website);
  if (!domain) {
    warnings.push(`${lead.title}: unparseable website ${lead.website}`);
    return lead;
  }
  const deadline = Date.now() + args.timeoutMs;
  const base = `https://${domain}`;
  const out: Lead = { ...lead };
  const emails: string[] = [];

  const homepage = await fetchStatic(base, 10_000);
  const urls = candidateUrls(base, homepage, 5);
  const htmls: Record<string, string> = homepage ? { [base]: homepage } : {};

  for (const url of urls) {
    if (Date.now() > deadline) break;
    const html = htmls[url] ?? (await fetchStatic(url, 10_000));
    if (!html) continue;
    applyMeta(out, html);
    applySocials(out, html);
    emails.push(...extractEmails(html));
    if (!out.phone) {
      const phones = extractPhones(html);
      if (phones.length) out.phone = phones[0];
    }
    if (emails.length) break;
  }

  if (emails.length === 0 && args.headlessFallback) {
    for (const url of urls.slice(0, 2)) {
      if (Date.now() > deadline) break;
      const html = await fetchHeadless(args.browser, url, 12_000);
      if (!html) continue;
      applyMeta(out, html);
      applySocials(out, html);
      emails.push(...extractEmails(html));
      if (emails.length) break;
    }
  }

  if (emails.length) {
    out.email = bestEmail(emails, domain);
    out.emailConfidence = 'scraped';
  } else if (args.guessEmails && Date.now() < deadline) {
    const { guessEmail } = await import('./enrich.js');
    const guessed = await guessEmail(domain, { verifyMx: args.verifyMx });
    if (guessed) {
      out.email = guessed;
      out.emailConfidence = 'guessed';
    } else {
      warnings.push(`${domain}: no email found`);
    }
  } else {
    warnings.push(`${domain}: no email found`);
  }
  return out;
}

function applyMeta(lead: Lead, html: string): void {
  const meta = extractMeta(html);
  if (!lead.description && meta.description) lead.description = meta.description;
}

function applySocials(lead: Lead, html: string): void {
  const s = extractSocialLinks(html);
  if (!lead.linkedin && s.linkedin) lead.linkedin = s.linkedin;
  if (!lead.facebook && s.facebook) lead.facebook = s.facebook;
  if (!lead.instagram && s.instagram) lead.instagram = s.instagram;
}

export async function enrichLeads(
  args: EnrichArgs,
): Promise<{ leads: Lead[]; warnings: string[] }> {
  const warnings: string[] = [];
  const out: Lead[] = new Array(args.leads.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < args.leads.length) {
      const i = cursor++;
      out[i] = await enrichOne(args.leads[i]!, args, warnings);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(args.concurrency, args.leads.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return { leads: out, warnings };
}
```

Note: the dynamic `import('./enrich.js')` in `enrichOne` is only to keep `guessEmail` mockable; if your bundler/test setup resolves the static call fine, replace it with a direct `guessEmail(domain, { verifyMx: args.verifyMx })` call (the static import is already at the top of the file). Prefer the direct call.

- [ ] **Step 4: Simplify to a direct call**

Replace the dynamic-import block in `enrichOne` with:

```ts
  } else if (args.guessEmails && Date.now() < deadline) {
    const guessed = await guessEmail(domain, { verifyMx: args.verifyMx });
    if (guessed) {
      out.email = guessed;
      out.emailConfidence = 'guessed';
    } else {
      warnings.push(`${domain}: no email found`);
    }
  } else {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/services/leads/enrich.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the enrich route to `src/routes/leads.ts`**

Add these imports at the top:

```ts
import { enrichLeads } from '../services/leads/enrich.js';
```

Define a `LeadSchema` and `EnrichBody` near `ScrapeBody`:

```ts
const LeadSchema = z
  .object({
    title: z.string(),
    rating: z.number().optional(),
    reviewCount: z.number().optional(),
    phone: z.string().optional(),
    category: z.string().optional(),
    address: z.string().optional(),
    website: z.string().optional(),
    googleMapsLink: z.string().optional(),
    email: z.string().optional(),
    emailConfidence: z.enum(['scraped', 'guessed']).optional(),
    description: z.string().optional(),
    linkedin: z.string().optional(),
    facebook: z.string().optional(),
    instagram: z.string().optional(),
    hubspotId: z.string().optional(),
  })
  .passthrough();

const EnrichBody = z.object({
  leads: z.array(LeadSchema).min(1).max(500),
  guessEmails: z.boolean().default(true),
  verifyMx: z.boolean().default(true),
  headlessFallback: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(10).default(3),
});
```

Inside `leadsRoutes`, after the scrape handler, add:

```ts
    app.post(
      '/v1/leads/enrich',
      {
        schema: {
          description:
            'Enrich leads by crawling each business website for emails, phone, social profiles, and description. Accepts the `leads[]` array returned by /v1/leads/scrape. Falls back to a role-based email guess (MX-verified) when no email is scraped.',
          tags: ['leads'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['leads'],
            properties: {
              leads: { type: 'array', items: { type: 'object' } },
              guessEmails: { type: 'boolean', default: true },
              verifyMx: { type: 'boolean', default: true },
              headlessFallback: { type: 'boolean', default: true },
              concurrency: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = EnrichBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const { leads, warnings } = await enrichLeads({
          browser: deps.browser,
          leads: body.leads,
          guessEmails: body.guessEmails,
          verifyMx: body.verifyMx,
          headlessFallback: body.headlessFallback,
          concurrency: body.concurrency,
          timeoutMs: deps.config.leadsEnrichTimeoutMs,
        });
        return {
          count: leads.length,
          leads,
          warnings,
          enrichedAt: new Date().toISOString(),
        };
      },
    );
```

- [ ] **Step 7: Verify typecheck + tests pass**

Run: `npm run typecheck && npm test -- leads`
Expected: no type errors; all leads tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/leads/enrich.ts src/services/leads/enrich.test.ts src/routes/leads.ts
git commit -m "feat(leads): add website-crawl enrichment endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: HubSpot mapping helpers

**Files:**
- Create: `src/services/leads/hubspot-map.ts`
- Create: `src/services/leads/hubspot-map.test.ts`

**Interfaces:**
- Consumes: `Lead` from `./types.js`.
- Produces:
  - `industryToTag(industry: string): { value: string; label: string }`
  - `firstLastFromTitle(title: string): { firstname: string; lastname: string }`
  - `mapContactProperties(lead: Lead, opts: { industry?: string; existingProps: Set<string>; typeContactValue?: string }): Record<string, string>`

- [ ] **Step 1: Write the failing test `src/services/leads/hubspot-map.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { industryToTag, mapContactProperties } from './hubspot-map.js';
import type { Lead } from './types.js';

describe('industryToTag', () => {
  it('slugifies a multi-word industry', () => {
    expect(industryToTag('immigration lawyer')).toEqual({
      value: 'Immigration_Lawyer',
      label: 'Immigration Lawyer',
    });
  });
  it('handles a single word', () => {
    expect(industryToTag('dentist')).toEqual({ value: 'Dentist', label: 'Dentist' });
  });
});

describe('mapContactProperties', () => {
  const lead: Lead = {
    title: 'Acme Law',
    email: 'info@acmelaw.com',
    phone: '(212) 555-0188',
    website: 'https://acmelaw.com',
    address: '5 Main St',
    linkedin: 'https://linkedin.com/company/acme',
    googleMapsLink: 'https://maps.google.com/?cid=1',
  };

  it('maps standard fields and drops empties', () => {
    const props = mapContactProperties(lead, { existingProps: new Set() });
    expect(props.email).toBe('info@acmelaw.com');
    expect(props.company).toBe('Acme Law');
    expect(props.website).toBe('https://acmelaw.com');
    // No custom props sent when the account has none.
    expect(props.source).toBeUndefined();
    expect(props.linkedin_url).toBeUndefined();
  });

  it('includes custom props only when they exist in the account', () => {
    const existingProps = new Set(['source', 'statut_outbound', 'linkedin_url', 'google_maps_link', 'type_contact']);
    const props = mapContactProperties(lead, {
      industry: 'immigration lawyer',
      existingProps,
      typeContactValue: 'Immigration_Lawyer',
    });
    expect(props.source).toBe('Google_Maps');
    expect(props.statut_outbound).toBe('To_Contact');
    expect(props.linkedin_url).toBe('https://linkedin.com/company/acme');
    expect(props.google_maps_link).toBe('https://maps.google.com/?cid=1');
    expect(props.type_contact).toBe('Immigration_Lawyer');
  });

  it('omits type_contact when typeContactValue is not provided', () => {
    const existingProps = new Set(['type_contact']);
    const props = mapContactProperties(lead, { industry: 'x', existingProps });
    expect(props.type_contact).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hubspot-map`
Expected: FAIL — cannot resolve `./hubspot-map.js`.

- [ ] **Step 3: Write `src/services/leads/hubspot-map.ts`**

```ts
import type { Lead } from './types.js';

export function industryToTag(industry: string): { value: string; label: string } {
  const words = (industry || '').trim().split(/\s+/).filter(Boolean);
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return {
    value: words.map(cap).join('_'),
    label: words.map(cap).join(' '),
  };
}

export function firstLastFromTitle(title: string): { firstname: string; lastname: string } {
  // Maps results are businesses, not people: use the business name as firstname,
  // matching MapLeads (firstname = title/company fallback, lastname empty).
  return { firstname: title.trim(), lastname: '' };
}

export function mapContactProperties(
  lead: Lead,
  opts: { industry?: string; existingProps: Set<string>; typeContactValue?: string },
): Record<string, string> {
  const { firstname, lastname } = firstLastFromTitle(lead.title);
  const props: Record<string, string> = {
    firstname: firstname || lead.title || 'Business',
    lastname,
    email: lead.email ?? '',
    phone: lead.phone ?? '',
    website: lead.website ?? '',
    company: lead.title ?? '',
    address: lead.address ?? '',
  };

  const has = (p: string): boolean => opts.existingProps.has(p);

  if (has('source')) props.source = 'Google_Maps';
  if (has('statut_outbound')) props.statut_outbound = 'To_Contact';
  if (has('google_maps_link') && lead.googleMapsLink) props.google_maps_link = lead.googleMapsLink;
  if (has('linkedin_url') && lead.linkedin) props.linkedin_url = lead.linkedin;
  if (has('facebook_url') && lead.facebook) props.facebook_url = lead.facebook;
  if (has('instagram_url') && lead.instagram) props.instagram_url = lead.instagram;
  if (has('type_contact') && opts.typeContactValue) props.type_contact = opts.typeContactValue;

  // Drop empty values — HubSpot rejects some empty standard fields.
  for (const k of Object.keys(props)) {
    if (!props[k]) delete props[k];
  }
  return props;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- hubspot-map`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/leads/hubspot-map.ts src/services/leads/hubspot-map.test.ts
git commit -m "feat(leads): add HubSpot contact-property mapping helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: HubSpot push client + route

**Files:**
- Create: `src/services/leads/hubspot.ts`
- Create: `src/services/leads/hubspot.test.ts`
- Modify: `src/routes/leads.ts` (add `/v1/leads/hubspot`)

**Interfaces:**
- Consumes: `Lead`, `HubspotNotConfiguredError` from `./types.js`; `industryToTag`, `mapContactProperties` from `./hubspot-map.js`.
- Produces:
  - `pushContacts(args: PushArgs): Promise<PushResult>` where
    `PushArgs = { token: string; leads: Lead[]; industry?: string; dryRun: boolean; fetchImpl?: typeof fetch }` and
    `PushResult = { created: number; skipped: number; failed: number; results: Array<{ title: string; status: 'created' | 'exists' | 'failed'; hubspotId?: string; error?: string }> }`.

- [ ] **Step 1: Write the failing test `src/services/leads/hubspot.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { pushContacts } from './hubspot.js';
import type { Lead } from './types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const lead: Lead = { title: 'Acme Law', email: 'info@acmelaw.com', phone: '(212) 555-0188' };

describe('pushContacts', () => {
  it('creates a new contact when none exists', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      if (u.includes('/objects/contacts')) return jsonResponse({ id: '999' }, 201);
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: false, fetchImpl });
    expect(result.created).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'created', hubspotId: '999' });
  });

  it('skips a contact that already exists (dedup by email)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [{ id: '111' }] });
      return jsonResponse({}, 500); // create must NOT be called
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: false, fetchImpl });
    expect(result.skipped).toBe(1);
    expect(result.results[0]).toMatchObject({ status: 'exists', hubspotId: '111' });
  });

  it('dryRun does not call the create endpoint', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/properties/contacts')) return jsonResponse({ results: [] });
      if (u.includes('/contacts/search')) return jsonResponse({ results: [] });
      return jsonResponse({}, 500);
    }) as unknown as typeof fetch;

    const result = await pushContacts({ token: 'pat-x', leads: [lead], dryRun: true, fetchImpl });
    expect(result.created).toBe(1); // reported as would-create
    expect(calls.some((c) => c.includes('/objects/contacts') && !c.includes('search'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/leads/hubspot.test.ts`
Expected: FAIL — cannot resolve `./hubspot.js`.

- [ ] **Step 3: Write `src/services/leads/hubspot.ts`**

```ts
import { Lead } from './types.js';
import { industryToTag, mapContactProperties } from './hubspot-map.js';

const API = 'https://api.hubapi.com';
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 1_500;

export interface PushArgs {
  token: string;
  leads: Lead[];
  industry?: string;
  dryRun: boolean;
  fetchImpl?: typeof fetch;
}

export interface PushResult {
  created: number;
  skipped: number;
  failed: number;
  results: Array<{
    title: string;
    status: 'created' | 'exists' | 'failed';
    hubspotId?: string;
    error?: string;
  }>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function listProperties(token: string, f: typeof fetch): Promise<Set<string>> {
  try {
    const res = await f(`${API}/crm/v3/properties/contacts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return new Set();
    const data = (await res.json()) as { results?: Array<{ name: string }> };
    return new Set((data.results ?? []).map((p) => p.name));
  } catch {
    return new Set();
  }
}

async function searchOne(
  token: string,
  property: string,
  value: string,
  f: typeof fetch,
): Promise<string | null> {
  if (!value) return null;
  try {
    const res = await f(`${API}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value }] }],
        limit: 1,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ id: string }> };
    return data.results?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function findExisting(token: string, lead: Lead, f: typeof fetch): Promise<string | null> {
  const byEmail = lead.email ? await searchOne(token, 'email', lead.email, f) : null;
  if (byEmail) return byEmail;
  return lead.phone ? await searchOne(token, 'phone', lead.phone, f) : null;
}

async function createContact(
  token: string,
  properties: Record<string, string>,
  f: typeof fetch,
): Promise<{ id: string } | { error: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await f(`${API}/crm/v3/objects/contacts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ properties }),
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) {
      const data = (await res.json()) as { id: string };
      return { id: data.id };
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(RETRY_BACKOFF_MS * attempt);
      continue;
    }
    const text = await res.text();
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  return { error: 'exhausted retries' };
}

export async function pushContacts(args: PushArgs): Promise<PushResult> {
  const f = args.fetchImpl ?? fetch;
  const existingProps = await listProperties(args.token, f);
  const typeContact =
    args.industry && existingProps.has('type_contact')
      ? industryToTag(args.industry).value
      : undefined;

  const result: PushResult = { created: 0, skipped: 0, failed: 0, results: [] };

  for (const lead of args.leads) {
    const existingId = await findExisting(args.token, lead, f);
    if (existingId) {
      result.skipped += 1;
      result.results.push({ title: lead.title, status: 'exists', hubspotId: existingId });
      continue;
    }

    const properties = mapContactProperties(lead, {
      industry: args.industry,
      existingProps,
      typeContactValue: typeContact,
    });

    if (args.dryRun) {
      result.created += 1;
      result.results.push({ title: lead.title, status: 'created' });
      continue;
    }

    const created = await createContact(args.token, properties, f);
    if ('id' in created) {
      result.created += 1;
      result.results.push({ title: lead.title, status: 'created', hubspotId: created.id });
    } else {
      result.failed += 1;
      result.results.push({ title: lead.title, status: 'failed', error: created.error });
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/services/leads/hubspot.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the hubspot route to `src/routes/leads.ts`**

Add imports at the top:

```ts
import { pushContacts } from '../services/leads/hubspot.js';
import { HubspotNotConfiguredError } from '../services/leads/types.js';
```

(`MapsBlockedError` import already present; extend the existing `types.js` import line rather than duplicating it.)

Add a `HubspotBody` schema near the others:

```ts
const HubspotBody = z.object({
  leads: z.array(LeadSchema).min(1).max(500),
  token: z.string().min(10).optional(),
  industry: z.string().min(2).max(120).optional(),
  dryRun: z.boolean().default(false),
});
```

Inside `leadsRoutes`, after the enrich handler, add:

```ts
    app.post(
      '/v1/leads/hubspot',
      {
        schema: {
          description:
            'Push enriched leads into HubSpot as contacts. Dedupes by email then phone, creates only custom properties that exist in the account, and auto-creates the type_contact enum option from `industry`. Uses the request `token` or the HUBSPOT_TOKEN env. Set `dryRun=true` to preview without writing.',
          tags: ['leads'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['leads'],
            properties: {
              leads: { type: 'array', items: { type: 'object' } },
              token: { type: 'string', minLength: 10 },
              industry: { type: 'string', minLength: 2, maxLength: 120 },
              dryRun: { type: 'boolean', default: false },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = HubspotBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const token = body.token ?? deps.config.hubspotToken;
        try {
          if (!token) throw new HubspotNotConfiguredError();
          const result = await pushContacts({
            token,
            leads: body.leads,
            industry: body.industry,
            dryRun: body.dryRun,
          });
          return { ...result, pushedAt: new Date().toISOString() };
        } catch (err) {
          if (err instanceof HubspotNotConfiguredError) {
            return reply.code(503).send({ error: 'hubspot_not_configured', message: err.message });
          }
          req.log.warn({ err }, 'leads hubspot push failed');
          return reply.code(502).send({
            error: 'hubspot_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
```

- [ ] **Step 6: Verify typecheck + full test suite + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: no type errors; all tests PASS; build succeeds.

- [ ] **Step 7: Manual end-to-end smoke (validation only, no credentials)**

Run: `API_KEYS=test123456 node dist/server.js &` then
`curl -s -XPOST localhost:8080/v1/leads/hubspot -H 'authorization: Bearer test123456' -H 'content-type: application/json' -d '{"leads":[{"title":"X","email":"a@b.com"}]}'`
Expected: `{"error":"hubspot_not_configured",...}` (no token configured). Confirms the route is wired and the 503 path works. Kill the server.

- [ ] **Step 8: Commit**

```bash
git add src/services/leads/hubspot.ts src/services/leads/hubspot.test.ts src/routes/leads.ts
git commit -m "feat(leads): add HubSpot contact push endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Documentation

**Files:**
- Modify: `README.md` (add the three endpoints to the API surface section)

**Interfaces:**
- Consumes: nothing.
- Produces: documentation only.

- [ ] **Step 1: Add a Leads pipeline section to `README.md`**

Find the section listing the API endpoints (search for `/v1/company` in `README.md`) and add, in the same style as the surrounding entries:

```markdown
### Leads pipeline

A three-step lead-generation chain. Endpoints are stateless — pass each step's
`leads[]` output into the next.

- `POST /v1/leads/scrape` — scrape Google Maps. Body: `{ "industry": "immigration lawyer", "location": "New York", "max": 20, "proxyUrl": "http://user:pass@host:port" }` (or a raw `query`). `proxyUrl` is optional and falls back to the global `PROXY_URL`. Returns `{ leads: [...] }`. Long-running and synchronous.
- `POST /v1/leads/enrich` — crawl each lead's website for email, phone, socials, and description. Body: `{ "leads": [...] }`. Returns the enriched `leads[]`.
- `POST /v1/leads/hubspot` — push contacts to HubSpot (dedupe by email/phone). Body: `{ "leads": [...], "industry": "immigration lawyer", "token": "pat-...", "dryRun": false }`. `token` falls back to `HUBSPOT_TOKEN`. Returns `{ created, skipped, failed, results }`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(leads): document the leads pipeline endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes

**Spec coverage:**
- Endpoint 1 (scrape + per-request proxy + block detection) → Tasks 1–2. ✓
- Endpoint 2 (site-crawl funnel: static → headless → guess+MX) → Tasks 3–4. ✓
- Endpoint 3 (HubSpot dedup + custom props + type_contact + retries) → Tasks 5–6. ✓
- Config keys (`hubspotToken`, timeouts, max) + `.env.example` → Task 1. ✓
- Server registration + OpenAPI `leads` tag → Task 2. ✓
- Tests for parser, extractor, HubSpot mapping/dedup → Tasks 1, 3, 5, 6. ✓
- Stateless chaining (no datasets), `/v1/company` untouched, no new deps → respected throughout. ✓
- README docs → Task 7. ✓

**Type consistency:** `Lead` is defined once in Task 1 and imported everywhere. `scrapeGoogleMaps`, `enrichLeads`, `guessEmail`, `pushContacts`, `industryToTag`, `mapContactProperties` signatures in the Produces blocks match their call sites in the route handlers.

**Known fragility (documented, not a plan gap):** the Maps DOM selectors (`.qBF1Pd`, `[role="feed"]`) are Google-internal and may drift; the parse helpers are isolated and unit-tested so a selector fix is localized to `maps.ts`/`maps-parse.ts`. Live scraping is validated manually, not in CI.
