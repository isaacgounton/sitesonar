# Track A — Phase 0: Test Framework Setup

> Index: `2026-05-18-track-a-endpoint-pack.md`

Goal: install vitest, wire test scripts, create fixture directory tree. No new endpoints yet.

### Task 0.1: Install vitest and add test script

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Modify: `tsconfig.json`

- [ ] **Step 1: Install vitest as a devDep**

Run:
```
pnpm add -D vitest@^2
```

If pnpm is not the package manager, use `npm install -D vitest@^2` or `yarn add -D vitest@^2`.

- [ ] **Step 2: Add `test` scripts to package.json**

Edit `package.json`. The `scripts` block becomes:

```json
"scripts": {
  "dev": "tsx watch --env-file-if-exists=.env src/server.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/server.js",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "vitest run --passWithNoTests",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
});
```

- [ ] **Step 4: Exclude test files from the tsc build**

Edit `tsconfig.json` — replace the `exclude` array:

```json
"exclude": ["node_modules", "dist", "src/**/*.test.ts", "test"]
```

- [ ] **Step 5: Create the test fixtures directory tree**

```
mkdir -p test/fixtures/security test/fixtures/robots test/fixtures/sitemap test/fixtures/extract test/fixtures/tech
touch test/.gitkeep
```

- [ ] **Step 6: Verify vitest is wired up**

Run: `pnpm test`
Expected: vitest runs and exits 0 with "No test files found" (the `--passWithNoTests` flag handles the empty case).

- [ ] **Step 7: Verify typecheck still passes**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 8: Commit**

```
git add package.json pnpm-lock.yaml vitest.config.ts tsconfig.json test/
git commit -m "test: add vitest scaffolding for Track A work"
```

Phase 0 ship checkpoint — test runner ready for service-level TDD in Phases 1–5.
