# Leads Pipeline — Design

**Date:** 2026-06-21
**Status:** Approved (design), pending implementation plan

## Goal

Add a lead-generation pipeline to sitesonar as three new HTTP endpoints, porting
the proven logic from the MapLeads project onto sitesonar's existing
TypeScript / Fastify / Playwright stack:

1. **Scrape** Google Maps for businesses.
2. **Enrich** each business by crawling its own website for emails + socials.
3. **Push** the resulting contacts to HubSpot.

The endpoints are **stateless** and **chained by the caller** (or an orchestrator
like n8n): the JSON output of one is the JSON input of the next. No server-side
dataset storage.

Because the service is hosted and Google blocks datacenter IPs hard, the scrape
endpoint must support an **optional per-request proxy** (a bought residential /
rotating proxy), with the existing global `PROXY_URL` env as fallback.

## Source material

- **MapLeads** (`/Users/isaacgounton/Desktop/DEV/Business/mapleads`, Python) — the
  blueprint. Its scraper, enricher funnel, and HubSpot client are ported.
- **google-maps-scraper** (`/Users/isaacgounton/Desktop/DEV/google-maps-scraper`,
  Go) — referenced for data-field ideas only; not integrated.
- **sitesonar** (target, TypeScript/Fastify) — already provides: route-plugin
  pattern, OpenAPI/Swagger, bearer auth, rate limiting, Redis-or-memory KV/job
  store, a Playwright `BrowserPool`, `deriveProxy()` proxy parsing, `cheerio`,
  and a separate `/v1/company` firmographics/contacts service (left untouched).

## Non-goals (YAGNI)

- MapLeads' frontend dashboard, scheduler, and outreach/email-sending.
- The Go scraper's review/coordinate/popular-times extraction.
- Server-side datasets / job IDs / a combined pipeline endpoint. (Stateless
  chaining was chosen; a combined async endpoint can be added later if needed.)
- Changes to the existing `/v1/company` endpoint.

## Architecture

New service modules under `src/services/leads/`:

- `maps.ts` — Google Maps scraper (Playwright).
- `enrich.ts` — website-crawl enrichment funnel.
- `hubspot.ts` — HubSpot contact push client.
- `types.ts` — shared `Lead` shape + error classes.

New route plugin `src/routes/leads.ts` exposing three endpoints, registered in
`src/server.ts` as `leadsRoutes({ browser, config })` under a new OpenAPI tag
`leads`. Bearer auth and rate limiting apply automatically (same as every other
`/v1` route).

### Shared `Lead` shape

A single TypeScript interface flows through all three endpoints. Each stage adds
fields; unknown fields are preserved so the caller can chain without loss.

```ts
interface Lead {
  // From scrape
  title: string;
  rating?: number;
  reviewCount?: number;
  phone?: string;
  category?: string;        // "industry" in MapLeads
  address?: string;
  website?: string;
  googleMapsLink?: string;
  // Added by enrich
  email?: string;
  emailConfidence?: 'scraped' | 'guessed';
  description?: string;
  linkedin?: string;
  facebook?: string;
  instagram?: string;
  // Added by hubspot
  hubspotId?: string;
}
```

## Endpoint 1 — `POST /v1/leads/scrape`

Ports MapLeads `src/scrapers/google_maps.py` to `src/services/leads/maps.ts`.

### Request body (zod-validated)

```jsonc
{
  "query":      "immigration lawyer New York", // optional raw query
  "industry":   "immigration lawyer",          // optional; composed with location
  "location":   "New York",                    // optional
  "max":        20,                            // default 20, hard cap 120
  "proxyUrl":   "http://user:pass@host:port",  // optional per-request proxy
  "proxyBypass":"localhost"                     // optional
}
```

Validation: require exactly one of `query` **or** `industry` (location optional).
If `industry` is given, the search text is `"<industry> <location>"` (MapLeads
behavior).

### Proxy handling

- If `proxyUrl` is supplied → parse with the existing `deriveProxy()` and launch
  a **dedicated short-lived Chromium** (`chromium.launch({ proxy })`) for that
  scrape only, closed in a `finally`. This avoids Playwright's per-context-proxy
  caveat (per-context proxy on a pool browser launched without
  `proxy.server='per-context'` is unreliable) and keeps per-call proxy spend
  isolated.
