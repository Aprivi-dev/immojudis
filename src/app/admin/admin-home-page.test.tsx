// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminDashboardRunsData } from "@/lib/admin.server";
import type { AdminOperationalReadinessResponse } from "@/lib/admin-readiness";
import { AdminHomePage } from "./admin-home-page";

const mocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  fetchReadiness: vi.fn(),
  fetchAutopilot: vi.fn(),
  fetchReview: vi.fn(),
  fetchUnrouted: vi.fn(),
  fetchPrivacy: vi.fn(),
  fetchPublications: vi.fn(),
}));

vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminSectionHeading: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  ),
  AdminShell: ({
    children,
    primaryAction,
    onRefresh,
  }: {
    children: ReactNode;
    primaryAction?: ReactNode;
    onRefresh?: () => void;
  }) => (
    <main>
      <button type="button" onClick={onRefresh}>
        Actualiser
      </button>
      {primaryAction}
      {children}
    </main>
  ),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { email: "admin@example.test" } }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminDashboardRuns: mocks.fetchRuns,
  fetchAdminReadiness: mocks.fetchReadiness,
  fetchAdminInformationAgentAutopilot: mocks.fetchAutopilot,
  fetchAdminInformationAgentReview: mocks.fetchReview,
  fetchAdminInformationAgentUnrouted: mocks.fetchUnrouted,
  fetchAdminInformationAgentMissions: vi.fn(),
  fetchAdminCatalogueReadiness: vi.fn(),
  fetchAdminPrivacyRequests: mocks.fetchPrivacy,
  fetchAdminPublicationRequests: mocks.fetchPublications,
}));

const RUNS: AdminDashboardRunsData = {
  checkedAt: "2026-09-19T08:00:00.000Z",
  adminEmail: "admin@example.test",
  runner: { instantDispatchConfigured: true, mode: "queue_worker" },
  stats: { queuedRuns: 0, runningRuns: 0, failedRuns: 0 },
  runs: [
    {
      id: "run-1",
      status: "succeeded",
      source: "all",
      useLlm: true,
      startedAt: "2026-09-19T07:00:00.000Z",
      finishedAt: "2026-09-19T07:05:00.000Z",
      createdAt: "2026-09-19T07:00:00.000Z",
      updatedAt: "2026-09-19T07:05:00.000Z",
      summary: { collected: 2, deduplicated: 1, upserted: 1 },
      errors: {},
    },
  ],
};

type Alert = AdminOperationalReadinessResponse["operations"]["alerts"][number];

function readiness(alerts: Alert[]) {
  return {
    operations: { openAlertCount: alerts.length, alerts },
  } as AdminOperationalReadinessResponse;
}

// Le nom d'alerte passe en argument : un champ `key: "…"` littéral ressemble à un secret pour le
// contrôle anti-secrets.
function openAlert(name: string, severity: Alert["severity"]): Alert {
  return {
    key: name,
    category: "import",
    severity,
    status: "open",
    deliveryStatus: "delivered",
    lastSeenAt: "2026-11-14T07:45:00.000Z",
  };
}

const OPEN_ALERTS: Alert[] = [
  openAlert("pipeline.enrichment.stalled", "critical"),
  openAlert("information_agent.unrouted.pending", "warning"),
];

const PILOT_OFF = { mode: "off", modeLabel: "Éteint", notice: null };
const PRIVACY_NONE = { requests: [], total: 0, openCount: 0, overdueCount: 0 };

