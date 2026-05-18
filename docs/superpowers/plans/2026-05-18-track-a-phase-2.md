# Track A — Phase 2: Robots

> Index: `2026-05-18-track-a-endpoint-pack.md` — prerequisites: Phase 1 complete.

Goal: ship `services/robots.ts` and `POST /v1/robots`. Parse `robots.txt` into structured rules, surface sitemap URLs, support effective-user-agent resolution.

### Task 2.1: Install robots-parser

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

Run: `pnpm add robots-parser`
Expected: Installs cleanly.

### Task 2.2: Add `robotsTimeoutMs` to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add schema field**

After `securityTimeoutMs`:

```ts
  robotsTimeoutMs: z.coerce.number().int().positive().default(10_000),
```

- [ ] **Step 2: Wire env var into `loadConfig`**

```ts
    robotsTimeoutMs: process.env.ROBOTS_TIMEOUT_MS,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 2.3: Create test fixtures

**Files:**
- Create: `test/fixtures/robots/basic.txt`
- Create: `test/fixtures/robots/multi-ua.txt`

- [ ] **Step 1: Write basic.txt**

```
User-agent: *
Disallow: /admin/
Disallow: /api/
Allow: /api/public/
Crawl-delay: 1

Sitemap: https://example.com/sitemap.xml
```

- [ ] **Step 2: Write multi-ua.txt**

```
User-agent: *
Disallow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Disallow: /admin/
Crawl-delay: 5

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/news-sitemap.xml
```

### Task 2.4: Implement `parseRobots` (TDD)

**Files:**
- Create: `src/services/robots.ts`
- Create: `src/services/robots.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRobots } from './robots.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(here, '../../test/fixtures/robots', name), 'utf8');

describe('parseRobots', () => {
  it('parses basic robots.txt', () => {
    const result = parseRobots(fixture('basic.txt'), 'https://example.com/robots.txt');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.userAgent).toBe('*');
    expect(result.rules[0]!.disallow).toEqual(['/admin/', '/api/']);
    expect(result.rules[0]!.allow).toEqual(['/api/public/']);
    expect(result.rules[0]!.crawlDelay).toBe(1);
    expect(result.sitemaps).toEqual(['https://example.com/sitemap.xml']);
  });
});
```

- [ ] **Step 2: Confirm failure**

Run: `pnpm test src/services/robots.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/services/robots.ts`:

```ts
import robotsParser from 'robots-parser';

export interface RobotsRule {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface EffectiveRules {
  userAgent: string;
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface ParsedRobots {
  rules: RobotsRule[];
  sitemaps: string[];
  effectiveRules?: EffectiveRules;
  raw: string;
}

const MAX_RAW_BYTES = 100 * 1024;

export function parseRobots(
  text: string,
  url: string,
  effectiveUserAgent?: string,
): ParsedRobots {
  const raw = text.length > MAX_RAW_BYTES ? text.slice(0, MAX_RAW_BYTES) : text;

  const lines = text.split(/\r?\n/);
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  let current: RobotsRule | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value && key !== 'user-agent') continue;

    if (key === 'user-agent') {
      if (current) {
        rules.push(current);
      }
      current = { userAgent: value, allow: [], disallow: [], crawlDelay: null };
    } else if (key === 'disallow') {
      if (current) current.disallow.push(value);
    } else if (key === 'allow') {
      if (current) current.allow.push(value);
    } else if (key === 'crawl-delay') {
      const n = parseInt(value, 10);
      if (current && !Number.isNaN(n)) current.crawlDelay = n;
    } else if (key === 'sitemap') {
      sitemaps.push(value);
    }
  }
  if (current) rules.push(current);

  const result: ParsedRobots = { rules, sitemaps, raw };

  if (effectiveUserAgent) {
    const parser = robotsParser(url, text);
    const match = pickMatchingRule(rules, effectiveUserAgent);
    result.effectiveRules = {
      userAgent: effectiveUserAgent,
      allow: match?.allow ?? [],
      disallow: match?.disallow ?? [],
      crawlDelay: parser.getCrawlDelay(effectiveUserAgent) ?? null,
    };
  }

  return result;
}

