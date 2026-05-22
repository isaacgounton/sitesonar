# Jina Search Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Jina AI (`s.jina.ai`) as a new entry in the search provider fallback chain — keyless by default with optional `JINA_API_KEY` for higher rate limits — slotted between SearXNG and Brave.

**Architecture:** Implements the existing `SearchProvider` interface in `src/services/search.ts`. Same shape as `SearxngProvider`/`TavilyProvider`: clean SERP-only mapping, no PAA/related/knowledge-panel. Uses Jina's `X-Respond-With: no-content` header so we get metadata-only results without burning rate limits on full-content fetches.

**Tech Stack:** TypeScript, Zod, native `fetch` via existing `fetchJson` helper, Fastify route.

**Spec:** `docs/superpowers/specs/2026-05-22-jina-search-provider-design.md`

**Note on testing:** Existing search providers have no unit tests (only `security-headers`, `robots`, `sitemap` services do). This plan matches that convention. Validation is done via TypeScript build (`npm run build` / `tsc --noEmit`) and a manual smoke test against the live Jina endpoint in Task 6.

---

### Task 1: Add `'jina'` to the `ProviderName` union

**Files:**
- Modify: `src/services/search.ts:3`

- [ ] **Step 1: Edit the `ProviderName` union**

Replace:
```typescript
export type ProviderName = 'searxng' | 'brave' | 'google' | 'serpapi' | 'serper' | 'tavily';
```

With:
```typescript
export type ProviderName = 'searxng' | 'jina' | 'brave' | 'google' | 'serpapi' | 'serper' | 'tavily';
```

- [ ] **Step 2: Run TypeScript compile to surface every site that needs updating**

