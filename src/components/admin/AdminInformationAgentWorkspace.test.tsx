// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  INFORMATION_AGENT_EMAIL_VARIABLES,
} from "@/lib/information-agent-email-template";
import { AdminInformationAgentWorkspace } from "./AdminInformationAgentWorkspace";

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  autopilot: vi.fn(),
  review: vi.fn(),
  unrouted: vi.fn(),
  claims: vi.fn(),
  operations: vi.fn(),
  template: vi.fn(),
  missions: vi.fn(),
  create: vi.fn(),
  sourceStatus: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminCatalogueReadiness: mocks.readiness,
  fetchAdminInformationAgentAutopilot: mocks.autopilot,
  fetchAdminInformationAgentReview: mocks.review,
  fetchAdminInformationAgentUnrouted: mocks.unrouted,
  fetchAdminAuctionFactClaimReview: mocks.claims,
  fetchAdminInformationAgentOperations: mocks.operations,
  fetchAdminInformationAgentEmailTemplate: mocks.template,
  fetchAdminInformationAgentMissions: mocks.missions,
  createAdminInformationAgentMission: mocks.create,
  fetchAdminSourceRefreshStatus: mocks.sourceStatus,
  // Actions : jamais appelées ici, mais lues par les panneaux au montage.
  runAdminCatalogueReadinessActionClient: vi.fn(),
  runAdminInformationAgentAutopilotActionClient: vi.fn(),
  runAdminInformationAgentMissionAction: vi.fn(),
  previewAdminInformationAgentMission: vi.fn(),
  requestAdminSourceRefresh: vi.fn(),
  reviewAdminInformationAgentFactClient: vi.fn(),
  runAdminInformationAgentMessageActionClient: vi.fn(),
  updateAdminInformationAgentEvidenceRightsClient: vi.fn(),
  fetchAdminInformationAgentEvidenceUrlClient: vi.fn(),
  reviewAdminAuctionFactClaimClient: vi.fn(),
  markAdminInformationAgentUnroutedHandledClient: vi.fn(),
  attestAdminInformationAgentRoundtripClient: vi.fn(),
  previewAdminInformationAgentEmailTemplate: vi.fn(),
  saveAdminInformationAgentEmailTemplateDraft: vi.fn(),
  publishAdminInformationAgentEmailTemplateDraft: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  AdminSectionHeading: ({ title, description }: { title: string; description: ReactNode }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}));

