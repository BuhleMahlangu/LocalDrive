// @ts-check
// Temporary: same as playwright.config.js but serves the PRODUCTION build via
// `vite preview` instead of the dev server. Used to isolate dev-vs-prod behavior.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig({
  ...base,
  webServer: base.webServer.map((s) =>
    s.url === 'http://localhost:5173'
      ? { ...s, command: 'npm run preview -- --port 5173 --strictPort' }
      : s,
  ),
});