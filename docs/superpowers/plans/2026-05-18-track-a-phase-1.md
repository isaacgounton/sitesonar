# Track A — Phase 1: Security Headers

> Index: `2026-05-18-track-a-endpoint-pack.md` — prerequisites: Phase 0 complete.

Goal: ship `services/security-headers.ts`, `POST /v1/security`, and a `security` block in the existing `/v1/audit-page` response.

### Task 1.1: Service skeleton + first passing test (A grade)

**Files:**
- Create: `src/services/security-headers.ts`
- Create: `src/services/security-headers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/services/security-headers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { gradeHeaders } from './security-headers.js';

describe('gradeHeaders', () => {
  it('returns grade A for a fully-configured set of headers', () => {
    const result = gradeHeaders({
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'content-security-policy': "default-src 'self'; script-src 'self'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'geolocation=()',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(result.grade).toBe('A');
    expect(result.score).toBeGreaterThanOrEqual(90);
  });
});
```

- [ ] **Step 2: Confirm the test fails**

Run: `pnpm test src/services/security-headers.test.ts`
Expected: FAIL with module-not-found error.

- [ ] **Step 3: Implement the service**

Create `src/services/security-headers.ts`:

```ts
export type HeaderStatus = 'pass' | 'warn' | 'fail';

export interface HeaderCheck {
  present: boolean;
  value: string | null;
  status: HeaderStatus;
  note: string | null;
}

export interface SecurityGrade {
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  score: number;
  headers: Record<string, HeaderCheck>;
  recommendations: string[];
}

interface Rule {
  header: string;
  weight: number;
  recommendation: string;
  check: (
    value: string | null,
    allHeaders: Record<string, string>,
  ) => { status: HeaderStatus; note: string | null; awarded: number };
}

const RULES: Rule[] = [
  {
    header: 'strict-transport-security',
    weight: 20,
    recommendation: 'Add Strict-Transport-Security with max-age of at least 6 months',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      const m = value.match(/max-age=(\d+)/i);
      const maxAge = m ? parseInt(m[1]!, 10) : 0;
      const SIX_MONTHS = 60 * 60 * 24 * 180;
      if (maxAge < SIX_MONTHS) {
        return { status: 'warn', note: `max-age is ${maxAge}s, below 6 months`, awarded: 10 };
      }
      return { status: 'pass', note: null, awarded: 20 };
    },
  },
  {
    header: 'content-security-policy',
    weight: 25,
    recommendation: "Add Content-Security-Policy (at minimum: default-src 'self')",
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      const hasDefault = /\bdefault-src\b/i.test(value);
      const hasScript = /\bscript-src\b/i.test(value);
      if (!hasDefault && !hasScript) {
        return { status: 'warn', note: 'CSP missing default-src or script-src', awarded: 12 };
      }
      const scriptSrcMatch = value.match(/script-src\s+([^;]+)/i);
      const scriptSrc = scriptSrcMatch ? scriptSrcMatch[1]! : '';
      if (/'unsafe-inline'/i.test(scriptSrc)) {
        return { status: 'warn', note: "script-src contains 'unsafe-inline'", awarded: 12 };
      }
      return { status: 'pass', note: null, awarded: 25 };
    },
  },
  {
    header: 'x-frame-options',
    weight: 10,
    recommendation: 'Add X-Frame-Options: DENY (or use CSP frame-ancestors)',
    check: (value, all) => {
      const csp = all['content-security-policy'] ?? '';
      const hasFrameAncestors = /\bframe-ancestors\b/i.test(csp);
      if (!value && !hasFrameAncestors) {
        return { status: 'fail', note: 'No X-Frame-Options and no CSP frame-ancestors', awarded: 0 };
      }
      if (!value && hasFrameAncestors) {
        return { status: 'pass', note: 'Covered by CSP frame-ancestors', awarded: 10 };
      }
      const ok = /^(DENY|SAMEORIGIN)$/i.test(value!.trim());
      return ok
        ? { status: 'pass', note: null, awarded: 10 }
        : { status: 'warn', note: 'Unexpected value', awarded: 5 };
    },
  },
  {
    header: 'x-content-type-options',
    weight: 10,
    recommendation: 'Add X-Content-Type-Options: nosniff',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return /^nosniff$/i.test(value.trim())
        ? { status: 'pass', note: null, awarded: 10 }
        : { status: 'warn', note: 'Should be exactly "nosniff"', awarded: 5 };
    },
  },
  {
    header: 'referrer-policy',
    weight: 10,
    recommendation: 'Add Referrer-Policy (e.g. strict-origin-when-cross-origin)',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      if (/unsafe-url/i.test(value)) {
        return { status: 'warn', note: 'Value "unsafe-url" leaks full URLs', awarded: 5 };
      }
      return { status: 'pass', note: null, awarded: 10 };
    },
  },
  {
    header: 'permissions-policy',
    weight: 10,
    recommendation: 'Add Permissions-Policy to disable unused browser features',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return { status: 'pass', note: null, awarded: 10 };
    },
  },
  {
    header: 'cross-origin-opener-policy',
    weight: 5,
    recommendation: 'Add Cross-Origin-Opener-Policy: same-origin',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return /^same-origin$/i.test(value.trim())
        ? { status: 'pass', note: null, awarded: 5 }
        : { status: 'warn', note: 'Recommend same-origin', awarded: 2 };
    },
  },
  {
    header: 'cross-origin-resource-policy',
    weight: 5,
    recommendation: 'Add Cross-Origin-Resource-Policy: same-origin or same-site',
    check: (value) => {
      if (!value) return { status: 'fail', note: 'Header missing', awarded: 0 };
      return /^(same-origin|same-site)$/i.test(value.trim())
        ? { status: 'pass', note: null, awarded: 5 }
        : { status: 'warn', note: 'Recommend same-origin or same-site', awarded: 2 };
    },
  },
];

const INFO_LEAK_HEADERS = ['server', 'x-powered-by'] as const;

export function gradeHeaders(rawHeaders: Record<string, string>): SecurityGrade {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;

  const checks: Record<string, HeaderCheck> = {};
  const pendingRecs: { rec: string; missing: number }[] = [];
  let score = 0;

  for (const rule of RULES) {
    const value = headers[rule.header] ?? null;
    const { status, note, awarded } = rule.check(value, headers);
    score += awarded;
    checks[rule.header] = { present: value !== null, value, status, note };
    if (awarded < rule.weight) {
      pendingRecs.push({ rec: rule.recommendation, missing: rule.weight - awarded });
    }
  }

  const present = INFO_LEAK_HEADERS.filter((h) => headers[h] != null);
  let leakAwarded: number;
  let leakStatus: HeaderStatus;
  let leakNote: string | null;
  if (present.length === 0) {
    leakAwarded = 5;
    leakStatus = 'pass';
    leakNote = null;
  } else if (present.length === 1) {
    leakAwarded = 2;
    leakStatus = 'warn';
    leakNote = `${present[0]} reveals server software`;
  } else {
    leakAwarded = 0;
    leakStatus = 'fail';
    leakNote = 'Both Server and X-Powered-By reveal server software';
  }
  score += leakAwarded;
  checks['server-info-leak'] = {
    present: present.length > 0,
    value: present.map((h) => `${h}: ${headers[h]}`).join('; ') || null,
    status: leakStatus,
    note: leakNote,
  };
  if (leakAwarded < 5) {
    pendingRecs.push({
      rec: 'Remove or obfuscate Server and X-Powered-By headers',
      missing: 5 - leakAwarded,
    });
  }

  const grade: SecurityGrade['grade'] =
    score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  return {
    grade,
    score,
    headers: checks,
    recommendations: pendingRecs.sort((a, b) => b.missing - a.missing).map((r) => r.rec),
  };
}
```

