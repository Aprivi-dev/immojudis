import { expect, test, type Page } from "@playwright/test";

const SUPABASE_URL = "https://ci.supabase.co";
const AUTH_STORAGE_KEY = "encheres-immo-auth";
const adminId = "76000000-0000-4000-8000-000000000099";
const adminEmail = "admin.e2e@example.test";
const userEmail = "user.e2e@example.test";

type MockOptions = {
  admin?: boolean;
  pipelineFailures?: number;
  controlFailure?: boolean;
  dashboardPending?: boolean;
};

type MockState = {
  control: {
    enabled: boolean;
    source_details_enabled: boolean;
    max_ai_predictions_per_run: number;
    daily_ai_budget_usd: number;
    updated_at: string;
    observation_started_at: string | null;
  };
  pipelineGetCalls: number;
  controlPayloads: Array<Record<string, unknown>>;
  controlFailure: boolean;
  releaseDashboard: () => void;
};

test.describe("admin configuration", () => {
  test("loads settings, blocks invalid values, and sends the changed payload", async ({
    page,
  }, testInfo) => {
    const state = await prepareAdminPage(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/admin/settings");
    await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Collecte automatique et consommation IA" }),
    ).toBeVisible();

    const budget = page.getByRole("spinbutton", { name: "Budget IA quotidien (USD)" });
    const maxCalls = page.getByRole("spinbutton", {
      name: "Appels IA maximum par exécution",
    });
    await expect(budget).toHaveValue("5");
    await expect(maxCalls).toHaveValue("40");
    await expect(page.locator("body")).not.toBeEmpty();
    expect(await page.locator("[data-nextjs-dialog], .vite-error-overlay").count()).toBe(0);

    await page.screenshot({
      path: `/tmp/immojudis-admin-settings-${testInfo.project.name}.png`,
      fullPage: true,
    });

    await budget.fill("-1");
    await expect
      .poll(() => budget.evaluate((input) => (input as HTMLInputElement).validity.rangeUnderflow))
      .toBe(true);
    await page.getByRole("button", { name: "Enregistrer les réglages" }).click();
    await expect.poll(() => state.controlPayloads.length).toBe(0);

    await budget.fill("0");
    await page.getByLabel("Activer la planification automatique").uncheck();
    await maxCalls.fill("60");
    await page.getByRole("button", { name: "Enregistrer les réglages" }).click();

    await expect.poll(() => state.controlPayloads.length).toBe(1);
    expect(state.controlPayloads[0]).toEqual({
      enabled: false,
      daily_ai_budget_usd: 0,
      max_ai_predictions_per_run: 60,
    });
    await expect(page.getByText("Réglages enregistrés", { exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("keeps edits after a save failure and restores them with cancel", async ({ page }) => {
    const state = await prepareAdminPage(page, { controlFailure: true });
    await page.goto("/admin/settings");

    const budget = page.getByRole("spinbutton", { name: "Budget IA quotidien (USD)" });
    await expect(budget).toHaveValue("5");
    await budget.fill("12");
    await page.getByRole("button", { name: "Enregistrer les réglages" }).click();

    await expect(page.locator('p[role="alert"]')).toContainText("Serveur indisponible");
    await expect(budget).toHaveValue("12");
    await expect(page.getByText("Modifications non enregistrées", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Annuler les modifications" }).click();
    await expect(budget).toHaveValue("5");
    await expect(page.getByText("Réglages enregistrés", { exact: true })).toBeVisible();
    await expect(page.locator('p[role="alert"]')).toHaveCount(0);
  });

  test("guards tab changes while dirty and exposes source supervision after cancel", async ({
    page,
  }) => {
    await prepareAdminPage(page);
    await page.goto("/admin/settings");

    const budget = page.getByRole("spinbutton", { name: "Budget IA quotidien (USD)" });
    const sourcesTab = page.getByRole("tab", { name: "Sources de données" });
    await budget.fill("12");
    await expect(sourcesTab).toBeDisabled();
    await sourcesTab.click({ force: true });
    await expect(
      page.getByRole("heading", { name: "Collecte automatique et consommation IA" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Annuler les modifications" }).click();
    await expect(sourcesTab).toBeEnabled();
    await sourcesTab.click();
    await expect(
      page.getByRole("heading", { name: "Collecte automatique par source" }),
    ).toBeVisible();
    await expect(page.getByRole("row", { name: /test-source/ })).toBeVisible();
  });

  test("recovers from a settings loading failure with the retry action", async ({ page }) => {
    const state = await prepareAdminPage(page, { pipelineFailures: 2 });
    await page.goto("/admin/settings");

    await expect(page.locator('p[role="alert"]')).toContainText(
      "Impossible de charger les réglages",
    );
    await expect(page.getByRole("button", { name: "Réessayer", exact: true })).toBeVisible();
    expect(state.pipelineGetCalls).toBeGreaterThanOrEqual(2);

    state.controlFailure = false;
    await page.getByRole("button", { name: "Réessayer", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Collecte automatique et consommation IA" }),
    ).toBeVisible();
  });

  test("keeps overview status honest while the dashboard request is pending", async ({ page }) => {
    test.skip(test.info().project.name.includes("mobile"), "Desktop-only overview loading check");
    const state = await prepareAdminPage(page, { dashboardPending: true });
    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "Vue d’ensemble", exact: true })).toBeVisible();
    await expect(page.getByText("Aucun échec récent détecté", { exact: true })).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toContain("Vérifié à l’instant");

    state.releaseDashboard();
    await expect(page.getByText("Aucun échec récent détecté", { exact: true })).toBeVisible();
  });

  test("denies the settings route to a signed-in non-admin", async ({ page }) => {
    await prepareAdminPage(page, { admin: false });
    await page.goto("/admin/settings");

    await expect(page.getByRole("heading", { name: "Accès administrateur" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toHaveCount(0);
  });

  test("traps focus in mobile navigation and closes on Escape", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "Mobile-only navigation check");
    await prepareAdminPage(page);
    await page.goto("/admin/settings");

    const menuButton = page.getByRole("button", { name: "Ouvrir la navigation administrateur" });
    await menuButton.focus();
    await expect(menuButton).toBeFocused();
    await menuButton.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Navigation administrateur" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    await page.screenshot({ path: "/tmp/immojudis-admin-mobile-navigation.png", fullPage: true });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(menuButton).toBeFocused();
  });
});

async function prepareAdminPage(page: Page, options: MockOptions = {}): Promise<MockState> {
  const admin = options.admin !== false;
  const session = createSession(admin);
  const state: MockState = {
    control: {
      enabled: true,
      source_details_enabled: false,
      max_ai_predictions_per_run: 40,
      daily_ai_budget_usd: 5,
      updated_at: "2026-09-19T10:00:00.000Z",
      observation_started_at: "2026-09-19T09:00:00.000Z",
    },
    pipelineGetCalls: 0,
    controlPayloads: [],
    controlFailure: options.controlFailure ?? false,
    releaseDashboard: () => undefined,
  };
  let pipelineFailures = options.pipelineFailures ?? 0;

  await page.addInitScript(
    ({ storageKey, storedSession }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(storedSession));
    },
    { storageKey: AUTH_STORAGE_KEY, storedSession: session },
  );

  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/user") {
      await route.fulfill({ status: 200, json: { user: session.user } });
      return;
    }
    if (url.pathname === "/auth/v1/token") {
      await route.fulfill({ status: 200, json: session });
      return;
    }
    if (url.pathname === "/rest/v1/user_profiles") {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", "content-range": "0-0/1" },
        json: [
          {
            user_id: adminId,
            email: session.user.email,
            full_name: admin ? "Administrateur E2E" : "Utilisateur E2E",
            account_type: "b2c",
            account_tier: admin ? "premium" : "free",
            user_role: admin ? "admin" : "user",
            professional_role: null,
            organization_name: null,
            professional_status: "not_applicable",
            created_at: "2026-09-19T09:00:00.000Z",
            updated_at: "2026-09-19T09:00:00.000Z",
          },
        ],
      });
      return;
    }
    await route.fulfill({ status: 200, json: [] });
  });

  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === "/api/admin/pipeline" && method === "GET") {
      state.pipelineGetCalls += 1;
      if (pipelineFailures > 0) {
        pipelineFailures -= 1;
        await route.fulfill({ status: 503, json: { error: "Supervision indisponible" } });
        return;
      }
      await route.fulfill({ status: 200, json: pipelinePayload(state) });
      return;
    }

    if (path === "/api/admin/pipeline/control" && method === "PATCH") {
      const payload = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      state.controlPayloads.push(payload);
      if (state.controlFailure) {
        await route.fulfill({ status: 503, json: { error: "Serveur indisponible" } });
        return;
      }
      state.control = {
        ...state.control,
        ...payload,
        updated_at: "2026-09-19T10:01:00.000Z",
      } as MockState["control"];
      await route.fulfill({ status: 200, json: state.control });
      return;
    }

    if (path === "/api/admin/dashboard") {
      if (options.dashboardPending) {
        await new Promise<void>((resolve) => {
          state.releaseDashboard = () => resolve();
        });
      }
      await route.fulfill({ status: 200, json: dashboardPayload() });
      return;
    }

    if (path === "/api/admin/readiness") {
      await route.fulfill({ status: 200, json: readinessPayload() });
      return;
    }
    if (path === "/api/admin/subscriptions") {
      await route.fulfill({ status: 200, json: { subscriptions: [] } });
      return;
    }
    if (path === "/api/admin/lawyer-referrals") {
      await route.fulfill({ status: 200, json: { requests: [] } });
      return;
    }
    if (path === "/api/admin/privacy-requests") {
      await route.fulfill({ status: 200, json: { requests: [] } });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });

  return state;
}

function pipelinePayload(state: MockState) {
  return {
    control: state.control,
    sources: [
      {
        source_name: "test-source",
        enabled: true,
        availability: "available",
        last_inventory_complete_at: null,
        last_publication_complete_at: null,
        next_inventory_at: "2026-09-20T09:00:00.000Z",
        suspended_until: null,
        suspension_reason: null,
        last_error: null,
      },
    ],
    observations: [],
    alerts: [],
    usage: {
      ai_requests: 2,
      ai_estimated_usd: 0.25,
      ai_unpriced_requests: 0,
      daily_ai_budget_usd: state.control.daily_ai_budget_usd,
      runner_seconds: 90,
    },
  };
}

function dashboardPayload() {
  return {
    checkedAt: "2026-09-19T10:00:00.000Z",
    adminEmail,
    runner: { instantDispatchConfigured: true, mode: "webhook" },
    stats: {
      sales: 12,
      documents: 4,
      extractions: 8,
      riskOccurrences: 2,
      scoreFactors: 10,
      runs: 1,
      queuedRuns: 0,
      runningRuns: 0,
      failedRuns: 0,
      aiDescriptions: {
        expectedPromptVersion: "auction_llm_v10_structured_display",
        total: 12,
        activeOrUpcoming: 12,
        ready: 12,
        missing: 0,
        promptVersionMismatch: 0,
        backfillRemaining: 0,
      },
    },
    runs: [],
  };
}

function readinessPayload() {
  return {
    checkedAt: "2026-09-19T10:00:00.000Z",
    status: "ready",
    items: [],
    migrations: {
      status: "ready",
      expectedLatestVersion: "20260820144541",
      latestAppliedVersion: "20260820144541",
      appliedCount: 1,
      detail: "CI",
    },
    aiDescriptions: {
      status: "ready",
      promptVersion: "auction_llm_v10_structured_display",
      activeUpcomingCount: 12,
      coveredCurrentCount: 12,
      missingCurrentCount: 0,
      missingSourceCount: 0,
      recentFailureCount: 0,
      detail: "CI",
    },
    operations: {
      status: "ready",
      schedulerActive: true,
      schedulerSchedule: "CI",
      sloTargetPercent: 99.5,
      sloWindowDays: 30,
      successfulRunCount: 1,
      failedRunCount: 0,
      totalRunCount: 1,
      successRatePercent: 100,
      openAlertCount: 0,
      criticalOpenAlertCount: 0,
      pendingDeliveryCount: 0,
      failedDeliveryCount: 0,
      lastHealthRunAt: "2026-09-19T09:00:00.000Z",
      alerts: [],
      detail: "CI",
    },
    webhookUrl: null,
  };
}

function createSession(admin: boolean) {
  const email = admin ? adminEmail : userEmail;
  const user = {
    id: adminId,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: "2026-09-19T09:00:00.000Z",
    created_at: "2026-09-19T09:00:00.000Z",
    updated_at: "2026-09-19T09:00:00.000Z",
    app_metadata: { provider: "email", providers: ["email"], ...(admin ? { role: "admin" } : {}) },
    user_metadata: {
      account_type: "b2c",
      full_name: admin ? "Administrateur E2E" : "Utilisateur E2E",
    },
  };
  return {
    access_token: fakeJwt({ sub: adminId, email, role: "authenticated" }),
    refresh_token: "refresh-e2e",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  };
}

function fakeJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}
