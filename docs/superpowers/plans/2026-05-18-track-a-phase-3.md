# Track A — Phase 3: Sitemap

> Index: `2026-05-18-track-a-endpoint-pack.md` — prerequisites: Phase 2 complete.

Goal: ship `services/sitemap.ts` and `POST /v1/sitemap`. Parses both `<urlset>` and `<sitemapindex>` formats, follows sitemap-index one level deep, auto-discovers `/sitemap.xml` when given a site root.

### Task 3.1: Install fast-xml-parser

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

Run: `pnpm add fast-xml-parser`
Expected: Installs cleanly.

### Task 3.2: Add `sitemapTimeoutMs` to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add schema field (after `robotsTimeoutMs`)**

```ts
  sitemapTimeoutMs: z.coerce.number().int().positive().default(15_000),
```

- [ ] **Step 2: Wire env var**

```ts
    sitemapTimeoutMs: process.env.SITEMAP_TIMEOUT_MS,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 3.3: Create sitemap fixtures

**Files:**
- Create: `test/fixtures/sitemap/urlset.xml`
- Create: `test/fixtures/sitemap/sitemapindex.xml`
- Create: `test/fixtures/sitemap/child-a.xml`
- Create: `test/fixtures/sitemap/child-b.xml`

- [ ] **Step 1: urlset.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/page-1</loc>
    <lastmod>2026-05-01T00:00:00Z</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/page-2</loc>
    <lastmod>2026-04-15</lastmod>
  </url>
</urlset>
```

- [ ] **Step 2: sitemapindex.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-a.xml</loc>
    <lastmod>2026-05-01</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemap-b.xml</loc>
  </sitemap>
</sitemapindex>
```

- [ ] **Step 3: child-a.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a-1</loc></url>
  <url><loc>https://example.com/a-2</loc></url>
</urlset>
```

- [ ] **Step 4: child-b.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/b-1</loc></url>
</urlset>
```

### Task 3.4: Implement `parseSitemapXml` (TDD)

**Files:**
- Create: `src/services/sitemap.ts`
- Create: `src/services/sitemap.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSitemapXml } from './sitemap.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(here, '../../test/fixtures/sitemap', name), 'utf8');

