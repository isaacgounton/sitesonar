# Track A — Phase 6: Smoke Script and Production Verification

> Index: `2026-05-18-track-a-endpoint-pack.md` — prerequisites: Phases 1–5 complete.

Goal: ship a single smoke script that exercises every Track A endpoint, run a full type/test pass, push, and verify against production.

### Task 6.1: Create the post-deploy smoke script

**Files:**
- Create: `scripts/smoke-track-a.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Smoke-test all Track A endpoints against a running Sitesonar.
# Usage: BASE=https://api.example.com KEY=ss_live_... bash scripts/smoke-track-a.sh

set -euo pipefail
BASE="${BASE:-http://localhost:8080}"
KEY="${KEY:?Set KEY=ss_live_...}"

hit() {
  local path="$1"
  local body="$2"
  echo "==> POST ${BASE}${path}"
  echo "    body: ${body}"
  curl -sS -X POST "${BASE}${path}" \
    -H "Authorization: Bearer ${KEY}" \
    -H "Content-Type: application/json" \
    -d "${body}" \
    | jq -C 'if .error then . else (with_entries(select(.key != "html" and .key != "raw" and .key != "contentHtml"))) end' \
    | head -60
  echo ""
}

echo "Smoke testing Track A endpoints against ${BASE}"

hit /v1/security '{"url":"https://github.com"}'
hit /v1/robots   '{"url":"https://www.google.com","userAgent":"Googlebot"}'
hit /v1/sitemap  '{"url":"https://www.google.com/sitemap.xml","limit":10}'
hit /v1/extract  '{"url":"https://en.wikipedia.org/wiki/Sitemaps"}'
hit /v1/tech     '{"url":"https://wordpress.org"}'

echo "All Track A endpoints responded."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/smoke-track-a.sh`

- [ ] **Step 3: Run locally**

`pnpm dev` in one terminal. In another:

```
BASE=http://localhost:8080 KEY=<local-key> bash scripts/smoke-track-a.sh
```

Expected: All 5 endpoints return successfully.

### Task 6.2: Full type + test + build pass

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 2: All tests**

Run: `pnpm test`
Expected: All vitest tests pass (security-headers: 5, robots: 4, sitemap: 6).

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: Builds cleanly into `dist/`.

### Task 6.3: Commit and push Track A

- [ ] **Step 1: Commit the smoke script**

```
git add scripts/smoke-track-a.sh
git commit -m "test: add Track A smoke script"
```

- [ ] **Step 2: Push**

```
git push origin main
```

- [ ] **Step 3: Wait for deployment, then run smoke against production**

```
BASE=https://<prod-host> KEY=<prod-key> bash scripts/smoke-track-a.sh
```

Expected: All five endpoints respond from production. Status codes 200 across the board. The augmented `/v1/audit-page` now includes a `security` block — verify with one extra call:

```
curl -sS -X POST https://<prod-host>/v1/audit-page \
  -H "Authorization: Bearer <prod-key>" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | jq '.security'
```

Track A complete. Next: open Track B (rate-limit/metering → webhooks → diffing) in a new spec/plan cycle.
