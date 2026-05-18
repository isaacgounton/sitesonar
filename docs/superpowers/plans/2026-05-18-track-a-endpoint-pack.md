# Track A — Endpoint Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five new synchronous `/v1` endpoints — `extract`, `tech`, `sitemap`, `robots`, `security` — plus a `security` block in the existing `/v1/audit-page` response.

**Architecture:** Each endpoint has a route file (Zod request validation + Fastify handler) and a service module (pure logic). Browser-rendered endpoints (`extract`, `tech`) take `BrowserPool` as a dep; HTTP-only endpoints (`sitemap`, `robots`, `security`) use plain `fetch`. Services are unit-tested against committed fixtures.

**Tech Stack:** Fastify 5, TypeScript (strict, ESM/NodeNext), Zod 4, Cheerio, Turndown. New deps: `@mozilla/readability`, `webappanalyzer`, `fast-xml-parser`, `robots-parser`, plus `vitest` as devDep.

**Source spec:** `docs/superpowers/specs/2026-05-18-track-a-endpoint-pack-design.md`

**Phase plan files (one per phase, each independently shippable):**

- Phase 0 — Test framework setup: see `2026-05-18-track-a-phase-0.md`
- Phase 1 — Security headers grading: see `2026-05-18-track-a-phase-1.md`
- Phase 2 — Robots: see `2026-05-18-track-a-phase-2.md`
- Phase 3 — Sitemap: see `2026-05-18-track-a-phase-3.md`
- Phase 4 — Extract: see `2026-05-18-track-a-phase-4.md`
- Phase 5 — Tech: see `2026-05-18-track-a-phase-5.md`
- Phase 6 — Smoke script and production verification: see `2026-05-18-track-a-phase-6.md`

## File Structure

**Files to create:**

- `vitest.config.ts` — test runner config (Phase 0)
- `test/fixtures/<endpoint>/*.{txt,xml,json,html}` — committed test inputs (Phases 1, 2, 3, 4, 5)
- `src/services/security-headers.ts` — header grading service (Phase 1)
- `src/services/robots.ts` — robots.txt parser service (Phase 2)
- `src/services/sitemap.ts` — XML sitemap parser service (Phase 3)
- `src/services/readability.ts` — article extraction service (Phase 4)
- `src/services/tech.ts` — Wappalyzer-style fingerprint matcher (Phase 5)
- `src/routes/security.ts` — POST /v1/security (Phase 1)
- `src/routes/robots.ts` — POST /v1/robots (Phase 2)
- `src/routes/sitemap.ts` — POST /v1/sitemap (Phase 3)
- `src/routes/extract.ts` — POST /v1/extract (Phase 4)
- `src/routes/tech.ts` — POST /v1/tech (Phase 5)
- `src/services/*.test.ts` — unit tests, one per service
- `scripts/smoke-track-a.sh` — post-deploy smoke (Phase 6)

**Files to modify:**

- `package.json` — add deps, `test` script
- `tsconfig.json` — exclude test files from build output
- `src/config.ts` — add timeout knobs for new endpoints
- `src/server.ts` — register new routes, add OpenAPI tags
- `src/routes/audit-page.ts` — add `security` block to response (Phase 1)
- `src/services/extract.ts` — export `turndown` instance for reuse (Phase 4)