const SALE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/agent-ia");
  mocks.readiness.mockResolvedValue(readiness(4));
  mocks.autopilot.mockResolvedValue(autopilot());
  mocks.review.mockResolvedValue(review(0));
  mocks.unrouted.mockResolvedValue(unrouted(0));
  mocks.claims.mockResolvedValue({ items: [], total: 0, offset: 0, limit: 50, hasMore: false });
  mocks.operations.mockResolvedValue(operations());
  mocks.template.mockResolvedValue(templateWorkspace());
  mocks.missions.mockResolvedValue({ ok: true, missions: [], facts: [] });
  mocks.create.mockResolvedValue({ ok: true, mission: mission("draft"), gaps: [], facts: [] });
  mocks.sourceStatus.mockResolvedValue({ ok: true, request: null, history: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

function tab(name: string | RegExp) {
  return screen.getByRole("tab", { name });
}

describe("AdminInformationAgentWorkspace : onglets", () => {
  it("expose tablist, tab et tabpanel, et n'affiche qu'un panneau à la fois", async () => {
    renderWorkspace();
    await screen.findByRole("tab", { name: /À contacter/, selected: true });

    const tabs = within(screen.getByRole("tablist", { name: "Rubriques de l’agent" })).getAllByRole(
      "tab",
    );
    expect(tabs.map((item) => item.textContent?.replace(/ \(\d+\)/, ""))).toEqual([
      "À contacter",
      "Envois",
      "Réponses",
      "Pilote",
      "Réglages",
    ]);
    expect(tabs.filter((item) => item.getAttribute("aria-selected") === "true")).toHaveLength(1);
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tab(/À contacter/).id);
    expect(tab(/À contacter/).getAttribute("aria-controls")).toBe(panel.id);
    // Les autres panneaux existent mais sont masqués.
    expect(document.querySelectorAll('[role="tabpanel"][hidden]')).toHaveLength(4);
  });

  it("change d'onglet au clavier avec les flèches (focus suivi, adresse mise à jour)", async () => {
    renderWorkspace();
    await screen.findByRole("tab", { name: /À contacter/, selected: true });

    fireEvent.keyDown(tab(/À contacter/), { key: "ArrowRight" });
    expect(tab("Envois").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Envois"));
    expect(tab("Envois").tabIndex).toBe(0);
    expect(tab(/À contacter/).tabIndex).toBe(-1);
    expect(window.location.search).toBe("?onglet=envois");

    fireEvent.keyDown(tab("Envois"), { key: "ArrowLeft" });
    fireEvent.keyDown(tab(/À contacter/), { key: "ArrowLeft" });
    expect(tab("Réglages").getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toBe("?onglet=reglages");
    fireEvent.keyDown(tab("Réglages"), { key: "Home" });
    expect(tab(/À contacter/).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab(/À contacter/), { key: "End" });
    expect(tab("Réglages").getAttribute("aria-selected")).toBe("true");
  });

  it("lit l'onglet demandé dans l'adresse, sans attendre les compteurs", async () => {
    window.history.replaceState(null, "", "/admin/agent-ia?onglet=pilote");
    mocks.review.mockResolvedValue(review(3));
    renderWorkspace();

    expect(await screen.findByRole("tab", { name: "Pilote", selected: true })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Pilote automatique" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Suivi des envois et de la réception" }),
    ).toBeTruthy();
  });

  it("charge un onglet à sa première visite seulement, sans requête en boucle", async () => {
    renderWorkspace();
    await screen.findByRole("heading", { name: "Demandes d’informations" });

    // Au chargement : file, pilote, revue et non rattachés (bandeau et compteurs) ; rien d'autre.
    expect(mocks.operations).not.toHaveBeenCalled();
    expect(mocks.template).not.toHaveBeenCalled();
    expect(mocks.claims).not.toHaveBeenCalled();
    expect(mocks.readiness).toHaveBeenCalledTimes(1);
    expect(mocks.autopilot).toHaveBeenCalledTimes(1);
    expect(mocks.review).toHaveBeenCalledTimes(1);
    expect(mocks.unrouted).toHaveBeenCalledTimes(1);

    fireEvent.click(tab("Pilote"));
    await screen.findByText("30 derniers jours");
    expect(mocks.operations).toHaveBeenCalledTimes(1);
    // Le pilote partage la requête du bandeau.
    expect(mocks.autopilot).toHaveBeenCalledTimes(1);

    fireEvent.click(tab("Réglages"));
    await screen.findByText(/Seuil de maturité du catalogue/);
    fireEvent.click(tab(/À contacter/));
    fireEvent.click(tab("Pilote"));
    fireEvent.click(tab("Réglages"));
    expect(mocks.operations).toHaveBeenCalledTimes(1);
    expect(mocks.template).toHaveBeenCalledTimes(1);
    // Les indicateurs de maturité réutilisent la réponse de la file (même page).
    expect(mocks.readiness).toHaveBeenCalledTimes(1);
  });
});

describe("AdminInformationAgentWorkspace : onglet d'accueil", () => {
  it("ouvre « Réponses » quand une réponse est à relire", async () => {
    mocks.review.mockResolvedValue(review(2));
    renderWorkspace();

    expect(await screen.findByRole("tab", { name: /Réponses/, selected: true })).toBeTruthy();
    // L'adresse n'est pas réécrite par le choix automatique.
    expect(window.location.search).toBe("");
  });

  it("ouvre « Réponses » quand seul un message non rattaché attend", async () => {
    mocks.unrouted.mockResolvedValue(unrouted(1));
    renderWorkspace();

    expect(await screen.findByRole("tab", { name: /Réponses/, selected: true })).toBeTruthy();
  });

  it("ouvre « À contacter » quand aucune réponse n'attend", async () => {
    renderWorkspace();

    expect(await screen.findByRole("tab", { name: /À contacter/, selected: true })).toBeTruthy();
  });

  it("l'adresse prime sur les compteurs", async () => {
    window.history.replaceState(null, "", "/admin/agent-ia?onglet=envois");
    mocks.review.mockResolvedValue(review(5));
    renderWorkspace();

    expect(await screen.findByRole("tab", { name: "Envois", selected: true })).toBeTruthy();
    await waitFor(() => expect(tab(/Réponses/).textContent).toBe("Réponses (5)"));
    expect(tab("Envois").getAttribute("aria-selected")).toBe("true");
  });

  it("n'attend pas indéfiniment des listes qui ne répondent pas", async () => {
    vi.useFakeTimers();
    mocks.review.mockReturnValue(new Promise(() => {}));
    renderWorkspace();
    await act(async () => {});

    expect(screen.getByRole("status").textContent).toBe("Chargement de l’espace de travail…");
    expect(document.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(3_100);
    });
    expect(tab(/À contacter/).getAttribute("aria-selected")).toBe("true");
  });

  it("ne change plus d'onglet quand les compteurs bougent après le choix", async () => {
    const client = renderWorkspace();
    await screen.findByRole("tab", { name: /À contacter/, selected: true });
    expect(tab(/Réponses/).textContent).toBe("Réponses (0)");

    mocks.review.mockResolvedValue(review(4));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["admin-information-agent-review"] });
    });

    await waitFor(() => expect(tab(/Réponses/).textContent).toBe("Réponses (4)"));
    expect(tab(/À contacter/).getAttribute("aria-selected")).toBe("true");
  });

  it("ne remplace pas l'onglet choisi par l'utilisateur avant l'arrivée des compteurs", async () => {
    let resolveReview!: (value: unknown) => void;
    mocks.review.mockReturnValue(new Promise((resolve) => (resolveReview = resolve)));
    renderWorkspace();
    await act(async () => {});

    fireEvent.click(tab("Pilote"));
    await act(async () => resolveReview(review(6)));

    await waitFor(() => expect(tab(/Réponses/).textContent).toBe("Réponses (6)"));
    expect(tab("Pilote").getAttribute("aria-selected")).toBe("true");
  });
});

