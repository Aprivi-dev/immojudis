import { defineConfig, devices } from "@playwright/test";

const baseURL = "https://127.0.0.1:3100";

// Each test starts as a visitor who has already answered the cookie banner (refusal, so Google
// Analytics stays off): the fixed banner would otherwise cover the buttons the journeys click.
// Same key and shape as src/lib/analytics-consent.ts; the date is fresh at every run, so the
// choice is never older than its 6-month validity.
const answeredCookieBanner = {
  cookies: [],
  origins: [
    {
      origin: baseURL,
      localStorage: [
        {
          name: "immojudis:analytics-consent",
          value: JSON.stringify({ choice: "denied", at: new Date().toISOString() }),
        },
      ],
    },
  ],
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    storageState: answeredCookieBanner,
    // The local test server uses a disposable self-signed loopback certificate.
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "desktop-webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "npm run build && node scripts/start-e2e-server.mjs",
    url: baseURL,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "https://ci.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "ci-publishable-key",
      // Keep the paid-flow E2E build legally complete without importing
      // production publisher data into CI or the test bundle.
      NEXT_PUBLIC_LEGAL_ENTITY_NAME: "ImmoJudis E2E",
      NEXT_PUBLIC_LEGAL_ENTITY_FORM: "SAS E2E",
      NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue du Test, 75000 Paris",
      NEXT_PUBLIC_LEGAL_REGISTRATION: "RCS E2E",
      NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR: "Direction E2E",
      NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "e2e@example.test",
      NEXT_PUBLIC_LEGAL_CONTACT_PHONE: "+33 1 00 00 00 00",
      NEXT_PUBLIC_LEGAL_MEDIATOR_NAME: "Médiateur E2E",
      NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS: "1 rue du Test, 75000 Paris",
      NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE: "https://example.test/mediator",
    },
  },
});
