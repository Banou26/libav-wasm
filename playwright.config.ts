import { defineConfig, devices } from '@playwright/test'

// NOTE for NixOS users: playwright's bundled browsers expect libs at standard /usr/lib paths
// that don't exist on Nix. Run tests via `npm test`, which sets LD_LIBRARY_PATH from the
// system Firefox's lib closure (see package.json) so the playwright Firefox can find GTK etc.

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false, // wasm + media → one browser at a time keeps CPU sane
  forbidOnly: !!process.env.CI,
  // 1 retry locally to absorb the rare osra handshake race after several tests in a row.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  timeout: 120_000,
  use: {
    baseURL: 'http://localhost:1234',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    // WebKit is supported when the bundled browser libs are present.
    // Enable with PLAYWRIGHT_ENABLE_WEBKIT=1 once the system has the required libs.
    ...(process.env.PLAYWRIGHT_ENABLE_WEBKIT
      ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } } as const]
      : []),
  ],
  webServer: {
    command: 'npm run dev-web',
    url: 'http://localhost:1234',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
