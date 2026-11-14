import { expect, test, type Page } from "@playwright/test";

const SUPABASE_URL = "https://ci.supabase.co";
const AUTH_STORAGE_KEY = "encheres-immo-auth";
const adminId = "76000000-0000-4000-8000-000000000099";
const clientId = "76000000-0000-4000-8000-000000000100";
const referralId = "76000000-0000-4000-8000-000000000101";
const lawyerId = "76000000-0000-4000-8000-000000000102";
const privacyRequestId = "76000000-0000-4000-8000-000000000103";
const publicationRequestId = "76000000-0000-4000-8000-000000000104";
const adminEmail = "admin.e2e@example.test";

type ManagementState = {
  subscriptionPayloads: Array<Record<string, unknown>>;
  lawyerPayloads: Array<Record<string, unknown>>;
  referralPayloads: Array<Record<string, unknown>>;
  privacyPayloads: Array<Record<string, unknown>>;
  publicationPayloads: Array<Record<string, unknown>>;
  /** Chemins des GET /api/admin/* reçus, dans l'ordre (chaque vue ne charge que les siens). */
  adminGetPaths: string[];
  subscriptionGranted: boolean;
  lawyerSaved: boolean;
  referralStatus: "manual_review" | "sent_to_lawyer";
  privacyStatus: "received" | "completed";
  publicationStatus: "pending" | "approved";
  /** Offre Analyse (`/api/billing/offer`) : ouverte, fermée ou illisible (erreur 503). */
  offer: "open" | "closed" | "error";
};