describe("AdminInformationAgentWorkspace : compteurs", () => {
  it("n'affiche aucun compteur tant que la valeur est inconnue", async () => {
    mocks.readiness.mockReturnValue(new Promise(() => {}));
    mocks.review.mockReturnValue(new Promise(() => {}));
    renderWorkspace();
    await act(async () => {});

    expect(tab("À contacter").textContent).toBe("À contacter");
    expect(tab("Réponses").textContent).toBe("Réponses");
    expect(tab("Envois").textContent).toBe("Envois");
  });

  it("ne montre pas un total de réponses incomplet quand une liste est en erreur", async () => {
    mocks.review.mockRejectedValue(new Error("Revue indisponible"));
    mocks.unrouted.mockResolvedValue(unrouted(2));
    renderWorkspace();

    await waitFor(() => expect(tab(/Réponses/).getAttribute("aria-selected")).toBe("true"));
    expect(tab(/Réponses/).textContent).toBe("Réponses");
    const banner = screen.getByRole("region", { name: "Synthèse de l’agent" });
    expect(await within(banner).findByText("indisponible")).toBeTruthy();
  });

  it("additionne les réponses à relire et les messages non rattachés", async () => {
    mocks.review.mockResolvedValue(review(3));
    mocks.unrouted.mockResolvedValue(unrouted(2));
    mocks.readiness.mockResolvedValue(readiness(7));
    renderWorkspace();

    await waitFor(() => expect(tab(/Réponses/).textContent).toBe("Réponses (5)"));
    expect(tab(/À contacter/).textContent).toBe("À contacter (7)");
  });
});

describe("AdminInformationAgentWorkspace : bandeau de synthèse", () => {
  it("résume le pilote, les envois du jour, les réponses et les non rattachés", async () => {
    mocks.autopilot.mockResolvedValue(autopilot({ mode: "simulation", sentToday: "3 sur 10" }));
    mocks.review.mockResolvedValue(review(2));
    mocks.unrouted.mockResolvedValue(unrouted(1));
    renderWorkspace();

    const banner = await screen.findByRole("region", { name: "Synthèse de l’agent" });
    await waitFor(() => expect(within(banner).getByText("Simulation")).toBeTruthy());
    expect(within(banner).getByText("3 sur 10")).toBeTruthy();
    expect(within(banner).getByText("Réponses à relire").nextElementSibling?.textContent).toBe("2");
    expect(within(banner).getByText("Messages non rattachés").nextElementSibling?.textContent).toBe(
      "1",
    );
  });

  it("affiche « Arrêté » et « Réel » et reste visible sous chaque onglet", async () => {
    mocks.autopilot.mockResolvedValue(autopilot({ mode: "live" }));
    renderWorkspace();
    const banner = await screen.findByRole("region", { name: "Synthèse de l’agent" });
    await waitFor(() => expect(within(banner).getByText("Réel")).toBeTruthy());

    for (const name of ["Envois", "Réponses", "Pilote", "Réglages"]) {
      fireEvent.click(tab(new RegExp(name)));
      expect(banner.closest("[hidden]")).toBeNull();
      expect(screen.getByRole("region", { name: "Synthèse de l’agent" })).toBe(banner);
    }
  });

  it("montre « … » plutôt qu'un zéro pendant le chargement", async () => {
    mocks.autopilot.mockReturnValue(new Promise(() => {}));
    mocks.review.mockReturnValue(new Promise(() => {}));
    mocks.unrouted.mockReturnValue(new Promise(() => {}));
    renderWorkspace();
    await act(async () => {});

    const banner = screen.getByRole("region", { name: "Synthèse de l’agent" });
    expect(banner.textContent).not.toMatch(/\b0\b/);
    expect(within(banner).getAllByText("…")).toHaveLength(4);
  });

  it("signale un arrêt automatique et ne contient ni adresse ni contenu de message", async () => {
    mocks.autopilot.mockResolvedValue(
      autopilot({
        notice: {
          tone: "alert",
          text: "Arrêt automatique le 09/11/2026 10:00 : deux plaintes en 14 jours. La réactivation est manuelle et journalisée.",
        },
      }),
    );
    mocks.review.mockResolvedValue(review(1));
    mocks.unrouted.mockResolvedValue(unrouted(1));
    renderWorkspace();

    const banner = await screen.findByRole("region", { name: "Synthèse de l’agent" });
    expect((await within(banner).findByRole("alert")).textContent).toContain(
      "Arrêt automatique le 09/11/2026",
    );
    // Les listes contiennent des adresses (message non rattaché, destinataire) : pas le bandeau.
    expect(banner.textContent).not.toContain("@");
    expect(banner.textContent).not.toContain("la vente est reportée");
  });
});

