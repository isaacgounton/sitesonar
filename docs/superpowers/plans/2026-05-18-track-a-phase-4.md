# Track A — Phase 4: Extract

> Index: `2026-05-18-track-a-endpoint-pack.md` — prerequisites: Phase 3 complete.

Goal: ship `services/readability.ts` and `POST /v1/extract`. Render with Playwright, run Mozilla Readability in the page context to strip chrome, return article body + reader signals.

Note on testing: Readability needs a real browser DOM, so service-level unit tests would require JSDOM (a dep we explicitly avoided in the spec). The route is verified via local smoke against real article URLs.

### Task 4.1: Install `@mozilla/readability` and export `turndown`

**Files:**
- Modify: `package.json`
- Modify: `src/services/extract.ts`

- [ ] **Step 1: Install**

Run: `pnpm add @mozilla/readability`

- [ ] **Step 2: Export the turndown instance**

In `src/services/extract.ts`, change:

```ts
const turndown = new TurndownService({
```

to:

```ts
export const turndown = new TurndownService({
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 4.2: Add `extractTimeoutMs` to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add schema field (after `sitemapTimeoutMs`)**

```ts
  extractTimeoutMs: z.coerce.number().int().positive().default(30_000),
```

- [ ] **Step 2: Wire env var**

```ts
    extractTimeoutMs: process.env.EXTRACT_TIMEOUT_MS,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 4.3: Create `services/readability.ts`

**Files:**
- Create: `src/services/readability.ts`

- [ ] **Step 1: Write the service**

