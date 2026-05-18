# Track A — Phase 5: Tech

> Index: `2026-05-18-track-a-endpoint-pack.md` — prerequisites: Phase 4 complete.

Goal: ship `services/tech.ts` and `POST /v1/tech`. Fingerprint the technology stack of a rendered page (CMS, frameworks, analytics, CDN, etc.).

Implementation approach: the spec called for the `webappanalyzer` fingerprint DB with an explicit fallback to a curated detection set if that package's API turns out unstable. This plan SHIPS the curated fallback by default — it's smaller, well-tested, and unblocks the endpoint immediately. Task 5.6 documents the optional follow-up to swap in the full fingerprint DB.

### Task 5.1: Add `techTimeoutMs` to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add schema field (after `extractTimeoutMs`)**

```ts
  techTimeoutMs: z.coerce.number().int().positive().default(30_000),
```

- [ ] **Step 2: Wire env var**

```ts
    techTimeoutMs: process.env.TECH_TIMEOUT_MS,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 5.2: Create the tech detection service

**Files:**
- Create: `src/services/tech.ts`

- [ ] **Step 1: Write the service**

```ts
import type { Page } from 'playwright';

export interface DetectedTechnology {
  name: string;
  version: string | null;
  categories: string[];
  confidence: number;
  website: string | null;
  icon: string | null;
}

export interface TechDetectionResult {
  technologies: DetectedTechnology[];
}

interface Artifacts {
  html: string;
  headers: Record<string, string>;
  cookies: { name: string; value: string }[];
  scripts: string[];
  metas: Record<string, string>;
  globals: string[];
}

async function collectArtifacts(page: Page): Promise<Omit<Artifacts, 'headers'>> {
  const html = await page.content();
  const context = page.context();
  const cookies = await context.cookies();
  const scripts = await page.evaluate(() =>
    Array.from(document.scripts).map((s) => s.src).filter(Boolean),
  );
  const metas = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const m of Array.from(document.querySelectorAll('meta'))) {
      const name = m.getAttribute('name') ?? m.getAttribute('property');
      const content = m.getAttribute('content');
      if (name && content) out[name] = content;
    }
    return out;
  });
  const globals = await page.evaluate(() => {
    const known = [
      'React',
      'ReactDOM',
      'Vue',
      'angular',
      'jQuery',
      '__NEXT_DATA__',
      '__NUXT__',
      'shopify',
      'Shopify',
      'dataLayer',
      'ga',
      'gtag',
      'fbq',
      '_paq',
      'Stripe',
      'Intercom',
      'Drift',
      'mixpanel',
      'amplitude',
    ];
    return known.filter(
      (g) => typeof (window as unknown as Record<string, unknown>)[g] !== 'undefined',
    );
  });
  return { html, cookies, scripts, metas, globals };
}

interface Signature {
  name: string;
  categories: string[];
  website: string;
  icon: string;
  match: (a: Artifacts) => { matched: boolean; confidence: number; version: string | null };
}