describe("AdminInformationAgentWorkspace : brouillons conservés d'un onglet à l'autre", () => {
  it("garde le message en cours d'édition et le gabarit modifié quand on change d'onglet", async () => {
    renderWorkspace();
    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir le message" }));
    const message = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    fireEvent.change(message, {
      target: { value: "Message modifié à la main, plus de vingt caractères." },
    });
    const email = screen.getByRole("textbox", { name: "Email" });
    fireEvent.change(email, { target: { value: "autre-contact@example.test" } });

    fireEvent.click(tab("Réglages"));
    const name = await screen.findByDisplayValue("Version A");
    fireEvent.change(name, { target: { value: "Gabarit en cours" } });
    expect(screen.getByText(/Modifications non enregistrées/)).toBeTruthy();

    fireEvent.click(tab("Pilote"));
    fireEvent.click(tab(/Réponses/));
    fireEvent.click(tab(/À contacter/));

    // Même éléments, mêmes valeurs : rien n'a été remonté.
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(message);
    expect(message.value).toBe("Message modifié à la main, plus de vingt caractères.");
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).value).toBe(
      "autre-contact@example.test",
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);

    fireEvent.click(tab("Réglages"));
    expect(screen.getByDisplayValue("Gabarit en cours")).toBe(name);
    expect(mocks.template).toHaveBeenCalledTimes(1);
  });

  it("ouvre depuis « Envois » un brouillon dans « À contacter », fiche chargée", async () => {
    mocks.missions.mockResolvedValue({
      ok: true,
      missions: [mission("draft", "reprise@example.test")],
      facts: [],
    });
    window.history.replaceState(null, "", "/admin/agent-ia?onglet=envois");
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Reprendre" }));

    expect(await screen.findByRole("tab", { name: /À contacter/, selected: true })).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Brouillon pour reprise@example.test" }),
    ).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).value).toBe(
      "reprise@example.test",
    );
    expect(window.location.search).toBe("?onglet=a-contacter");
    // Aucun nouveau brouillon n'est préparé : la mission existante est ouverte telle quelle.
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByRole("tabpanel", { name: /À contacter/ }).hidden).toBe(false);
  });

  it("ouvre en lecture seule une mission envoyée depuis « Envois »", async () => {
    mocks.missions.mockResolvedValue({
      ok: true,
      missions: [mission("sent", "envoye@example.test")],
      facts: [],
    });
    window.history.replaceState(null, "", "/admin/agent-ia?onglet=envois");
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "Ouvrir" }));

    const email = (await screen.findByRole("textbox", { name: "Email" })) as HTMLInputElement;
    expect(email.readOnly).toBe(true);
    expect(tab(/À contacter/).getAttribute("aria-selected")).toBe("true");
  });
});

function renderWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminInformationAgentWorkspace />
    </QueryClientProvider>,
  );
  return client;
}