- [ ] **Step 4: Run the test, confirm pass**

Run: `pnpm test src/services/security-headers.test.ts`
Expected: PASS — 1 test, grade A.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 1.2: Add tests for F grade, frame-ancestors, unsafe-inline, info-leak

**Files:**
- Modify: `src/services/security-headers.test.ts`

- [ ] **Step 1: Append four tests inside the existing `describe` block**

```ts
  it('returns grade F for empty headers', () => {
    const result = gradeHeaders({});
    expect(result.grade).toBe('F');
    expect(result.score).toBeLessThan(40);
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0]).toContain('Content-Security-Policy');
  });

  it('credits X-Frame-Options when CSP frame-ancestors is present', () => {
    const result = gradeHeaders({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    expect(result.headers['x-frame-options']!.status).toBe('pass');
    expect(result.headers['x-frame-options']!.note).toContain('frame-ancestors');
  });

  it('warns when CSP script-src contains unsafe-inline', () => {
    const result = gradeHeaders({
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'",
    });
    expect(result.headers['content-security-policy']!.status).toBe('warn');
    expect(result.headers['content-security-policy']!.note).toContain('unsafe-inline');
  });

  it('penalizes Server and X-Powered-By info leak', () => {
    const result = gradeHeaders({
      server: 'nginx/1.18.0',
      'x-powered-by': 'Express',
    });
    expect(result.headers['server-info-leak']!.status).toBe('fail');
    expect(result.recommendations.some((r) => r.includes('Server'))).toBe(true);
  });
```

- [ ] **Step 2: Run tests**

Run: `pnpm test src/services/security-headers.test.ts`
Expected: 5 tests pass.