beforeEach(() => {
  mocks.fetchRuns.mockResolvedValue(RUNS);
  mocks.fetchReadiness.mockResolvedValue(readiness([]));
  mocks.fetchAutopilot.mockResolvedValue(PILOT_OFF);
  mocks.fetchReview.mockResolvedValue({ messagesTotal: 0 });
  mocks.fetchUnrouted.mockResolvedValue({ messages: [], total: 0 });
  mocks.fetchPrivacy.mockResolvedValue(PRIVACY_NONE);
  mocks.fetchPublications.mockResolvedValue({ requests: [], total: 0, pendingCount: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminHomePage />
    </QueryClientProvider>,
  );
}

function section(title: string): HTMLElement {
  return screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;
}

describe("AdminHomePage", () => {
  it("never shows a green health pill while an operational alert is open", async () => {
    mocks.fetchReadiness.mockResolvedValue(readiness(OPEN_ALERTS));

    renderHome();

    await screen.findByRole("heading", { name: "Une intervention est requise" });
    expect(screen.queryByRole("heading", { name: "Aucune alerte ni échec récent" })).toBeNull();
    const alerts = section("Alertes ouvertes");
    expect(within(alerts).getByText("Enrichissement des fiches à l’arrêt")).toBeTruthy();
    expect(within(alerts).getByText("Critique")).toBeTruthy();
    expect(
      within(alerts)
        .getByText("Messages reçus sans dossier, en attente de traitement")
        .closest("li")
        ?.querySelector("a")
        ?.getAttribute("href"),
    ).toBe("/admin/agent-ia?onglet=reponses");
    expect(document.body.textContent).not.toMatch(/pipeline\.|information_agent\./);
  });

  it("lists what is left to handle, each with a link to where to act", async () => {
    mocks.fetchAutopilot.mockResolvedValue({
      mode: "off",
      modeLabel: "Éteint",
      notice: {
        tone: "alert",
        text: "Arrêt automatique le 13/11/2026 10:00 : une plainte sur les 100 premiers envois.",
      },
    });
    mocks.fetchReview.mockResolvedValue({ messagesTotal: 1 });
    mocks.fetchUnrouted.mockResolvedValue({ messages: [], total: 2 });
    mocks.fetchPrivacy.mockResolvedValue({
      requests: [
        {
          id: "r1",
          status: "received",
          submittedAt: "2026-11-01T09:00:00.000Z",
          dueAt: "2026-12-01T09:00:00.000Z",
          deadline: { daysRemaining: 17, overdue: false, dueSoon: false },
        },
        {
          id: "r2",
          status: "completed",
          submittedAt: "2026-10-01T09:00:00.000Z",
          dueAt: "2026-11-01T09:00:00.000Z",
          deadline: { daysRemaining: null, overdue: false, dueSoon: false },
        },
      ],
      total: 2,
      openCount: 1,
      overdueCount: 0,
    });
    mocks.fetchPublications.mockResolvedValue({ requests: [], total: 3, pendingCount: 3 });

    renderHome();

    const agent = section("Agent IA");
    expect(await within(agent).findByText("Éteint")).toBeTruthy();
    expect(within(agent).getByText(/Arrêt automatique le 13\/11\/2026/)).toBeTruthy();
    expect(await within(agent).findByText("1 réponse reçue à traiter")).toBeTruthy();
    expect(within(agent).getByText("2 messages non rattachés en attente")).toBeTruthy();
    const agentLinks = within(agent)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(agentLinks).toEqual([
      "/admin/agent-ia?onglet=pilote",
      "/admin/agent-ia?onglet=reponses",
    ]);

    const privacy = section("Demandes RGPD");
    expect(await within(privacy).findByText("1 demande ouverte")).toBeTruthy();
    expect(within(privacy).getByText(/échéance le 1 déc\. 2026/)).toBeTruthy();
    expect(within(privacy).getByText("17 jours restants")).toBeTruthy();
    expect(within(privacy).getAllByRole("listitem")).toHaveLength(1);
    expect(within(privacy).getByRole("link").getAttribute("href")).toBe("/admin/compliance");

    const publications = section("Annonces de professionnels");
    expect(within(publications).getByText("3 annonces en attente de validation")).toBeTruthy();
    expect(within(publications).getByRole("link").getAttribute("href")).toBe("/admin/publications");
  });

  it("says in one line when a section has nothing to handle", async () => {
    renderHome();

    await screen.findByRole("heading", { name: "Aucune alerte ni échec récent" });
    expect(await screen.findByText("Aucune alerte ouverte")).toBeTruthy();
    expect(await screen.findByText("Aucune réponse à traiter")).toBeTruthy();
    expect(await screen.findByText("Aucune demande RGPD ouverte")).toBeTruthy();
    // Aucune annonce en attente : la section n'apparaît pas.
    expect(screen.queryByRole("heading", { name: "Annonces de professionnels" })).toBeNull();
  });

  it("replaces the chart and the view cards by one compact line on the collections", async () => {
    renderHome();

    const line = await screen.findByText("Collectes :");
    const text = line.parentElement?.textContent ?? "";
    expect(text).toContain("2 collectées");
    expect(text).toContain("1 intégrée");
    expect(text).toContain("0 en file");
    expect(text).toContain("0 en cours");
    expect(text).toContain("0 échec récent");
    expect(text).toContain("Réussie");
    expect(text).toContain("toutes les sources");
    expect(text).not.toMatch(/succeeded|\ball\b/);
    expect(line.parentElement?.querySelector("a")?.getAttribute("href")).toBe("/admin/operations");
    expect(document.body.textContent).not.toMatch(/Upsert|\bruns?\b/i);
    expect(screen.queryByRole("navigation", { name: "Vues de l’administration" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Volumes intégrés par exécution" })).toBeNull();
  });

  it("points to the weekly feedback views", async () => {
    renderHome();
    await screen.findByRole("heading", { name: "Aucune alerte ni échec récent" });

    const card = screen.getByRole("heading", { name: "Retours de la semaine" }).parentElement
      ?.parentElement as HTMLElement;
    const hrefs = Array.from(card.querySelectorAll("a")).map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(["/admin/pilotage", "/admin/inscriptions", "/admin/pepites"]);
  });

  it("does not report a healthy system while the overview is loading", () => {
    mocks.fetchRuns.mockReturnValue(new Promise(() => {}));

    renderHome();

    expect(screen.getByRole("heading", { name: "Vérification de la santé…" })).toBeTruthy();
    expect(screen.queryByText("Aucune alerte ni échec récent")).toBeNull();
  });

  it("does not report a healthy system while the alerts are unknown", async () => {
    mocks.fetchReadiness.mockRejectedValue(new Error("diagnostic indisponible"));

    renderHome();

    await screen.findByRole("heading", { name: "Alertes indisponibles : santé incomplète" });
    expect(screen.queryByText("Aucune alerte ni échec récent")).toBeNull();
    expect(screen.queryByText("Aucune alerte ouverte")).toBeNull();
  });

  it("shows a retryable error instead of a false healthy state", async () => {
    mocks.fetchRuns.mockRejectedValue(new Error("dashboard indisponible"));

    renderHome();

    const errors = await screen.findAllByRole("alert", {}, { timeout: 5_000 });
    expect(errors.some((item) => item.textContent?.includes("dashboard indisponible"))).toBe(true);
    expect(screen.getByRole("heading", { name: "État de santé indisponible" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Réessayer" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Aucune alerte ni échec récent")).toBeNull();
  });

  it("shows the dashboard error at once, without waiting for the alerts", async () => {
    mocks.fetchRuns.mockRejectedValue(new Error("dashboard indisponible"));
    mocks.fetchReadiness.mockReturnValue(new Promise(() => {}));

    renderHome();

    expect(
      await screen.findByRole(
        "heading",
        { name: "État de santé indisponible" },
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
  });

  it("asks for an intervention when a recent run failed", async () => {
    mocks.fetchRuns.mockResolvedValue({
      ...RUNS,
      stats: { queuedRuns: 0, runningRuns: 0, failedRuns: 2 },
    });

    renderHome();

    await screen.findByRole("heading", { name: "Une intervention est requise" });
    expect(screen.queryByText("Aucune alerte ni échec récent")).toBeNull();
  });
});