```ts
import { createRequire } from 'node:module';
import type { Page } from 'playwright';
import { turndown } from './extract.js';

const require_ = createRequire(import.meta.url);

// Resolve once at module load. The script is injected into the Playwright page.
const READABILITY_SCRIPT_PATH: string = require_.resolve(
  '@mozilla/readability/Readability.js',
);

export interface ExtractedArticle {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null;
  readingTimeMinutes: number;
  wordCount: number;
  leadImage: string | null;
  contentHtml: string;
  contentMarkdown: string;
}

export interface ExtractResult {
  article: ExtractedArticle | null;
  extractionFailed: boolean;
}

interface RawReadability {
  title: string | null;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
  lang: string | null;
  content: string;
  textContent: string;
  length: number;
  publishedTime: string | null;
  leadImage: string | null;
}

export async function extractArticle(page: Page): Promise<ExtractResult> {
  await page.addScriptTag({ path: READABILITY_SCRIPT_PATH });

  const raw = await page.evaluate((): RawReadability | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const cloned = document.cloneNode(true) as Document;
    const article = new w.Readability(cloned).parse();
    if (!article) return null;

    const publishedTime =
      document
        .querySelector('meta[property="article:published_time"]')
        ?.getAttribute('content') ??
      document.querySelector('time[datetime]')?.getAttribute('datetime') ??
      (() => {
        const ld = document.querySelector('script[type="application/ld+json"]');
        if (!ld?.textContent) return null;
        try {
          const data = JSON.parse(ld.textContent);
          const arr = Array.isArray(data) ? data : [data];
          for (const item of arr) {
            if (item?.datePublished) return item.datePublished as string;
          }
        } catch {
          // ignore malformed JSON-LD
        }
        return null;
      })() ??
      null;

    const og = document
      .querySelector('meta[property="og:image"]')
      ?.getAttribute('content');
    const leadImage =
      og ??
      (() => {
        const firstImg = document.querySelector('article img, main img, img');
        return firstImg?.getAttribute('src') ?? null;
      })();

    return {
      title: article.title ?? null,
      byline: article.byline ?? null,
      excerpt: article.excerpt ?? null,
      siteName: article.siteName ?? null,
      lang: article.lang ?? null,
      content: article.content ?? '',
      textContent: article.textContent ?? '',
      length: article.length ?? 0,
      publishedTime,
      leadImage,
    };
  });

  if (!raw) {
    return { article: null, extractionFailed: true };
  }

  const wordCount = countWords(raw.textContent);
  const readingTimeMinutes = Math.max(1, Math.round(wordCount / 200));
  const contentMarkdown = turndown.turndown(raw.content);

  return {
    article: {
      title: raw.title,
      byline: raw.byline,
      excerpt: raw.excerpt,
      siteName: raw.siteName,
      lang: raw.lang,
      publishedTime: raw.publishedTime,
      readingTimeMinutes,
      wordCount,
      leadImage: raw.leadImage,
      contentHtml: raw.content,
      contentMarkdown,
    },
    extractionFailed: false,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No errors. (If TypeScript can't find the Readability.js path, double-check the package version with `cat node_modules/@mozilla/readability/package.json` and adjust the require path. As of writing, `Readability.js` is the canonical entry script.)

### Task 4.4: Create `POST /v1/extract` route

**Files:**
- Create: `src/routes/extract.ts`

- [ ] **Step 1: Create the route**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { BrowserPool } from '../browser.js';
import type { Config } from '../config.js';
import { extractArticle } from '../services/readability.js';

const ExtractBody = z.object({
  url: z.string().url(),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
    .default('networkidle'),
  waitForSelector: z.string().optional(),
  userAgent: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  includeHtml: z.boolean().default(false),
  includeMarkdown: z.boolean().default(true),
});

interface ExtractDeps {
  browser: BrowserPool;
  config: Config;
}

export const extractRoutes =
  (deps: ExtractDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/extract',
      {
        schema: {
          description:
            'Render a URL and return the article body via Mozilla Readability, with reader signals (author, publish date, reading time).',
          tags: ['extract'],
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
              waitForSelector: { type: 'string' },
              userAgent: { type: 'string' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
              includeHtml: { type: 'boolean', default: false },
              includeMarkdown: { type: 'boolean', default: true },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = ExtractBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.extractTimeoutMs;

        const context = await deps.browser.acquire(
          body.userAgent ? { userAgent: body.userAgent } : {},
        );
        try {
          const page = await context.newPage();
          const response = await page.goto(body.url, {
            waitUntil: body.waitUntil,
            timeout,
          });
          if (body.waitForSelector) {
            await page.waitForSelector(body.waitForSelector, { timeout });
          }
          const finalUrl = page.url();
          const status = response ? response.status() : null;
          const { article, extractionFailed } = await extractArticle(page);

          const slimArticle = article
            ? {
                ...article,
                contentHtml: body.includeHtml ? article.contentHtml : '',
                contentMarkdown: body.includeMarkdown ? article.contentMarkdown : '',
              }
            : null;

          return {
            url: body.url,
            finalUrl,
            status,
            article: slimArticle,
            extractionFailed,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'extract failed');
          return reply.code(502).send({
            error: 'extract_failed',
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

### Task 4.5: Register the route and add OpenAPI tag

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Import**

```ts
import { extractRoutes } from './routes/extract.js';
```

- [ ] **Step 2: Add OpenAPI tag**

```ts
        { name: 'extract', description: 'Readability article extraction' },
```

- [ ] **Step 3: Register after sitemap routes**

```ts
  await app.register(extractRoutes({ browser, config }));
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 4.6: Local smoke

- [ ] **Step 1: Start dev server**

Run: `pnpm dev`

- [ ] **Step 2: Test against an article URL**

```
curl -sS -X POST http://localhost:8080/v1/extract \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"url":"https://en.wikipedia.org/wiki/Web_scraping"}' \
  | jq '.article | {title, byline, wordCount, readingTimeMinutes}'
```

Expected: non-null title, wordCount > 500.

- [ ] **Step 3: Test against a non-article URL**

```
curl -sS -X POST http://localhost:8080/v1/extract \
  -H "Authorization: Bearer <KEY>" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' \
  | jq '.article, .extractionFailed'
```

Expected: Either `article: null, extractionFailed: true`, OR a small article object — Readability sometimes recovers content from minimal pages, both are valid behaviors.

- [ ] **Step 4: Commit Phase 4**

```
git add src/services/extract.ts src/services/readability.ts src/routes/extract.ts src/server.ts src/config.ts package.json pnpm-lock.yaml
git commit -m "feat(extract): add POST /v1/extract with Mozilla Readability"
```

Phase 4 ship checkpoint — `/v1/extract` live.