- [ ] **Step 3: Commit the service**

```
git add src/services/security-headers.ts src/services/security-headers.test.ts
git commit -m "feat(security): add header grading service with rubric"
```

### Task 1.3: Add `securityTimeoutMs` to config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add schema field**

In `ConfigSchema` (after `searchTimeoutMs`):

```ts
  securityTimeoutMs: z.coerce.number().int().positive().default(10_000),
```

- [ ] **Step 2: Wire env var into `loadConfig`**

After `searchTimeoutMs` in the object passed to `safeParse`:

```ts
    securityTimeoutMs: process.env.SECURITY_TIMEOUT_MS,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 1.4: Create `POST /v1/security` route

**Files:**
- Create: `src/routes/security.ts`

- [ ] **Step 1: Create the route file**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { gradeHeaders } from '../services/security-headers.js';

const SecurityBody = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
});

interface SecurityDeps {
  config: Config;
}

export const securityRoutes =
  (deps: SecurityDeps): FastifyPluginAsync =>
  async (app) => {
    app.post(
      '/v1/security',
      {
        schema: {
          description:
            'Fetch a URL and grade its HTTP security headers (HSTS, CSP, etc.). No browser rendering — fast.',
          tags: ['security'],
          security: [{ bearerAuth: [] }],
          body: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
            },
          },
        },
      },
      async (req, reply) => {
        const parsed = SecurityBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
        }
        const body = parsed.data;
        const timeout = body.timeoutMs ?? deps.config.securityTimeoutMs;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          const response = await fetch(body.url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
          });
          const rawHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            rawHeaders[k.toLowerCase()] = v;
          });
          const grade = gradeHeaders(rawHeaders);
          return {
            url: body.url,
            finalUrl: response.url,
            status: response.status,
            ...grade,
            fetchedAt: new Date().toISOString(),
          };
        } catch (err) {
          req.log.warn({ err }, 'security headers fetch failed');
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

### Task 1.5: Register `/v1/security` in server

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add the import (with other route imports)**

```ts
import { securityRoutes } from './routes/security.js';
```

- [ ] **Step 2: Add the OpenAPI tag (inside the swagger `tags` array)**

```ts
        { name: 'security', description: 'HTTP security headers grading' },
```

- [ ] **Step 3: Register the plugin**

After `await app.register(searchRoutes({ config }));`:

```ts
  await app.register(securityRoutes({ config }));
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

### Task 1.6: Local smoke against `/v1/security`

- [ ] **Step 1: Start dev server**

Run: `pnpm dev`

- [ ] **Step 2: Hit example.com**

```
curl -sS -X POST http://localhost:8080/v1/security \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | jq .
```

Expected: JSON with `grade`, `score`, `headers`, `recommendations`. example.com typically grades D or F.

- [ ] **Step 3: Hit a well-configured site**

```
curl -sS -X POST http://localhost:8080/v1/security \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com"}' | jq '.grade, .score'
```

Expected: B or A.

- [ ] **Step 4: Stop dev server (Ctrl-C)**

### Task 1.7: Augment `/v1/audit-page` with `security` block

**Files:**
- Modify: `src/routes/audit-page.ts`

- [ ] **Step 1: Inspect the existing audit-page handler**

Run: `cat src/routes/audit-page.ts`

Identify (a) where the page response is captured and (b) the return statement that builds the response body.

- [ ] **Step 2: Add the import**

```ts
import { gradeHeaders, type SecurityGrade } from '../services/security-headers.js';
```

- [ ] **Step 3: Capture raw headers and grade them**

After the page response is awaited and before the return statement:

```ts
  const rawHeadersForGrading: Record<string, string> = response ? response.headers() : {};
  const security: SecurityGrade = gradeHeaders(rawHeadersForGrading);
```

- [ ] **Step 4: Add `security` to the response object**

In the final `return { ... }`, add `security,` alongside existing response fields:

```ts
  return {
    // ...existing fields...
    security,
    fetchedAt: new Date().toISOString(),
  };
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors. If the route's response schema is strict and rejects unknown properties, either add `security` to the response schema or relax it.

- [ ] **Step 6: Local smoke for the augmented audit-page**

`pnpm dev`, then:

```
curl -sS -X POST http://localhost:8080/v1/audit-page \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | jq '.security.grade, .security.score'
```

Expected: Returns a grade and score. (Lighthouse audit may take 10–30s.)

- [ ] **Step 7: Commit Phase 1**

```
git add src/config.ts src/routes/security.ts src/routes/audit-page.ts src/server.ts
git commit -m "feat(security): add POST /v1/security and security block in audit-page"
```

Phase 1 ship checkpoint — `/v1/security` is live and `/v1/audit-page` now returns a `security` block.
