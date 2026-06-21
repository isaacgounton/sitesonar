# Sitesonar

Self-hosted scraping + SEO-audit HTTP API. Real Chromium via Playwright,
multi-page crawls via Crawlee, performance + accessibility scores via
Lighthouse, plus web search, firmographics, and content extraction behind one
Bearer-authenticated API. One ping, full picture of any URL — designed to be a
permanent piece of infrastructure that any project can call.

## Endpoints

```
— scrape ———————————————————————————————————————————————————————————————
POST /v1/scrape        render a URL → metadata + markdown (+ optional HTML)
POST /v1/screenshot    page screenshot (mobile/desktop/tablet, full or above-fold)

— audit ————————————————————————————————————————————————————————————————
POST /v1/audit-page    SEO audit: metadata + structured data + Lighthouse scores
POST /v1/security      grade a URL's HTTP security headers against a rubric

— crawl (async) ————————————————————————————————————————————————————————
POST /v1/crawl         multi-page crawl with link graph → returns a job id
GET  /v1/jobs/{id}     poll a crawl job (status + result when complete)

— discovery ————————————————————————————————————————————————————————————
POST /v1/sitemap       parse XML sitemaps, resolve sitemap indexes
POST /v1/robots        parse robots.txt (rules per user-agent, sitemaps)

— content ——————————————————————————————————————————————————————————————
POST /v1/extract       Readability article extraction (clean text + markdown)
POST /v1/tech          technology stack fingerprinting
POST /v1/export/pdf    render a URL to PDF
POST /v1/export/md     render a URL to Markdown

— intelligence —————————————————————————————————————————————————————————
POST /v1/search        web search through a free-first provider fallback chain
POST /v1/company       company firmographics + contacts via a provider chain

— leads pipeline ————————————————————————————————————————————————————————
POST /v1/leads/scrape  scrape Google Maps for leads by industry + location
POST /v1/leads/enrich  crawl each lead's website for email, phone, and socials
POST /v1/leads/hubspot push enriched leads to HubSpot (dedupe by email/phone)

— system ———————————————————————————————————————————————————————————————
GET  /v1/usage         your current rate-limit quota (exempt from rate limiting)
GET  /health           liveness probe + capacity snapshot (public, no auth)
GET  /healthz          alias of /health (public, no auth)
GET  /docs             Swagger UI
GET  /openapi.json     OpenAPI 3.0 spec (also /openapi.yaml, /docs/json)
```

All `/v1/*` endpoints require `Authorization: Bearer <api-key>`. Define keys
via the `API_KEYS` env var (comma-separated). `/health`, `/healthz`, and the
spec/docs routes are public.

### Leads pipeline

A three-step lead-generation chain. Endpoints are stateless — pass each step's
`leads[]` output into the next.

- `POST /v1/leads/scrape` — scrape Google Maps for businesses. Body:
  `{ "industry": "immigration lawyer", "location": "New York", "max": 20, "proxyUrl": "http://user:pass@host:port" }`
  (or a raw `query` string instead of `industry`+`location`). `proxyUrl` is
  optional and falls back to the global `PROXY_URL`. Returns
  `{ query, count, leads, warnings, fetchedAt }`. Long-running and synchronous.
- `POST /v1/leads/enrich` — crawl each lead's website for email, phone, socials,
  and description. Body: `{ "leads": [...], "guessEmails": true, "verifyMx": true, "headlessFallback": true, "concurrency": 3 }`.
  Returns `{ count, leads, warnings, enrichedAt }`.
- `POST /v1/leads/hubspot` — push contacts to HubSpot (dedupe by email/phone).
  Body: `{ "leads": [...], "industry": "immigration lawyer", "token": "pat-...", "dryRun": false }`.
  `token` falls back to `HUBSPOT_TOKEN`. Returns `{ created, skipped, failed, results, pushedAt }`.
  Returns HTTP 503 (`hubspot_not_configured`) when no token is available.

## Cross-cutting features

- **Per-key rate limiting.** Fixed 60-second window (`RATE_LIMIT_PER_MIN`).
  Exceeded calls get HTTP 429 with `Retry-After` and `X-RateLimit-*` headers.
  `GET /v1/usage` is exempt so you can poll your own quota for free.
- **Webhooks.** `/v1/crawl` accepts a `webhookUrl`; on job completion the body
  is POSTed and, when `WEBHOOK_SECRET` is set, HMAC-SHA256-signed in
  `X-Sitesonar-Signature: sha256=…` (unsigned receivers should refuse).
