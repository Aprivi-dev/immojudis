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
};

test.describe("admin management", () => {
  test("grants a client plan and sends the expected manual payload", async ({ page }) => {
    const state = await prepareAdminManagementPage(page);

    await page.goto("/admin/clients");
    await expect(page.getByRole("heading", { name: "Clients & abonnements" })).toBeVisible();
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

    await page.getByRole("button", { name: "Réseau référencé" }).click();
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
      ["/admin/clients", ["/api/admin/subscriptions"]],
      ["/admin/lawyers", ["/api/admin/lawyer-referrals"]],
      ["/admin/compliance", ["/api/admin/privacy-requests", "/api/admin/readiness"]],
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
});

async function prepareAdminManagementPage(page: Page): Promise<ManagementState> {
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

    if (path === "/api/admin/readiness") {
      await route.fulfill({ status: 200, json: readinessPayload() });
      return;
    }

    await route.fulfill({ status: 200, json: {} });
  });

  return state;
}

function subscriptionsPayload(state: ManagementState) {
  return {
    subscriptions: state.subscriptionGranted ? [subscriptionSummary()] : [],
    totalCount: state.subscriptionGranted ? 1 : 0,
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
    totalCount: 1,
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
    totalCount: 1,
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
    totalCount: 1,
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
    aiDescriptions: {
      status: "ready",
      promptVersion: "auction_llm_v10_structured_display",
      activeUpcomingCount: 1,
      coveredCurrentCount: 1,
      missingCurrentCount: 0,
      missingSourceCount: 0,
      recentFailureCount: 0,
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
