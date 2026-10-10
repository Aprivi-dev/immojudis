import { expect, test, type Page } from "@playwright/test";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  INFORMATION_AGENT_EMAIL_VARIABLES,
  renderInformationAgentEmailContent,
} from "@/lib/information-agent-email-template";

const SUPABASE_URL = "https://ci.supabase.co";
const AUTH_STORAGE_KEY = "encheres-immo-auth";
const ADMIN_ID = "76000000-0000-4000-8000-000000000099";
const SALE_ID = "00000000-0000-4000-8000-000000000001";
const CASE_ID = "00000000-0000-4000-8000-000000000002";
const MISSION_ID = "00000000-0000-4000-8000-000000000003";
const FACT_ID = "00000000-0000-4000-8000-000000000004";
const CLAIM_ID = "00000000-0000-4000-8000-000000000005";
const ASSET_ID = "00000000-0000-4000-8000-000000000006";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000007";
const REFRESH_ID = "00000000-0000-4000-8000-000000000008";
const adminEmail = "admin.e2e@example.test";

type AgentMockState = {
  events: Array<{ method: string; path: string; payload: unknown }>;
  unexpectedRequests: string[];
  mission: Record<string, unknown> | null;
  claimItems: Array<Record<string, unknown>>;
  reviewFacts: Array<Record<string, unknown>>;
  reviewAssetRights: "authorized" | "restricted";
  sourceRefresh: Record<string, unknown>;
  template: Record<string, unknown>;
};

