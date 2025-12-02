import { defineConfig } from '@playwright/test';

import { baseConfig } from "../../e2e/playwright.base";

export default defineConfig({
  ...baseConfig,
  use: {
    ...baseConfig.use,
    baseURL: 'http://localhost:5173',
  },
  timeout: 30_000,
  webServer: {
    command: 'pnpm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
})