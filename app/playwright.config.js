// @ts-check
import { defineConfig } from '@playwright/test';

// End-to-end smoke tests: boot the real backend (fresh in-memory DB) and the
// Vite dev server (which proxies /api to :4000), then exercise the login +
// book + accept flow across both roles.
//
// Run:   npm run test:e2e        (local; reuses already-running servers)
//        npm run test:e2e:ci     (fresh servers on ephemeral DB)
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    viewport: { width: 1280, height: 900 },
    // Locally, prefer the system Chrome so no browser download is required.
    // CI installs the Playwright Chromium build via `npx playwright install`.
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
  },
  webServer: [
    {
      command: 'node ../backend/src/server.js',
      cwd: '../backend',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        // Owner phone + JWT secret are pinned so the driver login in smoke.spec
        // is always the platform owner regardless of the dev machine's .env.
        DRIVER_PHONE: '+27000000000',
        JWT_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
        // Fresh DB per run so the smoke assertions start from a clean slate
        // (in CI an ephemeral file, locally the already-running server is used).
        DB_FILE: isCI ? ':memory:' : undefined,
      },
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});