- **Change tracking.** `/v1/scrape` and `/v1/extract` accept `trackChanges` to
  hash content per API-key + URL and report whether the page changed since the
  last call (`DIFF_TTL_DAYS` retention).
- **Optional Redis.** Set `REDIS_URL` to persist job state, rate-limit counters,
  and change-tracking hashes across restarts and replicas. Without it, an
  in-memory store is used (fine for a single instance).
- **Optional outbound proxy.** Set `PROXY_URL` to route Playwright + Crawlee
  traffic through an HTTP(S)/SOCKS5 proxy.

## Stack

- **Fastify 5** – HTTP server
- **Playwright** – real Chromium with browser-pool reuse
- **Crawlee 3** – queue, dedup, retries, link enqueuing for `/crawl`
- **Lighthouse 12** – performance / accessibility / SEO / best-practices audits
- **Cheerio** – HTML parsing for metadata + JSON-LD extraction
- **Mozilla Readability + Turndown** – article extraction and HTML→Markdown
- **Zod** – request validation
- **TypeScript** – built with `tsc`, runs on Node 20+

## Local development

Requires Node 20+ and ~1 GB of disk for Chromium.

```bash
cp .env.example .env
# generate a real API key:
#   echo "ss_live_$(openssl rand -hex 32)"
# and put it in API_KEYS

npm install
npx playwright install chromium       # downloads the browser binary
npm run dev                            # tsx watch on src/server.ts
```

Then hit it:

```bash
curl -X POST http://localhost:8080/v1/scrape \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

Browse `http://localhost:8080/docs` for live API docs.

## Configuration

Every setting is an environment variable, fully documented in
[`.env.example`](.env.example) — server, per-endpoint timeouts, browser-pool
size, rate limit, Redis, proxy, webhook secret, and the credentials/ordering
for the `/v1/search` and `/v1/company` provider chains. Both chains are
free-first: providers without credentials are skipped, and the chain stops at
the first one that returns a result, so the endpoints work out of the box and
get richer as you add keys.

## Deploy on Coolify

1. **Push to a git remote** Coolify can pull from.
2. **Create an Application** in Coolify:
   - Build Pack: **Dockerfile**
   - Source: this repo
   - Port: `8080`
   - Health check path: `/health`
3. **Set env vars on the app:**
   ```
   API_KEYS=ss_live_<openssl rand -hex 32 output>,<more keys if you need>
   CORS_ORIGINS=https://your-frontend.example.com
   LOG_LEVEL=info
   ```
4. **Resources:** allocate at least **2 GB RAM, 1 vCPU**. Lighthouse pushes
   memory above 1 GB while running. If you're sharing the box with other
   apps, give it its own VPS — the plan called for separation, and it's right.
5. Deploy. Coolify mints an HTTPS URL via Traefik.

## Usage from your other projects

```ts
const res = await fetch(`${SITESONAR_URL}/v1/audit-page`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.SITESONAR_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ url: 'https://example.com', preset: 'mobile' }),
});
const audit = await res.json();
```

Plain HTTP — drop-in for any language, any framework.

## Architecture notes / honest limits

- **One Chromium for the browser pool, separate Chrome per Lighthouse run.**
  The pool serves `/scrape`, `/screenshot`, `/extract`, `/export`, and the
  rendering step of `/audit-page`. Lighthouse spawns its own short-lived Chrome
  via `chrome-launcher` so it doesn't trample the pool. The trade-off is that
  audits don't share state with scrapes — same target gets fetched twice.
- **Crawl jobs default to in-memory, with optional Redis.** `/crawl` results
  live in a `Map` and disappear on restart unless `REDIS_URL` is set. Redis
  gives you persistence and multi-replica safety; there's no BullMQ-style
  distributed worker yet (single process drains the queue).
- **Crawlee storage is on `/tmp`.** Request-queue state for `/crawl` is
  ephemeral by design (each call uses a fresh queue, dropped on completion).
  No volume needed.
- **Outbound proxy is all-or-nothing.** `PROXY_URL` applies to every Playwright
  + Crawlee request; there's no per-domain routing or session rotation pool.
- **Schema validation is shallow.** It parses JSON-LD blocks and counts
  microdata/RDFa nodes. For real schema.org compliance, post the HTML to
  `validator.schema.org` or run `structured-data-testing-tool` programmatically.

## What's missing (v2 candidates)

- Per-domain proxy / session rotation pool
- Distributed crawl workers (BullMQ) for true multi-replica throughput
- Cache layer (Redis or pg) so repeat scrapes don't re-fetch
- Custom Lighthouse configs (audit only specific categories, custom budgets)
- Endpoint metrics (Prometheus exporter)
