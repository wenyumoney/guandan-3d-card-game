import { defineConfig, devices } from '@playwright/test'

/** 生产构建验证配置：跑 vite preview 而非 dev server。 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5288',
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10_000,
    trace: 'off',
    launchOptions: {
      executablePath: 'D:/playwright-browsers/chromium-1228/chrome-win64/chrome.exe',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 5288',
    url: 'http://127.0.0.1:5288',
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