- If `proxyUrl` is omitted → acquire a context from the shared `BrowserPool`,
  which already carries the global `PROXY_URL` (set at launch).

Either path uses the same scraping routine, which takes a `BrowserContext`.

### Scraping routine (ported)

1. Navigate to `https://www.google.com/maps/search/<urlencoded query>`,
   `wait_until: domcontentloaded` (60s), with a `commit`+delay retry fallback.
2. **Block detection:** if URL contains `accounts.google.com` or `/sorry/`, throw
   `MapsBlockedError` → route returns `502 { error: "maps_blocked" }` with a hint
   to configure a residential proxy.
3. Dismiss the cookie/consent popup (best-effort).
4. Wait for `a[href^="https://www.google.com/maps/place"]`.
5. Find the results sidebar (`[role="feed"]` → `[aria-label*="Results"]` →
   `div[role="main"]`); scroll it, collecting new place cards each pass, until
   `max` results or the scroll height stops growing.
6. Parse each card container for: title, rating + review count, phone (regex),
   address (regex), website (first external non-Google link), category. Map link
   from the `href`.
7. Sort by rating desc, truncate to `max`.

Partial failures return whatever was collected so far plus a `warnings[]` entry
(MapLeads behavior) rather than erroring the whole call.

### Response

```jsonc
{
  "query": "immigration lawyer New York",
  "count": 18,
  "leads": [ /* Lead[] */ ],
  "warnings": [],
  "fetchedAt": "2026-06-21T..."
}
```

Synchronous. A 20-result scrape is roughly 20–60s; bounded by `max`. The hard cap
(120) and `LEADS_SCRAPE_TIMEOUT_MS` keep request duration bounded. Documented as a
long-running endpoint.

## Endpoint 2 — `POST /v1/leads/enrich`

Ports MapLeads `src/enrichers/local/` to `src/services/leads/enrich.ts`, reusing
sitesonar's `cheerio` for static parsing and `BrowserPool` for the headless
fallback. No `selectolax`/`httpx` equivalents needed.

### Request body

```jsonc
{
  "leads": [ /* Lead[] from /scrape (or any with a website) */ ],
  "guessEmails":     true,   // default true: role-based guess w/ MX verify
  "verifyMx":        true,   // default true
  "headlessFallback":true,   // default true: re-render top pages if no email
  "concurrency":     3       // default 3
}
```

### Per-lead funnel (ported, under a per-lead time budget)

For each lead with a `website`, derive the domain and run:

1. **Static crawl** of prioritized candidate pages (homepage, then `/contact`,
   `/about`, `/contact-us`, etc., discovered from homepage links) via `fetch`:
   extract emails, phones, and social profile URLs (LinkedIn/Facebook/Instagram);
   fill `description`/`name` from `og:`/`<title>`/`meta[description]`.
2. **Headless fallback** (if enabled and no email yet): re-render the top 1–2
   candidate pages with a `BrowserPool` context and re-extract.
3. **Email guess** (if enabled and still no email): role-based guess
   (`info@`, `contact@`, …) validated by an MX lookup (Node `dns/promises`
   `resolveMx`). Sets `emailConfidence: 'guessed'`; a scraped email sets
   `'scraped'`.

Leads without a website pass through unchanged with a per-lead warning. Leads are
processed with bounded `concurrency`. The endpoint never throws on a single lead;
failures become `warnings`.

### Response

```jsonc
{
  "count": 18,
  "leads": [ /* enriched Lead[] */ ],
  "warnings": [ /* e.g. "acme.com: no email found" */ ],
  "enrichedAt": "2026-06-21T..."
}
```

## Endpoint 3 — `POST /v1/leads/hubspot`

Ports MapLeads `src/crm/hubspot.py` to `src/services/leads/hubspot.ts` using plain
`fetch` against `https://api.hubapi.com` (no HubSpot SDK dependency).

### Request body

```jsonc
{
  "leads":    [ /* Lead[] */ ],
  "token":    "pat-...",            // optional; falls back to HUBSPOT_TOKEN env
  "industry": "immigration lawyer", // optional; drives type_contact tag
  "dryRun":   false                 // default false
}
```