function readiness(queueTotal: number) {
  return {
    policy: {
      enforcementEnabled: true,
      policyVersion: "v1",
      premiumReadyMin: 70,
      minimumScoreConfidence: 0.8,
      updatedAt: "2026-10-08T08:00:00Z",
    },
    counts: { unassessed: 0, internal_only: 1, needs_enrichment: 1, premium_ready: 3 },
    activeSales: 5,
    pendingEvaluations: 0,
    canEnableEnforcement: true,
    queueTotal,
    queueOffset: 0,
    queueLimit: 50,
    classCounts: { A: queueTotal, B: 0, C: 0, D: 0 },
    items: [
      {
        id: SALE_ID,
        title: "Appartement T3",
        city: "Bordeaux",
        department: "33",
        saleDate: "2026-11-10T10:00:00Z",
        sourceName: "Source test",
        lawyerName: "Cabinet source",
        lawyerContact: "cabinet@example.test",
        contactClass: "A",
        scoreConfidence: 0.9,
        readinessScore: 42,
        readinessStatus: "needs_enrichment",
        policyVersion: "v1",
        factors: {},
        blockers: [],
        missingFields: ["diagnostics"],
        evaluatedAt: "2026-10-08T08:00:00Z",
        override: null,
        overrideReason: null,
        overrideExpiresAt: null,
      },
    ],
  };
}

function autopilot(overrides: Record<string, unknown> = {}) {
  return {
    mode: "off",
    modeLabel: "Éteint",
    notice: null,
    sentToday: "0 sur 10",
    counters: [{ label: "Envois aujourd’hui (manuels inclus)", value: "0 sur 10" }],
    settings: {
      actingAdminId: null,
      capTotalOverride: null,
      allowLicitorDecoded: false,
      art14RuleEnabled: true,
      art14MaxAgeDays: 30,
      aipdLabel: "Non attestée",
    },
    readiness: { ready: false, checks: [] },
    ready: { count: 0, items: [] },
    events: [],
    ...overrides,
  };
}

function review(messagesTotal: number) {
  return {
    cases: [],
    facts: [],
    assets: [],
    extractions: [],
    messages: [],
    factSources: [],
    factsTotal: 0,
    messagesTotal,
    offset: 0,
    limit: 50,
    total: messagesTotal,
    hasMore: false,
  };
}

function unrouted(total: number) {
  return {
    messages: Array.from({ length: total }, (_, index) => ({
      id: `message-${index}`,
      provider_email_id: `provider-${index}`,
      sender: "Maître Dupont <maitre@example.test>",
      sender_email: "maitre@example.test",
      subject: "Re: Vente",
      received_at: "2026-12-01T09:00:00.000Z",
      excerpt: "Bonjour, la vente est reportée.",
      reason: "case_not_open",
      sender_known: true,
      sender_authentication: "pass",
      attachment_count: 0,
      opposition_recorded: false,
      created_at: "2026-12-01T09:00:01.000Z",
    })),
    total,
    offset: 0,
    limit: 50,
    hasMore: false,
  };
}

function operations() {
  return {
    windowLabel: "30 derniers jours",
    sent: 0,
    rows: [{ key: "sent", label: "Envoyés", value: "0", tone: "plain" }],
    roundtrip: { verifiedAt: null, label: "Jamais vérifié.", stale: true },
  };
}

function templateWorkspace() {
  const source = {
    ...DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
    id: "template-a",
    name: "Version A",
    revision: 1,
    status: "published" as const,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    publishedAt: "2026-08-01T10:00:00.000Z",
    blocks: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE.blocks.map((block) => ({ ...block })),
  };
  return {
    published: source,
    publishedIgnored: false,
    minCompliantRevision: 7,
    fallback: { ...DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE, revision: 7 },
    draft: null,
    history: [source],
    variables: INFORMATION_AGENT_EMAIL_VARIABLES,
    protectedBlocks: [],
  };
}

function mission(status: "draft" | "sent" | "failed", recipientEmail = "cabinet@example.test") {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    caseId: "33333333-3333-4333-8333-333333333333",
    saleId: SALE_ID,
    status,
    recipientKind: "source_lawyer",
    recipientName: "Maître Dupont",
    recipientEmail,
    subject: "Demande de pièces",
    bodyText: "Bonjour, pourriez-vous transmettre les pièces complémentaires du dossier ?",
    questionKeys: ["documents"],
    missingInformation: ["documents"],
    failureReason: null,
    approvedAt: null,
    sentAt: null,
    repliedAt: null,
    createdAt: "2026-11-09T09:00:00.000Z",
    updatedAt: "2026-11-09T10:01:00.000Z",
  };
}
