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
  collectionErrors?: boolean;
  runSource?: string;
  runStatus?: string;
  /** Réponse 504 du délai de 30 s sur la section `runs` du tableau de bord. */
  dashboardTimeout?: boolean;
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
  sourceEnabled: boolean;
  sourcePayloads: Array<Record<string, unknown>>;
  scrollPayloads: Array<Record<string, unknown>>;
  runStatus: string;
  dashboardCalls: number;
  /** Sections demandées à /api/admin/dashboard, dans l'ordre. */
  dashboardSections: string[];
  /** Tous les appels GET à /api/admin/* (chemin seul), dans l'ordre. */
  adminRequests: string[];
};

test.describe("admin configuration", () => {
  test("persists scheduler and source-detail switches after a reload", async ({ page }) => {
    const state = await prepareAdminPage(page);
    await page.goto("/admin/settings");
    const scheduler = page.getByLabel("Activer la planification automatique");
    const details = page.getByLabel("Actualiser les fiches détaillées des sources");
    await scheduler.uncheck();
    await details.check();
    await page.getByRole("button", { name: "Enregistrer les réglages" }).click();
    await expect(page.getByText("Réglages enregistrés", { exact: true })).toBeVisible();
    expect(state.controlPayloads[0]).toEqual({ enabled: false, source_details_enabled: true });
    await page.reload();
    await expect(scheduler).not.toBeChecked();
    await expect(details).toBeChecked();
    await scheduler.check();
    await details.uncheck();
    await page.getByRole("button", { name: "Enregistrer les réglages" }).click();
    await expect(page.getByText("Réglages enregistrés", { exact: true })).toBeVisible();
    expect(state.controlPayloads[1]).toEqual({ enabled: true, source_details_enabled: false });
  });

  test("updates an active run without a manual refresh", async ({ page }) => {
    await page.clock.install();
    const state = await prepareAdminPage(page, { runSource: "avoventes", runStatus: "running" });
    await page.goto("/admin/operations");
    await expect(page.getByText("running", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Relancer", exact: true })).toBeDisabled();
    state.runStatus = "succeeded";
    await page.clock.fastForward(10_100);
    await expect(page.getByText("succeeded", { exact: true }).first()).toBeVisible();
    expect(state.dashboardCalls).toBeGreaterThan(1);
    await expect(page.getByRole("button", { name: "Relancer", exact: true })).toBeEnabled();
  });

  test("pauses and resumes a source independently of the global scheduler", async ({ page }) => {
    const state = await prepareAdminPage(page);
    await page.goto("/admin/settings");
    await page.getByRole("tab", { name: "Sources de données" }).click();
    const source = page.getByRole("row", { name: /test-source/ });
    await source.getByRole("button", { name: /Suspendre/ }).click();
    await expect(source.getByRole("button", { name: /Activer/ })).toBeVisible();
    expect(state.sourcePayloads).toEqual([{ source: "test-source", enabled: false }]);
    await source.getByRole("button", { name: /Activer/ }).click();
    await expect(source.getByRole("button", { name: /Suspendre/ })).toBeVisible();
    expect(state.sourceEnabled).toBe(true);
    expect(state.controlPayloads).toEqual([]);
  });

  test("launches a selected source and an integer AI batch, and preserves restart mode", async ({
    page,
  }, testInfo) => {
    const state = await prepareAdminPage(page, { runSource: "llm-description-backfill" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/admin/operations");
    await expect(page).toHaveTitle(/Opérations admin/);
    await page.getByRole("combobox", { name: "Source", exact: true }).selectOption("avoventes");
    await page.getByRole("button", { name: "Lancer", exact: true }).click();
    await expect.poll(() => state.scrollPayloads.length).toBe(1);
    expect(state.scrollPayloads[0]).toEqual({ source: "avoventes", mode: "collect" });
    await expect(page.getByText("Traitement demandé", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Relancer", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Relancer", exact: true }).click();
    await expect.poll(() => state.scrollPayloads.length).toBe(2);
    expect(state.scrollPayloads[1]).toEqual({ source: "all", mode: "llm_backfill", limit: 7 });
    await page.getByRole("button", { name: "Enrichissement IA", exact: true }).click();
    const batch = page.getByRole("spinbutton", { name: "Taille du lot" });
    await batch.fill("2.5");
    await expect(page.getByRole("button", { name: "Lancer le backfill" })).toBeDisabled();
    await batch.fill("4");
    await page.getByRole("button", { name: "Lancer le backfill" }).click();
    await expect.poll(() => state.scrollPayloads.length).toBe(3);
    expect(state.scrollPayloads[2]).toEqual({ source: "all", mode: "llm_backfill", limit: 4 });
    expect(errors).toEqual([]);
    expect(await page.locator("[data-nextjs-dialog], .vite-error-overlay").count()).toBe(0);
    await page.screenshot({
      path: `/tmp/immojudis-admin-operations-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });

  test("distinguishes publication errors, resumed collection and scoped inventory", async ({
    page,
  }, testInfo) => {
    await prepareAdminPage(page, { collectionErrors: true });
    await page.goto("/admin/settings");
    await page.getByRole("tab", { name: "Sources de données" }).click();
    await expect(page.getByRole("row", { name: /notaires/ })).toContainText(
      "Publication partielle",
    );
    await expect(page.getByRole("row", { name: /petites_affiches/ })).toContainText(
      "Collecte à reprendre",
    );
    await expect(page.getByRole("row", { name: /agrasc/ })).toContainText(
      "Catalogue accessible vérifié",
    );
    await expect(page.getByRole("row", { name: /agrasc/ })).toContainText(
      "archives sans lien exclues",
    );
    expect(await page.locator("[data-nextjs-dialog], .vite-error-overlay").count()).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("source-collection-status.png"),
      fullPage: true,
    });
  });
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

  test("keeps the overview light: one fast request and a link to every view", async ({ page }) => {
    test.skip(test.info().project.name.includes("mobile"), "Desktop-only overview check");
    const state = await prepareAdminPage(page, { runSource: "avoventes", runStatus: "succeeded" });
    await page.goto("/admin");

    await expect(page.getByRole("heading", { name: "Aucun échec récent détecté" })).toBeVisible();
    const views = page.getByRole("navigation", { name: "Vues de l’administration" });
    for (const [label, href] of [
      ["Opérations", "/admin/operations"],
      ["Agent IA", "/admin/agent-ia"],
      ["Qualité des données", "/admin/quality"],
      ["Publications", "/admin/publications"],
      ["Clients & abonnements", "/admin/clients"],
      ["Avocats", "/admin/lawyers"],
      ["Conformité", "/admin/compliance"],
      ["Configuration", "/admin/settings"],
    ]) {
      await expect(views.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
    await page.waitForLoadState("networkidle");
    expect(state.dashboardSections).toEqual(["runs"]);
    expect([...new Set(state.adminRequests)]).toEqual(["/api/admin/dashboard"]);
  });

  test("loads the AI coverage after the runs and the table counts only on the Documents tab", async ({
    page,
  }) => {
    const state = await prepareAdminPage(page, { runSource: "avoventes", runStatus: "succeeded" });
    await page.goto("/admin/operations");

    await expect(page.getByText("5 annonces à traiter")).toBeVisible();
    expect(state.dashboardSections).toContain("runs");
    expect(state.dashboardSections).toContain("ai");
    expect(state.dashboardSections).not.toContain("counts");

    await page.getByRole("button", { name: "Documents", exact: true }).click();
    await expect(page.getByText("Documents indexés")).toBeVisible();
    await expect.poll(() => state.dashboardSections.includes("counts")).toBe(true);
    await expect(page.getByText("4", { exact: true })).toBeVisible();
    expect(state.adminRequests).not.toContain("/api/admin/publications");
    expect(state.adminRequests).not.toContain("/api/admin/subscriptions");
    expect(state.adminRequests).not.toContain("/api/admin/readiness");
  });

  test("tells the administrator when a request exceeded the 30 s limit", async ({ page }) => {
    test.skip(test.info().project.name.includes("mobile"), "Desktop-only overview check");
    await prepareAdminPage(page, { dashboardTimeout: true });
    await page.goto("/admin");

    await expect(
      page.getByRole("alert").filter({ hasText: "dépassé le délai de 30 secondes" }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: "État de santé indisponible" })).toBeVisible();
    await expect(page.getByText("Aucun échec récent détecté", { exact: true })).toHaveCount(0);
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
    sourceEnabled: true,
    sourcePayloads: [],
    scrollPayloads: [],
    runStatus: options.runStatus ?? "failed",
    dashboardCalls: 0,
    dashboardSections: [],
    adminRequests: [],
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
    if (method === "GET") state.adminRequests.push(path);

    if (path === "/api/admin/pipeline" && method === "PATCH") {
      const payload = route.request().postDataJSON();
      state.sourcePayloads.push(payload);
      state.sourceEnabled = payload.enabled;
      await route.fulfill({ status: 200, json: { ok: true } });
      return;
    }
    if (path === "/api/admin/scroll" && method === "POST") {
      state.scrollPayloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          message: "Traitement demandé",
          dispatched: true,
          dispatchMode: "webhook",
        },
      });
      return;
    }

    if (path === "/api/admin/pipeline" && method === "GET") {
      state.pipelineGetCalls += 1;
      if (pipelineFailures > 0) {
        pipelineFailures -= 1;
        await route.fulfill({ status: 503, json: { error: "Supervision indisponible" } });
        return;
      }
      await route.fulfill({ status: 200, json: pipelinePayload(state, options.collectionErrors) });
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
      const section = url.searchParams.get("section") ?? "all";
      state.dashboardSections.push(section);
      if (section === "ai") {
        await route.fulfill({ status: 200, json: dashboardAiPayload(options.runSource) });
        return;
      }
      if (section === "counts") {
        await route.fulfill({ status: 200, json: dashboardCountsPayload() });
        return;
      }
      state.dashboardCalls += 1;
      if (options.dashboardTimeout) {
        await route.fulfill({
          status: 504,
          json: {
            error:
              "Cette requête admin a dépassé le délai de 30 secondes et a été interrompue. Réessayez dans un instant.",
            code: "ADMIN_TIMEOUT",
            requestId: "req-e2e-timeout",
          },
        });
        return;
      }
      if (options.dashboardPending) {
        await new Promise<void>((resolve) => {
          state.releaseDashboard = () => resolve();
        });
      }
      await route.fulfill({
        status: 200,
        json: dashboardRunsPayload(options.runSource, state.runStatus),
      });
      return;
    }
    if (path === "/api/admin/publications") {
      await route.fulfill({
        status: 200,
        json: { requests: [], totalCount: 0, pendingCount: 0, hasMore: false },
      });
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

function pipelinePayload(state: MockState, collectionErrors = false) {
  return {
    control: state.control,
    sources: [
      {
        source_name: "test-source",
        enabled: state.sourceEnabled,
        availability: "available",
        last_inventory_complete_at: null,
        last_publication_complete_at: null,
        next_inventory_at: "2026-09-20T09:00:00.000Z",
        suspended_until: null,
        suspension_reason: null,
        last_error: null,
      },
    ].flatMap((source) =>
      collectionErrors
        ? [
            {
              ...source,
              source_name: "notaires",
              last_error: "source_name is immutable",
              coverage: { publication_published: 173, publication_pending: 23 },
            },
            {
              ...source,
              source_name: "petites_affiches",
              availability: "unavailable",
              last_error: "Execution budget exceeded",
              coverage: { publication_published: 343, publication_pending: 12 },
            },
            {
              ...source,
              source_name: "agrasc",
              availability: "partial",
              coverage: { scoped_inventory_complete: true },
            },
          ]
        : [source],
    ),
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

function dashboardRunsPayload(runSource?: string, runStatus = "failed") {
  return {
    checkedAt: "2026-09-19T10:00:00.000Z",
    adminEmail,
    runner: { instantDispatchConfigured: true, mode: "webhook" },
    stats: {
      queuedRuns: 0,
      runningRuns: runSource && runStatus === "running" ? 1 : 0,
      failedRuns: 0,
    },
    runs: runSource
      ? [
          {
            id: "76000000-0000-4000-8000-000000000001",
            source: runSource,
            status: runStatus,
            useLlm: true,
            startedAt: "2026-09-19T10:00:00Z",
            finishedAt: "2026-09-19T10:02:00Z",
            createdAt: "2026-09-19T10:00:00Z",
            updatedAt: "2026-09-19T10:02:00Z",
            summary: {
              mode: runSource === "llm-description-backfill" ? "llm_backfill" : "collect",
              limit: 7,
            },
            errors: {},
          },
        ]
      : [],
  };
}

function dashboardAiPayload(runSource?: string) {
  return {
    checkedAt: "2026-09-19T10:00:00.000Z",
    aiDescriptions: {
      expectedPromptVersion: "auction_llm_v10_structured_display",
      total: 12,
      activeOrUpcoming: 12,
      ready: runSource ? 7 : 12,
      missing: runSource ? 5 : 0,
      promptVersionMismatch: 0,
      backfillRemaining: runSource ? 5 : 0,
    },
  };
}

function dashboardCountsPayload() {
  return {
    checkedAt: "2026-09-19T10:00:00.000Z",
    counts: {
      sales: 12,
      documents: 4,
      extractions: 8,
      riskOccurrences: 2,
      scoreFactors: 10,
      runs: 1,
    },
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