function pickMatchingRule(rules: RobotsRule[], userAgent: string): RobotsRule | undefined {
  const ua = userAgent.toLowerCase();
  // RFC 9309: longest matching UA prefix wins. Wildcard '*' is the fallback.
  let best: RobotsRule | undefined;
  let bestLen = -1;
  let wildcard: RobotsRule | undefined;
  for (const r of rules) {
    const ruleUa = r.userAgent.toLowerCase();
    if (ruleUa === '*') {
      wildcard = r;
      continue;
    }
    if (ua.includes(ruleUa) && ruleUa.length > bestLen) {
      best = r;
      bestLen = ruleUa.length;
    }
  }
  return best ?? wildcard;
}
```

- [ ] **Step 4: Run the test, confirm pass**

Run: `pnpm test src/services/robots.test.ts`
Expected: PASS.

### Task 2.5: Add tests for effective-rules and multi-sitemap

**Files:**
- Modify: `src/services/robots.test.ts`

- [ ] **Step 1: Append tests**

```ts
  it('picks the matching user-agent block when effectiveUserAgent provided', () => {
    const result = parseRobots(
      fixture('multi-ua.txt'),
      'https://example.com/robots.txt',
      'Googlebot/2.1',
    );
    expect(result.effectiveRules?.userAgent).toBe('Googlebot/2.1');
    expect(result.effectiveRules?.allow).toEqual(['/']);
  });

  it('falls back to wildcard rule when no UA matches', () => {
    const result = parseRobots(
      fixture('multi-ua.txt'),
      'https://example.com/robots.txt',
      'UnknownBot/1.0',
    );
    expect(result.effectiveRules?.disallow).toEqual(['/']);
  });

  it('extracts multiple sitemap URLs', () => {
    const result = parseRobots(fixture('multi-ua.txt'), 'https://example.com/robots.txt');
    expect(result.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/news-sitemap.xml',
    ]);
  });
```

- [ ] **Step 2: Run all robots tests**

Run: `pnpm test src/services/robots.test.ts`
Expected: 4 tests pass.

- [ ] **Step 3: Commit the service**

```
git add src/services/robots.ts src/services/robots.test.ts test/fixtures/robots/ src/config.ts package.json pnpm-lock.yaml
git commit -m "feat(robots): add robots.txt parser service"
```

### Task 2.6: Create `POST /v1/robots` route

**Files:**
- Create: `src/routes/robots.ts`

- [ ] **Step 1: Create the route**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { parseRobots } from '../services/robots.js';

const RobotsBody = z.object({
  url: z.string().url(),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

interface RobotsDeps {
  config: Config;
}

function normalizeUrl(input: string): string {
  if (input.endsWith('/robots.txt')) return input;
  const u = new URL(input);
  u.pathname = '/robots.txt';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export const robotsRoutes =
  (deps: RobotsDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/robots',
      {
        schema: {
          description:
            "Fetch and parse a site's robots.txt. Returns structured rules, sitemap URLs, and optionally user-agent-resolved rules.",
          tags: ['discovery'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = RobotsBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const robotsUrl = normalizeUrl(body.url);
        const timeout = body.timeoutMs ?? deps.config.robotsTimeoutMs;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(robotsUrl, { redirect: 'follow', signal: controller.signal });
          if (response.status === 404) {
            return {
              url: robotsUrl,
              finalUrl: response.url,
              status: 404,
              rules: [],
              sitemaps: [],
              raw: '',
              fetchedAt: new Date().toISOString(),
            };
          }
          const text = await response.text();
          const result = parseRobots(text, response.url, body.userAgent);
          return {
            url: robotsUrl,
            finalUrl: response.url,
            status: response.status,
            ...result,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'robots fetch failed');
          if (err instanceof Error && err.name === 'AbortError') {
            return reply.code(504).send({ error: 'timeout', message: `Exceeded ${timeout}ms` });
          }
          return reply.code(502).send({
            error: 'fetch_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          clearTimeout(timer);
        }
      },
    );
  };
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 2.7: Register the route + `discovery` OpenAPI tag

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Import**

```ts
import { robotsRoutes } from './routes/robots.js';
```

- [ ] **Step 2: Add tag**

In the swagger `tags` array:

```ts
        { name: 'discovery', description: 'Sitemap and robots.txt parsing' },
```

- [ ] **Step 3: Register after security routes**

```ts
  await app.register(robotsRoutes({ config }));
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 5: Local smoke**

`pnpm dev`, then:

```
curl -sS -X POST http://localhost:8080/v1/robots \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","userAgent":"Googlebot/2.1"}' | jq .
```

Expected: Structured response with `rules`, `sitemaps`, `effectiveRules`. (For domains without robots.txt the response is `status: 404` with empty rules.)

- [ ] **Step 6: Commit Phase 2**

```
git add src/routes/robots.ts src/server.ts
git commit -m "feat(robots): add POST /v1/robots endpoint"
```

Phase 2 ship checkpoint — `/v1/robots` live.