const SIGNATURES: Signature[] = [
  {
    name: 'WordPress',
    categories: ['CMS'],
    website: 'https://wordpress.org',
    icon: 'WordPress.svg',
    match: (a) => {
      const html = a.html.toLowerCase();
      if (html.includes('/wp-content/') || html.includes('wp-includes')) {
        const generator = a.metas['generator'];
        const v = generator
          ? (generator.match(/WordPress\s+([\d.]+)/i)?.[1] ?? null)
          : null;
        return { matched: true, confidence: 100, version: v };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Next.js',
    categories: ['JavaScript Framework'],
    website: 'https://nextjs.org',
    icon: 'Nextjs.svg',
    match: (a) => {
      if (a.globals.includes('__NEXT_DATA__') || a.html.includes('__NEXT_DATA__')) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'React',
    categories: ['JavaScript Framework'],
    website: 'https://react.dev',
    icon: 'React.svg',
    match: (a) => {
      if (a.globals.includes('React') || a.globals.includes('ReactDOM')) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Vue.js',
    categories: ['JavaScript Framework'],
    website: 'https://vuejs.org',
    icon: 'Vue.js.svg',
    match: (a) => {
      if (a.globals.includes('Vue') || a.globals.includes('__NUXT__')) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Shopify',
    categories: ['Ecommerce'],
    website: 'https://shopify.com',
    icon: 'Shopify.svg',
    match: (a) => {
      if (
        a.globals.includes('Shopify') ||
        a.globals.includes('shopify') ||
        a.html.includes('cdn.shopify.com')
      ) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Google Analytics',
    categories: ['Analytics'],
    website: 'https://analytics.google.com',
    icon: 'Google Analytics.svg',
    match: (a) => {
      if (
        a.globals.includes('gtag') ||
        a.globals.includes('ga') ||
        a.html.includes('google-analytics.com') ||
        a.html.includes('googletagmanager.com')
      ) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Cloudflare',
    categories: ['CDN'],
    website: 'https://cloudflare.com',
    icon: 'CloudFlare.svg',
    match: (a) => {
      const server = a.headers['server'] ?? '';
      const cfRay = a.headers['cf-ray'];
      if (cfRay || /cloudflare/i.test(server)) {
        return { matched: true, confidence: 100, version: null };
      }
      return { matched: false, confidence: 0, version: null };
    },
  },
  {
    name: 'Nginx',
    categories: ['Web Server'],
    website: 'https://nginx.org',
    icon: 'Nginx.svg',
    match: (a) => {
      const server = a.headers['server'] ?? '';
      const m = server.match(/^nginx(?:\/([\d.]+))?/i);
      if (m) return { matched: true, confidence: 100, version: m[1] ?? null };
      return { matched: false, confidence: 0, version: null };
    },
  },
];

export async function detectTech(
  page: Page,
  headers: Record<string, string>,
  categoryFilter?: string[],
): Promise<TechDetectionResult> {
  const partial = await collectArtifacts(page);
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
  const artifacts: Artifacts = { ...partial, headers: lowerHeaders };

  const techs: DetectedTechnology[] = [];
  for (const sig of SIGNATURES) {
    const r = sig.match(artifacts);
    if (!r.matched) continue;
    if (categoryFilter && !sig.categories.some((c) => categoryFilter.includes(c))) continue;
    techs.push({
      name: sig.name,
      version: r.version,
      categories: sig.categories,
      confidence: r.confidence,
      website: sig.website,
      icon: sig.icon,
    });
  }
  return { technologies: techs };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 5.3: Create `POST /v1/tech` route

**Files:**
- Create: `src/routes/tech.ts`

- [ ] **Step 1: Create the route**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { detectTech } from '../services/tech.js';

const TechBody = z.object({
  url: z.string().url(),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .default('networkidle'),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  categories: z.array(z.string()).optional(),
});

interface TechDeps {
  browser: BrowserPool;
  config: Config;
}

export const techRoutes =
  (deps: TechDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/tech',
      {
        schema: {
          description:
            'Render a URL and fingerprint the technology stack (CMS, frameworks, analytics, CDN, etc.).',
          tags: ['tech'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
                default: 'networkidle',
              },
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
              categories: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = TechBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.techTimeoutMs;

        const context = await deps.browser.acquire(
          body.userAgent ? { userAgent: body.userAgent } : {},
        );
        try {
          const page = await context.newPage();
          const response = await page.goto(body.url, { waitUntil: body.waitUntil, timeout });
          const finalUrl = page.url();
          const status = response ? response.status() : null;
          const rawHeaders: Record<string, string> = response ? response.headers() : {};

          const { technologies } = await detectTech(page, rawHeaders, body.categories);

          return {
            url: body.url,
            finalUrl,
            status,
            technologies,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'tech detection failed');
          return reply.code(502).send({
            error: 'tech_failed',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await deps.browser.release(context);
        }
      },
    );
  };
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 5.4: Register the route + `tech` OpenAPI tag

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Import**

```ts
import { techRoutes } from './routes/tech.js';
```

- [ ] **Step 2: Add OpenAPI tag**

```ts
        { name: 'tech', description: 'Technology stack fingerprinting' },
```

- [ ] **Step 3: Register after extract routes**

```ts
  await app.register(techRoutes({ browser, config }));
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 5.5: Local smoke

- [ ] **Step 1: Start dev server**

Run: `pnpm dev`

- [ ] **Step 2: Test against a known WordPress site**

```
curl -sS -X POST http://localhost:8080/v1/tech \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"url":"https://wordpress.org"}' | jq '.technologies'
```

Expected: At minimum, `WordPress` detected. Probably also `Nginx` or `Cloudflare`.

- [ ] **Step 3: Test category filter**

```
curl -sS -X POST http://localhost:8080/v1/tech \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"url":"https://wordpress.org","categories":["CMS"]}' | jq '.technologies | length'
```

Expected: 1 (only WordPress matches the CMS filter).

- [ ] **Step 4: Commit Phase 5**

```
git add src/services/tech.ts src/routes/tech.ts src/server.ts src/config.ts
git commit -m "feat(tech): add POST /v1/tech for stack fingerprinting"
```

Phase 5 ship checkpoint — `/v1/tech` live.

### Task 5.6 (optional follow-up, NOT required for Phase 5 to ship): Swap curated rules for full fingerprint DB

This task is optional and can be scheduled as a separate enhancement after Track A ships. The curated `SIGNATURES` set in Task 5.2 ships ~8 detections; the full Wappalyzer DB has thousands. Only pursue if customers ask for broader coverage.

- [ ] **Step 1: Install the fingerprint DB package**

Try: `pnpm add webappanalyzer`
If unmaintained: `pnpm add simple-wappalyzer`

- [ ] **Step 2: Read the package README**

Run: `cat node_modules/<pkg>/README.md | head -80`
Document the exact API in a comment at the top of `src/services/tech.ts`.

- [ ] **Step 3: Replace `SIGNATURES` matching with the package's analyzer**

Keep the same `DetectedTechnology` shape externally — only the matching engine changes.

- [ ] **Step 4: Add a `tech_unavailable` 503 path**

If the fingerprint DB fails to load at startup, the service should throw, and the route should return 503 with `error: 'tech_unavailable'` (per the spec). Add a `loadFingerprints()` call at module init wrapped in a try/catch that logs and sets a `isReady` flag the route checks.

- [ ] **Step 5: Re-run the smoke tests from Task 5.5**

Expected: Same detections plus many more.