test.describe("admin information agent", () => {
  test("opens a complete draft in one click and sends only after admin approval", async ({
    page,
  }) => {
    const state = await prepareAdminInformationAgentPage(page);

    await page.goto("/admin/agent-ia");
    await expect(page.getByRole("heading", { name: "Agent IA", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Demandes d’informations" })).toBeVisible();
    await expect(page.getByText("Aucune mission.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Ouvrir le message" }).click();
    await expect(page.getByRole("heading", { name: /Brouillon pour/ })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveValue(
      "contact@example.test",
    );
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toContainText(
      "ImmoJudis est un service indépendant",
    );
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).not.toContainText(
      "compte professionnel",
    );
    const initialDrafts = state.events.filter(
      (event) => event.path === "/api/admin/information-agent/missions" && event.method === "POST",
    );
    expect(initialDrafts.map((event) => event.payload)).toEqual([{ saleId: SALE_ID }]);
    expect(state.events.some((event) => event.method === "PATCH")).toBe(false);
    await expect(page.getByRole("button", { name: "Actualiser la source" })).toBeVisible();

    await page.getByRole("button", { name: "Actualiser la source" }).click();
    await expect(page.getByText("terminé, données disponibles", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Régénérer depuis la source actualisée" }).click();
    await expect(page.getByRole("heading", { name: /Brouillon pour/ })).toBeVisible();
    await expect(page.getByText("Brouillon", { exact: true })).toBeVisible();

    const email = page.getByRole("textbox", { name: "Email", exact: true }).last();
    await email.fill("reviewed-contact@example.test");
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Valider et envoyer" }).click();
    await expect(page.getByText("Envoyée", { exact: true })).toBeVisible();
    await expect(page.getByText("Demande envoyée.", { exact: true })).toBeVisible();

    const refreshRequest = state.events.find(
      (event) =>
        event.path === "/api/admin/information-agent/source-refresh" && event.method === "POST",
    );
    expect(refreshRequest?.payload).toEqual({ saleId: SALE_ID, force: true });
    const createRequest = state.events.find(
      (event) => event.path === "/api/admin/information-agent/missions" && event.method === "POST",
    );
    expect(createRequest?.payload).toEqual({ saleId: SALE_ID });
    const approvalRequest = state.events.find(
      (event) => event.path === "/api/admin/information-agent/missions" && event.method === "PATCH",
    );
    expect(approvalRequest?.payload).toMatchObject({
      action: "approve_and_send",
      missionId: MISSION_ID,
      approvalConfirmed: true,
      recipientEmail: "reviewed-contact@example.test",
    });
    expect(state.unexpectedRequests).toEqual([]);
  });

  test("keeps evidence and fact review guarded until rights and current values are checked", async ({
    page,
  }) => {
    const state = await prepareAdminInformationAgentPage(page);

    await page.goto("/admin/agent-ia");
    await expect(page.getByRole("heading", { name: "Informations à contrôler" })).toBeVisible();
    const reviewPanel = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Informations à contrôler" }) });
    await expect(reviewPanel.getByText(/Droits de diffusion : restreints/i)).toBeVisible();
    await expect(reviewPanel.getByRole("button", { name: "Accepter", exact: true })).toBeDisabled();

    await reviewPanel.getByRole("button", { name: "Autoriser la diffusion" }).click();
    await expect(reviewPanel.getByText(/Droits de diffusion : autorisés/i)).toBeVisible();
    await expect(reviewPanel.getByRole("button", { name: "Accepter", exact: true })).toBeEnabled();

    await reviewPanel.getByRole("button", { name: "Prévisualiser la pièce" }).click();
    await expect(reviewPanel.getByTitle("Aperçu privé de dpe.pdf")).toBeVisible();
    await reviewPanel.getByRole("button", { name: "Accepter", exact: true }).click();
    await expect(reviewPanel.getByText("dpe.pdf", { exact: true })).toHaveCount(0);

    await expect(page.getByRole("heading", { name: "Faits à vérifier" })).toBeVisible();
    const claimsPanel = page.getByRole("region", { name: "Faits à vérifier" });
    await claimsPanel.getByRole("button", { name: "Rejeter", exact: true }).click();
    await expect(claimsPanel.getByText("Motif du rejet", { exact: true })).toBeVisible();
    await claimsPanel
      .getByLabel("Justification obligatoire")
      .fill("La valeur contredit la pièce source.");
    await claimsPanel.getByRole("button", { name: "Confirmer", exact: true }).click();
    await expect(page.getByText("Aucun fait en attente de revue.", { exact: true })).toBeVisible();

    const rightsRequest = state.events.find(
      (event) =>
        event.path === `/api/admin/information-agent/evidence/${ASSET_ID}` &&
        event.method === "PATCH",
    );
    expect(rightsRequest?.payload).toEqual({
      rightsStatus: "authorized",
      notes: null,
    });
    const acceptedEvidenceRequest = state.events.find(
      (event) => event.path === "/api/admin/information-agent" && event.method === "PATCH",
    );
    expect(acceptedEvidenceRequest?.payload).toEqual({
      factId: FACT_ID,
      decision: "accepted",
      notes: null,
    });
    const rejectedClaimRequest = state.events.find(
      (event) => event.path === "/api/admin/fact-claims/review" && event.method === "POST",
    );
    expect(rejectedClaimRequest?.payload).toEqual({
      claimId: CLAIM_ID,
      decision: "rejected",
      resolutionNote: "La valeur contredit la pièce source.",
    });
    expect(state.unexpectedRequests).toEqual([]);
  });

  test("requires preview and a saved draft before publishing a template", async ({ page }) => {
    const state = await prepareAdminInformationAgentPage(page);

    await page.goto("/admin/agent-ia");
    await expect(page.getByRole("heading", { name: "Template de prise de contact" })).toBeVisible();
    const name = page.getByRole("textbox", { name: "Nom interne du modèle" });
    await name.fill("Version E2E contrôlée");
    await expect(page.getByRole("button", { name: "Enregistrer le brouillon" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Publier ce template" })).toBeDisabled();

    await page.getByRole("button", { name: "Prévisualiser", exact: true }).click();
    await expect(page.getByTitle("Prévisualisation sécurisée du template d’email")).toBeVisible();
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    await expect(page.getByText("Brouillon enregistré.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Prévisualiser", exact: true }).click();
    await expect(page.getByTitle("Prévisualisation sécurisée du template d’email")).toBeVisible();
    await page
      .getByRole("checkbox", {
        name: "J’ai vérifié l’objet, les blocs dynamiques et l’aperçu de l’email.",
      })
      .check();
    await expect(page.getByRole("button", { name: "Publier ce template" })).toBeEnabled();
    await page.getByRole("button", { name: "Publier ce template" }).click();
    await expect(page.getByText("Le nouveau template est publié.", { exact: true })).toBeVisible();
    await expect(page.getByText("Publié · v2", { exact: true })).toBeVisible();

    const previewRequest = state.events.find(
      (event) =>
        event.path === "/api/admin/information-agent/template" &&
        event.method === "POST" &&
        (event.payload as { action?: string }).action === "preview",
    );
    expect(previewRequest).toBeDefined();
    const saveRequest = state.events.find(
      (event) =>
        event.path === "/api/admin/information-agent/template" &&
        event.method === "POST" &&
        (event.payload as { action?: string }).action === "save_draft",
    );
    expect(saveRequest?.payload).toMatchObject({ action: "save_draft" });
    const publishRequest = state.events.find(
      (event) =>
        event.path === "/api/admin/information-agent/template" &&
        event.method === "POST" &&
        (event.payload as { action?: string }).action === "publish",
    );
    expect(publishRequest?.payload).toMatchObject({
      action: "publish",
      publicationConfirmed: true,
    });
    expect(state.unexpectedRequests).toEqual([]);
  });
});

async function prepareAdminInformationAgentPage(page: Page): Promise<AgentMockState> {
  const session = createSession();
  const state: AgentMockState = {
    events: [],
    unexpectedRequests: [],
    mission: null,
    claimItems: [factClaimFixture()],
    reviewFacts: [informationAgentFactFixture()],
    reviewAssetRights: "restricted",
    sourceRefresh: sourceRefreshFixture(null),
    template: templateFixture(),
  };

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
            user_id: ADMIN_ID,
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
    state.unexpectedRequests.push(`${route.request().method()} ${url.pathname}`);
    await route.fulfill({ status: 500, json: { error: "Unexpected Supabase request" } });
  });

  await page.route("**/api/admin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const payload = request.postDataJSON() ?? null;
    state.events.push({ method, path, payload });

    if (path === "/api/admin/catalogue-readiness" && method === "GET") {
      await route.fulfill({ status: 200, json: catalogueReadinessFixture() });
      return;
    }
    if (path === "/api/admin/fact-claims/review" && method === "GET") {
      await route.fulfill({
        status: 200,
        json: { ok: true, items: state.claimItems, hasMore: false, nextCursor: null },
      });
      return;
    }
    if (path === "/api/admin/fact-claims/review" && method === "POST") {
      state.claimItems = [];
      await route.fulfill({ status: 200, json: { ok: true, result: { status: "rejected" } } });
      return;
    }
    if (path === "/api/admin/information-agent/missions" && method === "GET") {
      await route.fulfill({
        status: 200,
        json: { ok: true, missions: state.mission ? [state.mission] : [], facts: [] },
      });
      return;
    }
    if (path === "/api/admin/information-agent/missions" && method === "POST") {
      state.mission = missionFixture("draft");
      state.mission.recipientEmail =
        (payload as { recipientEmail?: string }).recipientEmail ?? "contact@example.test";
      await route.fulfill({
        status: 200,
        json: { ok: true, mission: state.mission, gaps: [], facts: [], contactCandidates: [] },
      });
      return;
    }
    if (path === "/api/admin/information-agent/missions" && method === "PATCH") {
      const action = (payload as { action?: string }).action;
      if (action === "approve_and_send" && state.mission) {
        state.mission = {
          ...state.mission,
          status: "sent",
          recipientEmail: (payload as { recipientEmail: string }).recipientEmail,
          approvedAt: "2026-10-04T10:02:00.000Z",
          sentAt: "2026-10-04T10:02:01.000Z",
        };
      }
      await route.fulfill({
        status: 200,
        json: { ok: true, missions: state.mission ? [state.mission] : [], facts: [] },
      });
      return;
    }
    if (path === "/api/admin/information-agent/source-refresh" && method === "GET") {
      await route.fulfill({ status: 200, json: state.sourceRefresh });
      return;
    }
    if (path === "/api/admin/information-agent/source-refresh" && method === "POST") {
      state.sourceRefresh = sourceRefreshFixture(REFRESH_ID);
      await route.fulfill({ status: 200, json: state.sourceRefresh });
      return;
    }
    if (path === "/api/admin/information-agent" && method === "GET") {
      await route.fulfill({
        status: 200,
        json: informationAgentReviewFixture(state),
      });
      return;
    }
    if (path === "/api/admin/information-agent" && method === "PATCH") {
      state.reviewFacts = [];
      await route.fulfill({ status: 200, json: { ok: true, result: { status: "accepted" } } });
      return;
    }
    if (path === `/api/admin/information-agent/evidence/${ASSET_ID}` && method === "GET") {
      await route.fulfill({
        status: 200,
        json: { signedUrl: "data:text/html,%3Cp%3EAper%C3%A7u%20priv%C3%A9%20E2E%3C%2Fp%3E" },
      });
      return;
    }
    if (path === `/api/admin/information-agent/evidence/${ASSET_ID}` && method === "PATCH") {
      state.reviewAssetRights = (
        payload as { rightsStatus: "authorized" | "restricted" }
      ).rightsStatus;
      await route.fulfill({
        status: 200,
        json: {
          ok: true,
          asset: {
            id: ASSET_ID,
            rights_status: state.reviewAssetRights,
            review_status: "pending",
          },
        },
      });
      return;
    }
    if (path === "/api/admin/information-agent/template" && method === "GET") {
      await route.fulfill({ status: 200, json: state.template });
      return;
    }
    if (path === "/api/admin/information-agent/template" && method === "POST") {
      const action = (payload as { action?: string }).action;
      if (action === "preview") {
        await route.fulfill({
          status: 200,
          json: {
            preview: {
              subject: "Questions concernant la vente · Appartement E2E",
              bodyText: "Aperçu contrôlé du message.",
              html: "<html><body><p>Aperçu contrôlé du message.</p></body></html>",
            },
          },
        });
        return;
      }
      if (action === "save_draft") {
        const templatePayload = payload as {
          template: { name: string; subjectTemplate: string; blocks: unknown[] };
        };
        state.template = templateFixture({
          draft: templateEntry("draft", templatePayload.template.name, 2),
        });
        await route.fulfill({ status: 200, json: state.template });
        return;
      }
      if (action === "publish") {
        const draft = state.template.draft as Record<string, unknown>;
        state.template = templateFixture({
          published: {
            ...draft,
            status: "published",
            revision: 2,
            publishedAt: "2026-10-04T10:05:00.000Z",
          },
          draft: null,
        });
        await route.fulfill({ status: 200, json: state.template });
        return;
      }
    }

    state.unexpectedRequests.push(`${method} ${path}`);
    await route.fulfill({ status: 500, json: { error: "Unexpected admin API request" } });
  });

  return state;
}

function catalogueReadinessFixture() {
  return {
    policy: {
      enforcementEnabled: true,
      policyVersion: "e2e-v1",
      premiumReadyMin: 80,
      minimumScoreConfidence: 0.8,
      updatedAt: "2026-10-04T09:00:00.000Z",
    },
    counts: { unassessed: 0, internal_only: 0, needs_enrichment: 1, premium_ready: 0 },
    activeSales: 1,
    pendingEvaluations: 0,
    canEnableEnforcement: true,
    queueTotal: 1,
    queueOffset: 0,
    queueLimit: 100,
    items: [
      {
        id: SALE_ID,
        title: "Appartement E2E à Bordeaux",
        city: "Bordeaux",
        department: "33",
        saleDate: "2026-11-14",
        sourceName: "source-e2e",
        lawyerName: "Cabinet E2E",
        lawyerContact: "Cabinet E2E <contact@example.test>",
        scoreConfidence: 0.91,
        readinessScore: 62,
        readinessStatus: "needs_enrichment",
        policyVersion: "e2e-v1",
        factors: {},
        blockers: ["document manquant"],
        missingFields: ["documents"],
        evaluatedAt: "2026-10-04T09:00:00.000Z",
        override: null,
        overrideReason: null,
        overrideExpiresAt: null,
      },
    ],
  };
}

function missionFixture(status: "draft" | "sent") {
  const content = renderInformationAgentEmailContent({
    template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
    values: Object.fromEntries(
      INFORMATION_AGENT_EMAIL_VARIABLES.map((variable) => [variable.key, variable.example]),
    ) as Record<(typeof INFORMATION_AGENT_EMAIL_VARIABLES)[number]["key"], string>,
  });
  return {
    id: MISSION_ID,
    caseId: CASE_ID,
    saleId: SALE_ID,
    status,
    recipientKind: "source_contact",
    recipientName: "Cabinet E2E",
    recipientEmail: "contact@example.test",
    subject: "Questions concernant la vente · Appartement E2E",
    bodyText: content.bodyText,
    questionKeys: ["documents"],
    missingInformation: ["documents"],
    failureReason: null,
    approvedAt: status === "sent" ? "2026-10-04T10:02:00.000Z" : null,
    sentAt: status === "sent" ? "2026-10-04T10:02:01.000Z" : null,
    repliedAt: null,
    createdAt: "2026-10-04T10:00:00.000Z",
    updatedAt: "2026-10-04T10:02:01.000Z",
  };
}

function sourceRefreshFixture(requestId: string | null) {
  const request = requestId
    ? {
        id: requestId,
        saleId: SALE_ID,
        sourceName: "source-e2e",
        sourceUrl: "https://source.example.test/vente/e2e",
        status: "completed",
        force: true,
        reused: false,
        errorCode: null,
        errorMessage: null,
        queuedAt: "2026-10-04T10:00:00.000Z",
        startedAt: "2026-10-04T10:00:01.000Z",
        completedAt: "2026-10-04T10:00:02.000Z",
      }
    : null;
  return {
    ok: true,
    sale: {
      id: SALE_ID,
      title: "Appartement E2E à Bordeaux",
      sourceName: "source-e2e",
      sourceUrl: "https://source.example.test/vente/e2e",
    },
    request,
    history: request ? [request] : [],
  };
}

function factClaimFixture() {
  return {
    claimId: CLAIM_ID,
    saleId: SALE_ID,
    lotId: null,
    fieldKey: "property.surface_m2",
    value: 70,
    currentCanonicalValue: 68,
    status: "candidate",
    conflictGroup: null,
    evidence: {
      kind: "source_page",
      sourceId: null,
      rawArtifactId: null,
      sourceRecordId: null,
      extractionId: null,
      sourceUrl: "https://source.example.test/vente/e2e",
      locator: { quote: "Surface : 70 m²" },
      confidence: 0.94,
      capturedAt: "2026-10-04T09:30:00.000Z",
    },
    sale: {
      title: "Appartement E2E à Bordeaux",
      city: "Bordeaux",
      saleDate: "2026-11-14",
      startingPriceEur: 85000,
    },
    createdAt: "2026-10-04T09:30:00.000Z",
    updatedAt: "2026-10-04T09:30:00.000Z",
    resolutionNote: null,
  };
}

function informationAgentFactFixture() {
  return {
    id: FACT_ID,
    case_id: CASE_ID,
    sale_id: SALE_ID,
    fact_key: "document",
    display_value: "dpe.pdf",
    confidence: 0.94,
    status: "pending",
    evidence_excerpt: "DPE fourni en pièce jointe.",
    evidence_asset_id: ASSET_ID,
    created_at: "2026-10-04T09:40:00.000Z",
    reviewed_at: null,
  };
}

function informationAgentReviewFixture(state: AgentMockState) {
  return {
    cases: [
      {
        id: CASE_ID,
        sale_id: SALE_ID,
        status: "review",
        recipient_name: "Cabinet E2E",
        recipient_email: "contact@example.test",
        subject: "Questions concernant la vente · Appartement E2E",
        sent_at: "2026-10-04T09:00:00.000Z",
        replied_at: "2026-10-04T09:30:00.000Z",
        updated_at: "2026-10-04T09:30:00.000Z",
      },
    ],
    facts: state.reviewFacts,
    assets: [
      {
        id: ASSET_ID,
        case_id: CASE_ID,
        original_filename: "dpe.pdf",
        storage_path: "case/dpe.pdf",
        detected_mime_type: "application/pdf",
        size_bytes: 1234,
        rights_status: state.reviewAssetRights,
        rights_notes: null,
        review_status: "pending",
        created_at: "2026-10-04T09:35:00.000Z",
      },
    ],
    extractions: [
      {
        id: "00000000-0000-4000-8000-000000000009",
        asset_id: ASSET_ID,
        status: "completed",
        detected_mime_type: "application/pdf",
        document_kind: "dpe",
        page_count: 2,
        is_encrypted: false,
        summary: "Diagnostic énergétique",
        error_code: null,
        error_message: null,
        attempts: 1,
        completed_at: "2026-10-04T09:38:00.000Z",
        created_at: "2026-10-04T09:35:00.000Z",
        updated_at: "2026-10-04T09:38:00.000Z",
      },
    ],
    messages: [
      {
        id: MESSAGE_ID,
        case_id: CASE_ID,
        from_email: "contact@example.test",
        subject: "Re: Questions concernant la vente",
        body_text: "DPE joint à ce message.",
        created_at: "2026-10-04T09:30:00.000Z",
        received_at: "2026-10-04T09:30:00.000Z",
        metadata: {},
      },
    ],
    hasMoreFacts: false,
    nextFactsCursor: null,
    hasMoreMessages: false,
    nextMessagesCursor: null,
  };
}

function templateEntry(status: "published" | "draft" | "archived", name: string, revision: number) {
  const now = "2026-10-04T10:00:00.000Z";
  return {
    id: `00000000-0000-4000-8000-00000000000${revision}`,
    name,
    revision,
    status,
    subjectTemplate: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.subjectTemplate,
    blocks: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.blocks.map((block) => ({ ...block })),
    createdAt: now,
    updatedAt: now,
    publishedAt: status === "published" ? now : null,
  };
}

function templateFixture(overrides: Record<string, unknown> = {}) {
  const published =
    (overrides.published as Record<string, unknown> | undefined) ??
    templateEntry("published", "Version E2E", 1);
  const draft =
    overrides.draft === null
      ? null
      : ((overrides.draft as Record<string, unknown> | undefined) ?? null);
  return {
    published,
    draft,
    history: [published],
    variables: INFORMATION_AGENT_EMAIL_VARIABLES,
    protectedBlocks: [
      { title: "Identité", description: "L’agent est présenté comme un outil d’aide." },
      { title: "Réponse", description: "Les réponses sont contrôlées par un administrateur." },
      { title: "Dépôt privé", description: "Les pièces utilisent un lien privé à durée limitée." },
    ],
  };
}

function createSession() {
  const user = {
    id: ADMIN_ID,
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
    access_token: fakeJwt({ sub: ADMIN_ID, email: adminEmail, role: "authenticated" }),
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
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
}