If neither `token` nor `HUBSPOT_TOKEN` is set → `503 { error:
"hubspot_not_configured" }`.

### Behavior per lead (ported)

1. **Dedup:** search contacts by `email` (EQ); if none, by `phone`. If found,
   skip and return its id (`status: "exists"`).
2. **Property discovery:** fetch the account's contact property names once
   (cached per token); only send custom properties that actually exist.
3. **Create contact** mapping:
   - Standard: `firstname` (= title/company fallback), `lastname`, `email`,
     `phone`, `website`, `company`, `address`, `city`, `state`, `zip`, `country`.
   - Custom (only if present in account): `source=Google_Maps`,
     `statut_outbound=To_Contact`, `google_maps_link`, `linkedin_url`,
     `facebook_url`, `instagram_url`.
   - `type_contact` enum: derived by slugifying `industry`
     (`"immigration lawyer"` → value `Immigration_Lawyer`, label
     `Immigration Lawyer`); the option is auto-created on the property if missing
     and the token has schema-write scope; otherwise the tag is skipped (never
     send an invalid enum value).
4. **Retry** on HTTP 429 / 5xx with linear backoff (3 attempts); fail fast on 4xx.

`dryRun: true` runs dedup + mapping and reports what *would* be created without
writing.

### Response

```jsonc
{
  "created": 12,
  "skipped": 5,
  "failed":  1,
  "results": [
    { "title": "Acme Law", "status": "created", "hubspotId": "123" },
    { "title": "Beta LLP", "status": "exists",  "hubspotId": "456" },
    { "title": "Gamma PC", "status": "failed",  "error": "..." }
  ],
  "pushedAt": "2026-06-21T..."
}
```

## Config additions (`src/config.ts` + `.env.example`)

| Key (config)            | Env                       | Default | Notes |
|-------------------------|---------------------------|---------|-------|
| `hubspotToken`          | `HUBSPOT_TOKEN`           | —       | Optional fallback token for `/leads/hubspot`. |
| `leadsScrapeTimeoutMs`  | `LEADS_SCRAPE_TIMEOUT_MS` | 120000  | Overall scrape budget. |
| `leadsEnrichTimeoutMs`  | `LEADS_ENRICH_TIMEOUT_MS` | 15000   | Per-lead enrichment budget. |
| `leadsMaxResults`       | `LEADS_MAX_RESULTS`       | 120     | Hard cap on scrape `max`. |

Per-request `proxyUrl` reuses the existing `proxyUrl`/`proxyBypass` parsing via
`deriveProxy()`. No new env needed for proxy.

No new npm dependencies: `playwright`, `cheerio`, `zod`, and Node `dns/promises`
cover everything. (HubSpot SDK and `selectolax`/`httpx` are intentionally avoided
in favor of `fetch` + `cheerio`.)

## Error handling

Route-level mapping (consistent with `routes/company.ts` conventions):

- `400 bad_request` — zod validation failure (e.g. neither/both of query/industry).
- `502 maps_blocked` — Google `/sorry/` or sign-in redirect during scrape.
- `503 hubspot_not_configured` — no token available.
- `502 hubspot_failed` — HubSpot API error after retries (per-lead, reflected in
  `results[].status="failed"`; the call still returns 200 with the breakdown).
- `500 internal_error` — unexpected.

## Testing

Unit tests (vitest, alongside the source files as elsewhere in the repo):

- `maps.test.ts` — the card parser against a saved Google Maps results HTML
  fixture (title/rating/phone/address/website extraction). No live network.
- `enrich.test.ts` — email/phone/social extraction + role-based guess against
  fixture HTML; MX verify mocked.
- `hubspot.test.ts` — field mapping, dedup decision, and `type_contact`
  slugify/auto-create logic with `fetch` mocked.

Live Maps scraping and live HubSpot writes are not unit-tested (network/credential
dependent); they're exercised manually against the running service.

## Open implementation detail to verify during build

- Confirm the dedicated-Chromium-per-proxy path vs. the per-context-proxy path on
  the installed Playwright version (1.60.0). The design assumes a dedicated launch
  when `proxyUrl` is supplied; if per-context proxy proves reliable, the scraper
  can instead pass `{ proxy }` to `BrowserPool.acquire()` and skip the dedicated
  launch.