Run: `npx tsc --noEmit`
Expected: Errors in `src/config.ts` (the `searchProviders` enum doesn't include `'jina'`) and in `src/services/search.ts:431` (the `Record<ProviderName, SearchProvider>` is missing the `jina` key). These errors are the breadcrumbs for later tasks — don't fix them yet.

- [ ] **Step 3: Do not commit yet**

This change is incomplete on its own. We'll commit at Task 5 once the provider class, registry entry, and config are all wired.

---

### Task 2: Add the `JinaProvider` class

**Files:**
- Modify: `src/services/search.ts` — insert new class after `SearxngProvider` (ends at line 116) and before the `BraveProvider` block-comment that starts at line 118

- [ ] **Step 1: Insert the `JinaProvider` class between SearXNG and Brave**

Insert the following block immediately after line 116 (the closing `}` of `SearxngProvider`) and before line 118 (the `// ─── Brave Search API ───` block-comment):

```typescript

// ─── Jina AI Search ────────────────────────────────────────────────────────
// Free, keyless-friendly. Default rate limit is moderate; sending
// `Authorization: Bearer <JINA_API_KEY>` raises it. `X-Respond-With: no-content`
// returns SERP metadata only (Jina's default mode fetches each result page's
// full content, which is wasteful and slow for our use case).
// https://jina.ai/reader/  (search at https://s.jina.ai/)

class JinaProvider implements SearchProvider {
  readonly name = 'jina' as const;
  constructor(private apiKey?: string) {}
  // Works without a key, so this provider is always "configured". Users opt
  // out by removing 'jina' from SEARCH_PROVIDERS.
  isConfigured(): boolean {
    return true;
  }
  async search(q: SearchQuery, signal: AbortSignal): Promise<SearchData> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Respond-With': 'no-content',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (q.lang) headers['X-Locale'] = q.lang;
    const data = (await fetchJson(
      'https://s.jina.ai/',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: q.query, num: q.num }),
      },
      signal,
    )) as {
      code?: number;
      message?: string;
      data?: Array<{ title?: string; url?: string; description?: string }>;
    };
    // Jina sometimes returns HTTP 200 with a body-level error code.
    if (data.code !== undefined && data.code !== 200) {
      throw new Error(`Jina: code ${data.code}${data.message ? ` — ${data.message}` : ''}`);
    }
    const organic: OrganicResult[] = (data.data ?? [])
      .slice(0, q.num)
      .map((r, i) => ({
        position: i + 1,
        title: r.title ?? '',
        link: r.url ?? '',
        snippet: r.description ?? '',
        displayLink: safeDisplayLink(r.url ?? ''),
      }));
    return {
      organic,
      paa: [],
      related: [],
      features: emptyFeatures(),
      totalResults: null,
    };
  }
}
```

- [ ] **Step 2: Register the provider in `buildProviders`**

In `src/services/search.ts` find the `all` record inside `buildProviders` (currently lines 431–438):

```typescript
  const all: Record<ProviderName, SearchProvider> = {
    searxng: new SearxngProvider(config.searxngUrl),
    brave: new BraveProvider(config.braveSearchApiKey),
    google: new GoogleCseProvider(config.googleSearchApiKey, config.googleSearchCx),
    serpapi: new SerpapiProvider(config.serpapiApiKey),
    serper: new SerperProvider(config.serperApiKey),
    tavily: new TavilyProvider(config.tavilyApiKey),
  };
```

Replace with (note `jina` inserted between `searxng` and `brave`):

```typescript
  const all: Record<ProviderName, SearchProvider> = {
    searxng: new SearxngProvider(config.searxngUrl),
    jina: new JinaProvider(config.jinaApiKey),
    brave: new BraveProvider(config.braveSearchApiKey),
    google: new GoogleCseProvider(config.googleSearchApiKey, config.googleSearchCx),
    serpapi: new SerpapiProvider(config.serpapiApiKey),
    serper: new SerperProvider(config.serperApiKey),
    tavily: new TavilyProvider(config.tavilyApiKey),
  };
```

- [ ] **Step 3: Run TypeScript compile**

Run: `npx tsc --noEmit`
Expected: `src/services/search.ts` is now clean. The remaining error should be `Property 'jinaApiKey' does not exist on type 'Config'` (pointing at the new `new JinaProvider(config.jinaApiKey)` line) and the `searchProviders` enum error in `src/config.ts`. Those are fixed in Task 3.

- [ ] **Step 4: Do not commit yet**

---

### Task 3: Wire `jinaApiKey` and `'jina'` into config

**Files:**
- Modify: `src/config.ts:40-42` (the `searchProviders` zod schema + default)
- Modify: `src/config.ts:48` (insert `jinaApiKey` field)
- Modify: `src/config.ts:104` area (insert `jinaApiKey` loader)

- [ ] **Step 1: Update the `searchProviders` zod enum and default**

In `src/config.ts`, replace lines 40–42:

```typescript
  searchProviders: z
    .array(z.enum(['searxng', 'brave', 'google', 'serpapi', 'serper', 'tavily']))
    .default(['searxng', 'brave', 'google', 'serpapi', 'serper', 'tavily']),
```

With:

```typescript
  searchProviders: z
    .array(z.enum(['searxng', 'jina', 'brave', 'google', 'serpapi', 'serper', 'tavily']))
    .default(['searxng', 'jina', 'brave', 'google', 'serpapi', 'serper', 'tavily']),
```

- [ ] **Step 2: Add `jinaApiKey` to the config schema**

In `src/config.ts`, after the line `braveSearchApiKey: z.string().optional(),` (currently line 48), insert a new line:

```typescript
  jinaApiKey: z.string().optional(),
```

The surrounding region should read:

```typescript
  braveSearchApiKey: z.string().optional(),
  jinaApiKey: z.string().optional(),
  googleSearchApiKey: z.string().optional(),
```

- [ ] **Step 3: Add `jinaApiKey` to the loader**

In `src/config.ts`, after the line `braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,` (currently line 100), insert:

```typescript
    jinaApiKey: process.env.JINA_API_KEY,
```

The surrounding region should read:

```typescript
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,
    jinaApiKey: process.env.JINA_API_KEY,
    googleSearchApiKey: process.env.GOOGLE_SEARCH_API_KEY,
```

- [ ] **Step 4: Run TypeScript compile**

Run: `npx tsc --noEmit`
Expected: Clean across `src/services/search.ts` and `src/config.ts`. There may still be an error in `src/routes/search.ts` because the `engine` zod enum and the Fastify schema both whitelist providers — that's fixed in Task 4.

- [ ] **Step 5: Do not commit yet**

---

### Task 4: Update the search route validation and docs

**Files:**
- Modify: `src/routes/search.ts:18` (Zod `engine` enum)
- Modify: `src/routes/search.ts:39` (OpenAPI description)
- Modify: `src/routes/search.ts:62` (Fastify schema `engine` enum)
- Modify: `src/routes/search.ts:97` (error message hint)

- [ ] **Step 1: Add `'jina'` to the Zod `engine` enum**

Replace line 18:

```typescript
    .enum(['searxng', 'brave', 'google', 'serpapi', 'serper', 'tavily'])
```

With:

```typescript
    .enum(['searxng', 'jina', 'brave', 'google', 'serpapi', 'serper', 'tavily'])
```

- [ ] **Step 2: Update the OpenAPI description**

Replace line 39:

```typescript
            'Search the web through a free-first provider chain (SearXNG → Brave → Google CSE → Serper → Tavily by default). Falls through to the next provider on 4xx/5xx/timeout. Use `engine` to pin a specific provider and skip the chain.',
```

With:

```typescript
            'Search the web through a free-first provider chain (SearXNG → Jina → Brave → Google CSE → SerpAPI → Serper → Tavily by default). Falls through to the next provider on 4xx/5xx/timeout. Use `engine` to pin a specific provider and skip the chain. Jina works keyless; set JINA_API_KEY to raise rate limits.',
```

- [ ] **Step 3: Add `'jina'` to the Fastify schema `engine` enum**

Replace line 62:

```typescript
                enum: ['searxng', 'brave', 'google', 'serpapi', 'serper', 'tavily'],
```

With:

```typescript
                enum: ['searxng', 'jina', 'brave', 'google', 'serpapi', 'serper', 'tavily'],
```

- [ ] **Step 4: Update the `no_providers_configured` error hint**

Replace line 97:

```typescript
                'No search providers are available. Configure at least one of SEARXNG_URL, BRAVE_SEARCH_API_KEY, GOOGLE_SEARCH_API_KEY+GOOGLE_SEARCH_CX, SERPAPI_KEY, SERPER_API_KEY, or TAVILY_API_KEY.',
```

With:

```typescript
                'No search providers are available. Jina works keyless — include "jina" in SEARCH_PROVIDERS, or configure at least one of SEARXNG_URL, JINA_API_KEY, BRAVE_SEARCH_API_KEY, GOOGLE_SEARCH_API_KEY+GOOGLE_SEARCH_CX, SERPAPI_KEY, SERPER_API_KEY, or TAVILY_API_KEY.',
```

- [ ] **Step 5: Run TypeScript compile**

Run: `npx tsc --noEmit`
Expected: Clean — zero errors.

- [ ] **Step 6: Do not commit yet — `.env.example` still pending**

---

### Task 5: Update `.env.example` and commit

**Files:**
- Modify: `.env.example:67` (default chain)
- Modify: `.env.example:75-76` (insert Jina block after the Brave block)

- [ ] **Step 1: Update the default chain**

Replace line 67:

```
SEARCH_PROVIDERS=searxng,brave,google,serpapi,serper,tavily
```

With:

```
SEARCH_PROVIDERS=searxng,jina,brave,google,serpapi,serper,tavily
```

- [ ] **Step 2: Insert the Jina block after the Brave block**

After line 75 (`BRAVE_SEARCH_API_KEY=`) and its preceding comment lines (74), insert a blank line followed by:

```
# Jina AI Search — free, keyless tier works out of the box. Setting a key
# raises rate limits. https://jina.ai/reader/
JINA_API_KEY=
```

The surrounding region should read:

```
# Brave Search API — 2,000 queries/mo free. https://api.search.brave.com
BRAVE_SEARCH_API_KEY=

# Jina AI Search — free, keyless tier works out of the box. Setting a key
# raises rate limits. https://jina.ai/reader/
JINA_API_KEY=

# Google Custom Search — 100 queries/day free. Requires a Custom Search
```

- [ ] **Step 3: Final TypeScript compile**

Run: `npx tsc --noEmit`
Expected: Clean — zero errors.

- [ ] **Step 4: Build the project**

Run: `npm run build`
Expected: Succeeds, no errors.

- [ ] **Step 5: Stage and commit**

```bash
git add src/services/search.ts src/config.ts src/routes/search.ts .env.example
git commit -m "$(cat <<'EOF'
feat(search): add Jina AI provider to fallback chain

Inserts s.jina.ai between SearXNG and Brave in the default chain.
Keyless by default; JINA_API_KEY raises rate limits. Uses
X-Respond-With: no-content for SERP-style metadata-only results.

EOF
)"
```

Expected: Commit created on `main` (or whatever branch is active).

---

### Task 6: Manual smoke test against live Jina endpoint

This is the only end-to-end validation since there are no unit tests for providers. Tests that Jina is reachable, the response parses, and the chain returns it as `providerUsed: "jina"`.

**Files:** None (runtime test only).

- [ ] **Step 1: Start the server in one terminal**

Run: `npm run dev` (or whatever the project's dev command is — check `package.json` `scripts.dev` if uncertain)
Expected: Server listening on the configured PORT. Log line includes `Search providers configured:` with `jina` in the chain.

- [ ] **Step 2: Issue a search request that forces the Jina engine**

In another terminal (substitute `$PORT` and `$API_KEY` for your local values — `$API_KEY` is whatever is in `API_KEYS` in your `.env`):

```bash
curl -sS -X POST "http://localhost:${PORT:-3000}/v1/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{"query":"openai","num":5,"engine":"jina"}' | jq '.providerUsed, (.organic | length), .organic[0]'
```

Expected output (values will vary, structure should match):
```
"jina"
5
{
  "position": 1,
  "title": "OpenAI",
  "link": "https://openai.com/",
  "snippet": "...",
  "displayLink": "openai.com"
}
```

- [ ] **Step 3: Verify chain fallback works by issuing an unforced search**

```bash
curl -sS -X POST "http://localhost:${PORT:-3000}/v1/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{"query":"stripe","num":3}' | jq '.providerUsed, .providerFallbacks'
```

Expected: `providerUsed` is whichever provider succeeded first in the chain. If you don't have a `SEARXNG_URL` configured, it should be `"jina"` with `providerFallbacks: []`. If SearXNG is configured and reachable, it should be `"searxng"`.

- [ ] **Step 4: Stop the dev server**

Ctrl-C in the terminal running `npm run dev`.

- [ ] **Step 5: If smoke test failed, debug and amend the commit; if it passed, no further action**

Common failure modes:
- 404 on `s.jina.ai/` — Jina may have changed the path; check their current docs.
- `code !== 200` in body — Jina rate limit hit on keyless tier; set `JINA_API_KEY` in `.env` and retry.
- Empty `organic` array — verify `X-Respond-With: no-content` is still the correct header name (Jina has renamed headers before).

---

## Self-Review

Checked against spec sections:

- **Summary / chain position:** Tasks 1, 3 insert `'jina'` between `searxng` and `brave` in type union, config enum, and default. ✓
- **API reference (POST s.jina.ai/, headers, body, response shape):** Task 2 implements exactly this. ✓
- **`isConfigured(): true` always:** Task 2 step 1. ✓
- **Optional `JINA_API_KEY` for higher limits:** Task 2 step 1 (`if (this.apiKey) headers.Authorization = ...`) + Task 3 steps 2/3 (schema + loader) + Task 5 step 2 (`.env.example` block). ✓
- **`X-Respond-With: no-content` to avoid full content fetches:** Task 2 step 1. ✓
- **`X-Locale` from `q.lang`:** Task 2 step 1. ✓
- **`q.country` ignored:** Task 2 step 1 — not referenced in headers/body. ✓
- **Body-level `code !== 200` error handling:** Task 2 step 1. ✓
- **Response field mapping (title/url/description → organic):** Task 2 step 1. ✓
- **paa/related/features/totalResults all empty:** Task 2 step 1. ✓
- **Config changes (3 files: search.ts, config.ts, .env.example):** Tasks 2, 3, 5. ✓
- **Route description + error message updates:** Task 4. ✓
- **Route Zod + Fastify `engine` enum updates:** Task 4 steps 1 + 3. (Not explicitly in spec, but required for the `engine: 'jina'` parameter to validate. Caught during planning.) ✓
- **No tests:** Spec Non-Goals — matched. ✓

Placeholder scan: no TBDs, no "add appropriate X", every code step contains complete code, every command is exact. ✓

Type consistency: `jinaApiKey` named identically in config schema (Task 3 step 2), loader (Task 3 step 3), and `JinaProvider` constructor call (Task 2 step 2). `'jina'` literal matches across `ProviderName`, `searchProviders` enum, route Zod enum, Fastify schema enum, and `.env.example` chain. ✓