describe('parseSitemapXml', () => {
  it('parses a urlset', () => {
    const result = parseSitemapXml(fixture('urlset.xml'));
    expect(result.kind).toBe('urlset');
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0]).toEqual({
      loc: 'https://example.com/page-1',
      lastmod: '2026-05-01T00:00:00Z',
      changefreq: 'monthly',
      priority: 0.8,
    });
    expect(result.urls[1]!.changefreq).toBeNull();
    expect(result.urls[1]!.priority).toBeNull();
  });

  it('parses a sitemap index', () => {
    const result = parseSitemapXml(fixture('sitemapindex.xml'));
    expect(result.kind).toBe('sitemapindex');
    expect(result.sitemaps).toEqual([
      { loc: 'https://example.com/sitemap-a.xml', lastmod: '2026-05-01' },
      { loc: 'https://example.com/sitemap-b.xml', lastmod: null },
    ]);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm test src/services/sitemap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/services/sitemap.ts`:

```ts
import { XMLParser } from 'fast-xml-parser';

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
}

export interface SitemapIndexEntry {
  loc: string;
  lastmod: string | null;
}

export interface ParsedUrlset {
  kind: 'urlset';
  urls: SitemapUrl[];
  sitemaps: never[];
}

export interface ParsedSitemapIndex {
  kind: 'sitemapindex';
  urls: never[];
  sitemaps: SitemapIndexEntry[];
}

export type ParsedSitemap = ParsedUrlset | ParsedSitemapIndex;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

export function parseSitemapXml(xml: string): ParsedSitemap {
  const doc = parser.parse(xml) as Record<string, unknown>;

  if (doc.sitemapindex && typeof doc.sitemapindex === 'object') {
    const block = doc.sitemapindex as { sitemap?: unknown };
    const entries = arrayify(block.sitemap);
    const sitemaps: SitemapIndexEntry[] = entries.map((e) => {
      const obj = e as { loc?: string; lastmod?: string };
      return { loc: obj.loc ?? '', lastmod: obj.lastmod ?? null };
    });
    return { kind: 'sitemapindex', urls: [] as never[], sitemaps };
  }

  if (doc.urlset && typeof doc.urlset === 'object') {
    const block = doc.urlset as { url?: unknown };
    const entries = arrayify(block.url);
    const urls: SitemapUrl[] = entries.map((e) => {
      const obj = e as {
        loc?: string;
        lastmod?: string;
        changefreq?: string;
        priority?: string;
      };
      const priorityNum = obj.priority != null ? Number(obj.priority) : null;
      return {
        loc: obj.loc ?? '',
        lastmod: obj.lastmod ?? null,
        changefreq: obj.changefreq ?? null,
        priority: priorityNum != null && !Number.isNaN(priorityNum) ? priorityNum : null,
      };
    });
    return { kind: 'urlset', urls, sitemaps: [] as never[] };
  }

  return { kind: 'urlset', urls: [], sitemaps: [] as never[] };
}

function arrayify<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm test src/services/sitemap.test.ts`
Expected: 2 tests pass.

### Task 3.5: Implement `resolveSitemap` (follows index one level)

**Files:**
- Modify: `src/services/sitemap.ts`
- Modify: `src/services/sitemap.test.ts`

- [ ] **Step 1: Append `resolveSitemap` to the service**

```ts
export interface ResolvedSitemap {
  isSitemapIndex: boolean;
  sitemapsResolved: number;
  urls: SitemapUrl[];
  urlCount: number;
  truncated: boolean;
}

export interface SitemapFetcher {
  (url: string): Promise<string>;
}

export async function resolveSitemap(
  rootUrl: string,
  fetcher: SitemapFetcher,
  options: { limit: number; followIndex: boolean },
): Promise<ResolvedSitemap> {
  const rootXml = await fetcher(rootUrl);
  const rootParsed = parseSitemapXml(rootXml);

  if (rootParsed.kind === 'urlset') {
    const truncated = rootParsed.urls.length > options.limit;
    const urls = truncated ? rootParsed.urls.slice(0, options.limit) : rootParsed.urls;
    return {
      isSitemapIndex: false,
      sitemapsResolved: 1,
      urls,
      urlCount: urls.length,
      truncated,
    };
  }

  // sitemap-index case
  if (!options.followIndex) {
    const urls: SitemapUrl[] = rootParsed.sitemaps.map((s) => ({
      loc: s.loc,
      lastmod: s.lastmod,
      changefreq: null,
      priority: null,
    }));
    return {
      isSitemapIndex: true,
      sitemapsResolved: 0,
      urls,
      urlCount: urls.length,
      truncated: false,
    };
  }

  const children = rootParsed.sitemaps.map((s) => s.loc);
  const merged: SitemapUrl[] = [];
  let truncated = false;
  let resolved = 0;
  for (let i = 0; i < children.length; i += 5) {
    if (merged.length >= options.limit) {
      truncated = true;
      break;
    }
    const chunk = children.slice(i, i + 5);
    const xmls = await Promise.all(chunk.map((u) => fetcher(u).catch(() => null)));
    for (const xml of xmls) {
      if (xml === null) continue;
      resolved += 1;
      const parsed = parseSitemapXml(xml);
      // Depth cap: only one level deep. Nested indexes are not recursed.
      if (parsed.kind === 'urlset') {
        for (const u of parsed.urls) {
          if (merged.length >= options.limit) {
            truncated = true;
            break;
          }
          merged.push(u);
        }
      }
      if (truncated) break;
    }
  }
  return {
    isSitemapIndex: true,
    sitemapsResolved: resolved,
    urls: merged,
    urlCount: merged.length,
    truncated,
  };
}
```

- [ ] **Step 2: Append tests using a fixture-backed fetcher**

```ts
import { resolveSitemap } from './sitemap.js';

describe('resolveSitemap', () => {
  const fixtureFetcher = async (url: string): Promise<string> => {
    if (url.endsWith('sitemapindex.xml')) return fixture('sitemapindex.xml');
    if (url.endsWith('sitemap-a.xml')) return fixture('child-a.xml');
    if (url.endsWith('sitemap-b.xml')) return fixture('child-b.xml');
    if (url.endsWith('urlset.xml')) return fixture('urlset.xml');
    throw new Error(`unexpected url ${url}`);
  };

  it('returns urls directly when root is a urlset', async () => {
    const result = await resolveSitemap('https://example.com/urlset.xml', fixtureFetcher, {
      limit: 50_000,
      followIndex: true,
    });
    expect(result.isSitemapIndex).toBe(false);
    expect(result.urlCount).toBe(2);
  });

  it('follows a sitemap-index when followIndex=true', async () => {
    const result = await resolveSitemap(
      'https://example.com/sitemapindex.xml',
      fixtureFetcher,
      { limit: 50_000, followIndex: true },
    );
    expect(result.isSitemapIndex).toBe(true);
    expect(result.sitemapsResolved).toBe(2);
    expect(result.urlCount).toBe(3);
  });

  it('respects the limit and sets truncated=true', async () => {
    const result = await resolveSitemap(
      'https://example.com/sitemapindex.xml',
      fixtureFetcher,
      { limit: 2, followIndex: true },
    );
    expect(result.truncated).toBe(true);
    expect(result.urlCount).toBe(2);
  });

  it('returns raw sitemap entries when followIndex=false', async () => {
    const result = await resolveSitemap(
      'https://example.com/sitemapindex.xml',
      fixtureFetcher,
      { limit: 50_000, followIndex: false },
    );
    expect(result.isSitemapIndex).toBe(true);
    expect(result.sitemapsResolved).toBe(0);
    expect(result.urls.map((u) => u.loc)).toEqual([
      'https://example.com/sitemap-a.xml',
      'https://example.com/sitemap-b.xml',
    ]);
  });
});
```

- [ ] **Step 3: Run all sitemap tests**

Run: `pnpm test src/services/sitemap.test.ts`
Expected: 6 tests pass (2 parse + 4 resolve).

- [ ] **Step 4: Commit service**

```
git add src/services/sitemap.ts src/services/sitemap.test.ts test/fixtures/sitemap/ src/config.ts package.json pnpm-lock.yaml
git commit -m "feat(sitemap): add XML sitemap parser with index resolution"
```

### Task 3.6: Create `POST /v1/sitemap` route with auto-discovery

**Files:**
- Create: `src/routes/sitemap.ts`

- [ ] **Step 1: Create the route**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { resolveSitemap, type SitemapFetcher } from '../services/sitemap.js';
import { parseRobots } from '../services/robots.js';

const SitemapBody = z.object({
  url: z.string().url(),
  limit: z.number().int().min(1).max(50_000).optional(),
  followIndex: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

interface SitemapDeps {
  config: Config;
}

const DISCOVERY_PATHS = ['/sitemap.xml', '/sitemap_index.xml'] as const;

function buildFetcher(timeout: number): SitemapFetcher {
  return async (url) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  };
}

async function discoverSitemapUrl(
  rootInput: string,
  fetcher: SitemapFetcher,
): Promise<string | null> {
  const root = new URL(rootInput);
  for (const path of DISCOVERY_PATHS) {
    const candidate = new URL(path, root).toString();
    try {
      await fetcher(candidate);
      return candidate;
    } catch {
      // try the next discovery path
    }
  }
  try {
    const robotsUrl = new URL('/robots.txt', root).toString();
    const robotsText = await fetcher(robotsUrl);
    const parsed = parseRobots(robotsText, robotsUrl);
    if (parsed.sitemaps.length > 0) return parsed.sitemaps[0]!;
  } catch {
    // no robots.txt or no sitemap line
  }
  return null;
}

function looksLikeSitemapUrl(u: string): boolean {
  const path = new URL(u).pathname;
  return /sitemap.*\.xml(\.gz)?$/i.test(path) || /\.xml(\.gz)?$/i.test(path);
}

export const sitemapRoutes =
  (deps: SitemapDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/sitemap',
      {
        schema: {
          description:
            'Fetch and parse an XML sitemap. Follows sitemap-index one level. Auto-discovers /sitemap.xml when given a site root.',
          tags: ['discovery'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              limit: { type: 'integer', minimum: 1, maximum: 50_000 },
              followIndex: { type: 'boolean' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = SitemapBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const limit = body.limit ?? 50_000;
        const followIndex = body.followIndex ?? true;
        const timeout = body.timeoutMs ?? deps.config.sitemapTimeoutMs;
        const fetcher = buildFetcher(timeout);

        let sitemapUrl = body.url;
        if (!looksLikeSitemapUrl(body.url)) {
          const discovered = await discoverSitemapUrl(body.url, fetcher);
          if (!discovered) {
            return reply.code(404).send({
              error: 'no_sitemap_found',
              message: 'No sitemap at common paths or in robots.txt',
            });
          }
          sitemapUrl = discovered;
        }

        try {
          const result = await resolveSitemap(sitemapUrl, fetcher, { limit, followIndex });
          return {
            url: body.url,
            finalUrl: sitemapUrl,
            ...result,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'sitemap fetch failed');
          if (err instanceof Error && err.name === 'AbortError') {
            return reply.code(504).send({ error: 'timeout', message: `Exceeded ${timeout}ms` });
          }
          return reply.code(502).send({
            error: 'fetch_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  };
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 3.7: Register the route

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Import**

```ts
import { sitemapRoutes } from './routes/sitemap.js';
```

- [ ] **Step 2: Register after robots routes**

```ts
  await app.register(sitemapRoutes({ config }));
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Local smoke**

`pnpm dev`, then:

```
curl -sS -X POST http://localhost:8080/v1/sitemap \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"url":"https://www.google.com/sitemap.xml","limit":50}' | jq '.urlCount, .truncated'
```

Expected: A URL count and `truncated: true` if there are more than 50 URLs.

- [ ] **Step 5: Commit Phase 3**

```
git add src/routes/sitemap.ts src/server.ts
git commit -m "feat(sitemap): add POST /v1/sitemap with index resolution and auto-discovery"
```

Phase 3 ship checkpoint — `/v1/sitemap` live.