test.describe("admin management", () => {
  test("grants a client plan and sends the expected manual payload", async ({ page }) => {
    const state = await prepareAdminManagementPage(page);

    // Ancienne adresse : redirigée vers l'onglet « Clients & abonnements » de la vue Comptes.
    await page.goto("/admin/clients");
    await expect(page).toHaveURL(/\/admin\/comptes\?onglet=clients$/);
    await expect(page.getByRole("heading", { level: 1, name: "Comptes" })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Clients & abonnements", selected: true }),
    ).toBeVisible();
    await page.getByLabel("Email ou UUID utilisateur").fill("client.e2e@example.test");
    await page.getByLabel("Plan").selectOption("analyse");
    await page.getByLabel("Statut").selectOption("active");
    await page.getByRole("button", { name: "Attribuer le plan" }).click();

    await expect.poll(() => state.subscriptionPayloads.length).toBe(1);
    expect(state.subscriptionPayloads[0]).toMatchObject({
      target: "client.e2e@example.test",
      planCode: "analyse",
      status: "active",
    });
    await expect(page.getByText("analyse", { exact: false }).first()).toBeVisible();
  });

  test("updates a referral and saves an eligible referenced lawyer", async ({ page }) => {
    const state = await prepareAdminManagementPage(page);

    await page.goto("/admin/lawyers");
    await expect(page.getByRole("heading", { name: "Suivi des mises en relation" })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Statut", exact: true })
      .selectOption("sent_to_lawyer");
    await page
      .getByRole("combobox", { name: "Avocat référencé", exact: true })
      .selectOption(lawyerId);
    await page.getByRole("button", { name: "Sauvegarder", exact: true }).click();

    await expect.poll(() => state.referralPayloads.length).toBe(1);
    expect(state.referralPayloads[0]).toMatchObject({
      id: referralId,
      status: "sent_to_lawyer",
      requestedLawyerId: lawyerId,
    });

    // Aucun avocat référencé : le réseau et le relevé sont repliés, joignables par un bouton.
    await expect(page.getByRole("tab", { name: "Réseau référencé" })).toHaveCount(0);
    await page.getByRole("button", { name: "Référencer un avocat" }).click();
    await expect(page.getByRole("tab", { name: "Réseau référencé", selected: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mise en relation avocat" })).toBeVisible();
    await page.getByLabel("Nom affiché", { exact: true }).fill("Me E2E Référencé");
    await page.getByRole("combobox", { name: "Statut fiche", exact: true }).selectOption("active");
    await page
      .getByRole("combobox", { name: "Placement payant", exact: true })
      .selectOption("active");
    await page.getByRole("textbox", { name: "Tribunal", exact: true }).fill("TGI-75");
    await page.getByRole("button", { name: "Créer", exact: true }).click();

    await expect.poll(() => state.lawyerPayloads.length).toBe(1);
    expect(state.lawyerPayloads[0]).toMatchObject({
      displayName: "Me E2E Référencé",
      status: "active",
      paidPlacementStatus: "active",
      acceptsJudicialAuctions: true,
      coverage: [{ tribunalCode: "TGI-75" }],
    });
  });

  test("closes a privacy request with an explicit resolution code", async ({ page }) => {
    const state = await prepareAdminManagementPage(page);

    await page.goto("/admin/compliance");
    await expect(
      page.getByRole("heading", { name: "Demandes RGPD et rétractations" }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "Statut", exact: true }).selectOption("completed");
    await page.getByRole("textbox", { name: /^Code de résolution/ }).fill("access_copy_delivered");
    await page.getByRole("button", { name: "Enregistrer le traitement" }).click();

    await expect.poll(() => state.privacyPayloads.length).toBe(1);
    expect(state.privacyPayloads[0]).toMatchObject({
      requestId: privacyRequestId,
      status: "completed",
      resolutionCode: "access_copy_delivered",
    });
  });

  test("approves a professional publication and keeps the linked sale id", async ({ page }) => {
    const state = await prepareAdminManagementPage(page);

    await page.goto("/admin/publications");
    await expect(page.getByRole("heading", { name: "File de validation" })).toBeVisible();
    await page.getByRole("button", { name: "Valider" }).click();

    await expect.poll(() => state.publicationPayloads.length).toBe(1);
    expect(state.publicationPayloads[0]).toEqual({
      id: publicationRequestId,
      status: "approved",
    });
    await expect(page.getByText("Validée", { exact: true })).toBeVisible();
  });

  test("loads only its own data on every management view", async ({ page }) => {
    const state = await prepareAdminManagementPage(page);
    const own: Array<[string, string[]]> = [
      // L'onglet Clients porte aussi l'interrupteur de l'essai gratuit et, offre ouverte, la liste
      // d'attente. L'onglet Inscriptions lit ses comptes en POST : aucune lecture GET des clients.
      [
        "/admin/comptes?onglet=clients",
        [
          "/api/admin/launch-offer",
          "/api/admin/offer-opening-notifier",
          "/api/admin/subscriptions",
        ],
      ],
      ["/admin/comptes", []],
      // La liste des avocats référencés décide de l'affichage des onglets Réseau et Relevé.
      ["/admin/lawyers", ["/api/admin/lawyer-referrals", "/api/admin/lawyers"]],
      ["/admin/compliance", ["/api/admin/privacy-requests"]],
      ["/admin/publications", ["/api/admin/publications"]],
    ];
    for (const [url, expected] of own) {
      state.adminGetPaths.length = 0;
      await page.goto(url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect([...new Set(state.adminGetPaths)].sort()).toEqual([...expected].sort());
    }
  });

  test("keeps /admin/inscriptions and scrolls the sign-up table inside its frame", async ({
    page,
  }, testInfo) => {
    await prepareAdminManagementPage(page);

    await page.goto("/admin/inscriptions");
    await expect(page).toHaveURL(/\/admin\/comptes\?onglet=inscriptions$/);
    await expect(page.getByRole("tab", { name: "Inscriptions", selected: true })).toBeVisible();
    const table = page.getByRole("table", { name: "Comptes inscrits sur Immojudis" });
    await expect(table.getByText("Camille Durand-Lemoine")).toBeVisible();
    // La page ne défile plus en largeur : seul le cadre du tableau défile sur téléphone.
    const pageSizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(pageSizes.scroll).toBeLessThanOrEqual(pageSizes.client);
    if (testInfo.project.name.includes("mobile")) {
      const frame = await table.evaluate((element) => ({
        scroll: element.parentElement!.scrollWidth,
        client: element.parentElement!.clientWidth,
      }));
      expect(frame.scroll).toBeGreaterThan(frame.client);
    }
  });

  test("hides the waiting-list mailing until the Analyse subscription opens", async ({ page }) => {
    const state = await prepareAdminManagementPage(page, { offer: "closed" });

    await page.goto("/admin/comptes?onglet=clients");
    await expect(
      page.getByRole("heading", { name: "Attribution manuelle des plans" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Prévenir la liste d’attente" })).toHaveCount(0);
    expect(state.adminGetPaths).not.toContain("/api/admin/offer-opening-notifier");
  });

  test("says why the waiting list is hidden when the offer cannot be read, and retries", async ({
    page,
  }) => {
    const state = await prepareAdminManagementPage(page, { offer: "error" });

    await page.goto("/admin/comptes?onglet=clients");
    const alert = page.getByRole("alert").filter({ hasText: "L’état de l’offre Analyse" });
    await expect(alert).toBeVisible();
    await expect(page.getByRole("heading", { name: "Prévenir la liste d’attente" })).toHaveCount(0);

    state.offer = "open";
    await alert.getByRole("button", { name: "Réessayer" }).click();
    await expect(page.getByRole("heading", { name: "Prévenir la liste d’attente" })).toBeVisible();
  });

  test("shows the pepites as a Quality tab, emergency stop in view", async ({ page }) => {
    const state = await prepareAdminManagementPage(page);

    await page.goto("/admin/pepites");
    await expect(page).toHaveURL(/\/admin\/quality\?onglet=pepites$/);
    await expect(page.getByRole("tab", { name: "Pépites", selected: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Mode : Ouvert" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspendre les pépites" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    // L'onglet Pépites ne charge pas les indicateurs de qualité.
    expect(state.adminGetPaths).not.toContain("/api/admin/data-quality");
  });

  test("lists ten views and reaches account security under the admin address", async ({
    page,
  }, testInfo) => {
    await prepareAdminManagementPage(page);
    await page.goto("/admin/compliance");
    await expect(page.getByRole("heading", { level: 1, name: "Conformité" })).toBeVisible();

    if (testInfo.project.name.includes("mobile")) {
      await page.getByRole("button", { name: "Ouvrir la navigation administrateur" }).click();
    }
    const menu = page.getByRole("navigation", { name: "Navigation administrateur" });
    await expect(menu.getByRole("link")).toHaveText([
      "Vue d’ensemble",
      "Opérations",
      "Agent IA",
      "Emails",
      "Qualité des données",
      "Comptes",
      "Pilotage",
      "Avocats",
      "Conformité",
      "Configuration",
    ]);
    await page.getByRole("link", { name: "Sécurité du compte" }).click();

    await expect(page).toHaveURL(/\/admin\/securite$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sécurité du compte" })).toBeVisible();
    // Le jeton factice du test fait échouer la lecture des facteurs : une erreur lisible remplace le
    // « Chargement… » sans fin, avec un bouton pour réessayer.
    const alert = page.getByRole("alert").filter({ hasText: "n’a pas pu être lu" });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("button", { name: "Réessayer" })).toBeVisible();
    await expect(page.getByText("Chargement…", { exact: true })).toHaveCount(0);
  });
});

async function prepareAdminManagementPage(
  page: Page,
  { offer = "open" }: { offer?: ManagementState["offer"] } = {},
): Promise<ManagementState> {
  const state: ManagementState = {
    subscriptionPayloads: [],
    lawyerPayloads: [],
    referralPayloads: [],
    privacyPayloads: [],
    publicationPayloads: [],
    adminGetPaths: [],
    subscriptionGranted: false,
    lawyerSaved: false,
    referralStatus: "manual_review",
    privacyStatus: "received",
    publicationStatus: "pending",
    offer,
  };
  const session = createSession();

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
            email: adminEmail,
            full_name: "Administrateur E2E",
            account_type: "b2c",
            account_tier: "premium",
            user_role: "admin",
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

  // Offre Analyse ouverte (prix configuré) : condition d'affichage de « Prévenir la liste d'attente ».
  await page.route("**/api/billing/offer", (route) =>
    state.offer === "error"
      ? route.fulfill({ status: 503, json: { error: "Offre indisponible" } })
      : route.fulfill({
          json: {
            configured: state.offer === "open",
            trialDays: 7,
            trialAvailable: false,
            label: "59 € / mois",
          },
        }),
  );

  await page.route("**/api/admin/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method === "GET") state.adminGetPaths.push(path);

    if (path === "/api/admin/subscriptions" && method === "GET") {
      await route.fulfill({ status: 200, json: subscriptionsPayload(state) });
      return;
    }
    if (path === "/api/admin/subscriptions" && method === "POST") {
      state.subscriptionPayloads.push(route.request().postDataJSON() as Record<string, unknown>);
      state.subscriptionGranted = true;
      await route.fulfill({
        status: 200,
        json: {
          subscription: subscriptionSummary(),
          resolvedUser: { id: clientId, email: "client.e2e@example.test" },
        },
      });
      return;
    }

    if (path === "/api/admin/lawyer-referrals" && method === "GET") {
      await route.fulfill({ status: 200, json: referralPayload(state) });
      return;
    }
    if (path === "/api/admin/lawyer-referrals" && method === "PATCH") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      state.referralPayloads.push(payload);
      state.referralStatus = "sent_to_lawyer";
      await route.fulfill({
        status: 200,
        json: { request: referralSummary(state) },
      });
      return;
    }

    if (path === "/api/admin/lawyers" && method === "GET") {
      await route.fulfill({
        status: 200,
        json: { lawyers: state.lawyerSaved ? [lawyerSummary()] : [] },
      });
      return;
    }
    if (path === "/api/admin/lawyers" && method === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      state.lawyerPayloads.push(payload);
      state.lawyerSaved = true;
      await route.fulfill({ status: 200, json: { lawyer: lawyerSummary(payload) } });
      return;
    }

    if (path === "/api/admin/privacy-requests" && method === "GET") {
      await route.fulfill({ status: 200, json: privacyPayload(state) });
      return;
    }
    if (path === "/api/admin/privacy-requests" && method === "PATCH") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      state.privacyPayloads.push(payload);
      state.privacyStatus = "completed";
      await route.fulfill({ status: 200, json: privacySummary(state) });
      return;
    }

    if (path === "/api/admin/publications" && method === "GET") {
      await route.fulfill({ status: 200, json: publicationPayload(state) });
      return;
    }
    if (path === "/api/admin/publications" && method === "PATCH") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      state.publicationPayloads.push(payload);
      state.publicationStatus = "approved";
      await route.fulfill({
        status: 200,
        json: {
          request: publicationRequest(state),
          publishedSaleId: "76000000-0000-4000-8000-000000000105",
        },
      });
      return;
    }

    if (path === "/api/admin/launch-offer" && method === "GET") {
      await route.fulfill({ status: 200, json: { active: true } });
      return;
    }

    if (path === "/api/admin/offer-opening-notifier" && method === "GET") {
      await route.fulfill({ status: 200, json: offerOpeningAudiencePayload() });
      return;
    }

    if (path === "/api/admin/readiness") {
      await route.fulfill({ status: 200, json: readinessPayload() });
      return;
    }

    if (path === "/api/admin/signups/search") {
      await route.fulfill({ status: 200, json: signupsPayload() });
      return;
    }

    if (path === "/api/admin/pepites" && method === "GET") {
      await route.fulfill({ status: 200, json: pepitesPayload() });
      return;
    }

    if (path === "/api/admin/sale-feedback") {
      await route.fulfill({
        status: 200,
        json: { generatedAt: null, windowDays: 90, rows: [], measured: true },
      });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });

  return state;
}

function signupsPayload() {
  return {
    accounts: [
      {
        userId: "76000000-0000-4000-8000-000000000201",
        email: "investisseur.avec.une.adresse.longue@example.test",
        fullName: "Camille Durand-Lemoine",
        accountType: "b2c",
        createdAt: "2026-11-01T10:00:00.000Z",
        emailConfirmedAt: "2026-11-01T10:05:00.000Z",
        lastSignInAt: "2026-11-13T10:00:00.000Z",
        access: "trial",
        accessEndsAt: "2026-11-08T10:00:00.000Z",
        trialEndsAt: "2026-11-08T10:00:00.000Z",
        extendable: true,
        usage: { unlocks: 0, ceilings: 0, favorites: 0, sheetsServed: 0 },
      },
    ],
    summary: {
      total: 1,
      confirmed: 1,
      last7Days: 1,
      last30Days: 1,
      byAccess: {
        trial: 1,
        trial_extended: 0,
        analyse_paid: 0,
        analyse_manual: 0,
        premium: 0,
        decouverte: 0,
      },
      trialEndedIdle: 0,
    },
    launchOfferActive: true,
    truncated: false,
    usageAvailable: true,
    generatedAt: "2026-11-14T07:00:00.000Z",
    offset: 0,
    limit: 50,
    total: 1,
    hasMore: false,
  };
}

function pepitesPayload() {
  return {
    canSuspend: true,
    sections: [
      {
        id: "mode",
        title: "Mode : Ouvert",
        paragraphs: ["Les pépites sont publiques. Règle pepite-v1.1."],
        alert: null,
        table: null,
      },
    ],
  };
}

function subscriptionsPayload(state: ManagementState) {
  return {
    subscriptions: state.subscriptionGranted ? [subscriptionSummary()] : [],
    total: state.subscriptionGranted ? 1 : 0,
    activeCount: state.subscriptionGranted ? 1 : 0,
    truncated: false,
    offset: 0,
    limit: 50,
    hasMore: false,
  };
}

function subscriptionSummary() {
  return {
    userId: clientId,
    email: "client.e2e@example.test",
    planCode: "analyse",
    status: "active",
    currentPeriodEnd: "2026-10-30T00:00:00.000Z",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    metadata: {},
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
  };
}

function referralPayload(state: ManagementState) {
  return {
    requests: [referralSummary(state)],
    lawyers: [lawyerOption()],
    total: 1,
    openCount: state.referralStatus === "manual_review" ? 1 : 0,
    truncated: false,
    offset: 0,
    limit: 50,
    hasMore: false,
  };
}

function referralSummary(state: ManagementState) {
  return {
    id: referralId,
    status: state.referralStatus,
    matchingStatus: "matched",
    requestedLawyerId: lawyerId,
    requestedLawyer: lawyerOption(),
    requesterEmail: "buyer.e2e@example.test",
    requesterId: clientId,
    saleId: "76000000-0000-4000-8000-000000000106",
    sale: {
      id: "76000000-0000-4000-8000-000000000106",
      title: "Appartement E2E",
      city: "Paris",
      department: "75",
      tribunal: "Tribunal judiciaire de Paris",
      tribunalCode: "TGI-75",
      saleDate: "2030-06-01T00:00:00.000Z",
      startingPriceEur: 100000,
    },
    preferredContactMethod: "email",
    phone: null,
    message: "Besoin d'un accompagnement.",
    financingReady: true,
    maxBidEur: 120000,
    adminNotes: null,
    emailDelivery: null,
    assignedAt: "2026-09-19T09:00:00.000Z",
    sentAt: state.referralStatus === "sent_to_lawyer" ? "2026-09-19T10:00:00.000Z" : null,
    respondedAt: null,
    createdAt: "2026-09-19T08:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
  };
}

function lawyerOption() {
  return {
    id: lawyerId,
    displayName: "Me E2E Référencé",
    firmName: "Cabinet E2E",
    barAssociation: "Paris",
    city: "Paris",
    department: "75",
  };
}

function lawyerSummary(payload?: Record<string, unknown>) {
  const displayName =
    typeof payload?.displayName === "string" ? payload.displayName : "Me E2E Référencé";
  const coverage = Array.isArray(payload?.coverage)
    ? payload.coverage.map((item) => ({
        id: "76000000-0000-4000-8000-000000000107",
        tribunalCode: (item as Record<string, unknown>).tribunalCode ?? null,
        tribunalName: (item as Record<string, unknown>).tribunalName ?? null,
        city: (item as Record<string, unknown>).city ?? null,
        department: (item as Record<string, unknown>).department ?? null,
        postalCodePrefix: (item as Record<string, unknown>).postalCodePrefix ?? null,
      }))
    : [{ id: "76000000-0000-4000-8000-000000000107", tribunalCode: "TGI-75" }];
  return {
    id: lawyerId,
    status: payload?.status ?? "active",
    paidPlacementStatus: payload?.paidPlacementStatus ?? "active",
    displayName,
    firmName: "Cabinet E2E",
    email: "avocat.e2e@example.test",
    phone: null,
    websiteUrl: null,
    barAssociation: "Paris",
    barNumber: null,
    city: "Paris",
    department: "75",
    address: null,
    profileSummary: null,
    practiceTags: ["adjudication"],
    acceptsJudicialAuctions: true,
    acceptsRemoteContact: true,
    priorityWeight: 10,
    paidPlacementStartsAt: null,
    paidPlacementEndsAt: null,
    placementMetrics: {
      periodStart: "2026-08-20T00:00:00.000Z",
      impressions: 1,
      ctaClicks: 1,
      referralRequests: 1,
    },
    coverage,
    createdAt: "2026-09-19T08:00:00.000Z",
    updatedAt: "2026-09-19T10:00:00.000Z",
  };
}

function privacyPayload(state: ManagementState) {
  return {
    requests: [privacySummary(state)],
    total: 1,
    openCount: state.privacyStatus === "received" ? 1 : 0,
    overdueCount: 0,
    truncated: false,
    offset: 0,
    limit: 100,
    hasMore: false,
  };
}

function privacySummary(state: ManagementState) {
  return {
    id: privacyRequestId,
    requestType: "access",
    status: state.privacyStatus,
    identityStatus: "authenticated",
    requesterEmail: "buyer.e2e@example.test",
    userId: clientId,
    message: "Copie de mes données.",
    submittedAt: "2026-09-19T08:00:00.000Z",
    acknowledgedAt: "2026-09-19T08:00:00.000Z",
    dueAt: "2026-10-19T08:00:00.000Z",
    completedAt: state.privacyStatus === "completed" ? "2026-09-19T10:00:00.000Z" : null,
    resolutionCode: state.privacyStatus === "completed" ? "access_copy_delivered" : null,
    operatorNotes: null,
  };
}

function publicationPayload(state: ManagementState) {
  return {
    requests: [publicationRequest(state)],
    total: 1,
    pendingCount: state.publicationStatus === "pending" ? 1 : 0,
    offset: 0,
    limit: 30,
    hasMore: false,
  };
}

function publicationRequest(state: ManagementState) {
  return {
    id: publicationRequestId,
    requester_id: clientId,
    requester_email: "pro.e2e@example.test",
    status: state.publicationStatus,
    title: "Maison E2E",
    description: "Publication de test.",
    location: "75001 Paris",
    court: "Tribunal judiciaire de Paris",
    hearing_date: "2030-06-01",
    starting_price_eur: 100000,
    document_types: ["cahier_des_conditions"],
    submitted_documents: [],
    anonymize_documents: true,
    promotion_options: [],
    published_sale_id:
      state.publicationStatus === "approved" ? "76000000-0000-4000-8000-000000000105" : null,
    published_at: state.publicationStatus === "approved" ? "2026-09-19T10:00:00.000Z" : null,
    created_at: "2026-09-19T08:00:00.000Z",
    updated_at: "2026-09-19T10:00:00.000Z",
    reviewed_at: state.publicationStatus === "approved" ? "2026-09-19T10:00:00.000Z" : null,
    reviewed_by: state.publicationStatus === "approved" ? adminId : null,
  };
}

function offerOpeningAudiencePayload() {
  return {
    recipients: 2,
    needsReview: 0,
    alreadyNotified: 1,
    batchSize: 200,
    configured: true,
    missing: [],
    preview: { subject: "L'offre Analyse est ouverte", text: "Aperçu du message E2E." },
  };
}

function readinessPayload() {
  return {
    checkedAt: "2026-09-19T10:00:00.000Z",
    status: "ready",
    items: [],
    migrations: {
      status: "ready",
      expectedLatestVersion: "20261003170000",
      latestAppliedVersion: "20261003170000",
      appliedCount: 10,
      detail: "CI",
    },
    operations: {
      status: "ready",
      schedulerActive: true,
      schedulerSchedule: "*/15 * * * *",
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

function createSession() {
  const user = {
    id: adminId,
    aud: "authenticated",
    role: "authenticated",
    email: adminEmail,
    email_confirmed_at: "2026-09-19T09:00:00.000Z",
    created_at: "2026-09-19T09:00:00.000Z",
    updated_at: "2026-09-19T09:00:00.000Z",
    app_metadata: { provider: "email", providers: ["email"], role: "admin" },
    user_metadata: { account_type: "b2c", full_name: "Administrateur E2E" },
  };
  return {
    access_token: fakeJwt({ sub: adminId, email: adminEmail, role: "authenticated" }),
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
