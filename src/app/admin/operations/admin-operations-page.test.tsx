// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminDashboardCountsData, AdminDashboardRunsData } from "@/lib/admin.server";
import { AdminOperationsPage } from "./admin-operations-page";

const mocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  fetchCounts: vi.fn(),
  startScroll: vi.fn(),
  fetchReadiness: vi.fn(),
}));

vi.mock("@/components/admin/AdminPipelinePanel", () => ({
  AdminPipelinePanel: () => <div data-testid="pipeline-panel" />,
}));

vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminPrimaryButton: ({
    children,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AdminSectionHeading: ({ title, action }: { title: string; action?: ReactNode }) => (
    <div>
      <h2>{title}</h2>
      {action}
    </div>
  ),
  AdminShell: ({
    children,
    onRefresh,
    isRefreshing,
  }: {
    children: ReactNode;
    onRefresh?: () => void;
    isRefreshing?: boolean;
  }) => (
    <main>
      <button type="button" onClick={onRefresh} disabled={isRefreshing}>
        {isRefreshing ? "Actualisation…" : "Actualiser"}
      </button>
      {children}
    </main>
  ),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { email: "admin@example.test" } }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminDashboardRuns: mocks.fetchRuns,
  fetchAdminDashboardCounts: mocks.fetchCounts,
  startAdminScrollRequest: mocks.startScroll,
  fetchAdminReadiness: mocks.fetchReadiness,
}));

vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

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

// Nom d'alerte rangé dans une constante : un champ `key: "…"` littéral ressemble à un secret
// pour le contrôle anti-secrets.
const NOTAIRES_STALE = "pipeline.source.notaires.stale_listings";

const COUNTS: AdminDashboardCountsData = {
  checkedAt: "2026-09-19T08:00:00.000Z",
  counts: {
    sales: 12,
    documents: 8,
    extractions: 5,
    riskOccurrences: 1,
    scoreFactors: 4,
    runs: 1,
  },
};

beforeEach(() => {
  mocks.fetchRuns.mockResolvedValue(RUNS);
  mocks.fetchCounts.mockResolvedValue(COUNTS);
  mocks.startScroll.mockResolvedValue({ message: "Traitement demandé", run: RUNS.runs[0] });
  mocks.fetchReadiness.mockResolvedValue({
    operations: {
      openAlertCount: 1,
      alerts: [
        {
          key: NOTAIRES_STALE,
          category: "import",
          severity: "warning",
          status: "open",
          deliveryStatus: "delivered",
          lastSeenAt: "2026-09-19T07:30:00.000Z",
        },
      ],
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderOperations() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminOperationsPage />
    </QueryClientProvider>,
  );
}

describe("AdminOperationsPage", () => {
  it("loads runs, but not the table counts until the Documents tab", async () => {
    renderOperations();
    await screen.findByRole("heading", { name: "Lancer une collecte" });
    await waitFor(() => expect(mocks.fetchRuns).toHaveBeenCalledTimes(1));
    expect(mocks.fetchCounts).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Documents" }));
    expect(await screen.findByText("Documents indexés")).toBeTruthy();
    await waitFor(() => expect(mocks.fetchCounts).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("8")).toBeTruthy();
  });

  it("shows neither the AI summary coverage nor its backfill, both removed from the pipeline", async () => {
    renderOperations();

    expect(await screen.findByRole("button", { name: "Relancer" })).toBeTruthy();
    expect(screen.queryByText(/couverture IA/i)).toBeNull();
    expect(screen.queryByLabelText(/des synthèses prêtes/)).toBeNull();
    expect(screen.queryByText(/annonces? à traiter/)).toBeNull();
    expect(screen.queryByText(/Synthèse IA/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Lancer le backfill" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enrichissement IA" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Alertes" }));
    expect(await screen.findByRole("heading", { name: "Alertes ouvertes" })).toBeTruthy();
    expect(screen.queryByText("Synthèses IA à traiter")).toBeNull();
  });

  it("exposes its sections as tabs and loads the open alerts only on the Alertes tab", async () => {
    renderOperations();
    const collections = await screen.findByRole("tab", { name: "Collectes" });
    expect(collections.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tablist", { name: "Rubriques des opérations" })).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(collections.id);
    expect(mocks.fetchReadiness).not.toHaveBeenCalled();

    fireEvent.keyDown(collections, { key: "ArrowLeft" });
    const alerts = screen.getByRole("tab", { name: "Alertes" });
    expect(alerts.getAttribute("aria-selected")).toBe("true");
    expect(collections.getAttribute("aria-selected")).toBe("false");

    expect(
      await screen.findByText("Source notaires : fiches non revérifiées à temps"),
    ).toBeTruthy();
    expect(mocks.fetchReadiness).toHaveBeenCalledTimes(1);
    // Les trois compteurs d'exécutions, répétés de l'accueil, ont laissé place aux alertes.
    expect(screen.queryByText("Runs en file")).toBeNull();
    expect(screen.queryByText("Runs échoués récents")).toBeNull();
  });

  it("refreshes the active dashboard queries from the section toolbar", async () => {
    renderOperations();
    await screen.findByRole("heading", { name: "Lancer une collecte" });

    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));

    await waitFor(() => expect(mocks.fetchRuns).toHaveBeenCalledTimes(2));
  });

  it("refreshes the run history after a rejected dispatch", async () => {
    mocks.startScroll.mockRejectedValue(new Error("GitHub Actions a répondu HTTP 403"));
    renderOperations();
    await screen.findByRole("button", { name: "Relancer" });
    fireEvent.click(screen.getByRole("button", { name: "Lancer" }));
    await waitFor(() => expect(mocks.fetchRuns).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["running", "avoventes"],
    ["queued", "all"],
    ["failed", "source-detail-worker"],
    ["failed", "llm-description-backfill"],
    ["failed", null],
  ])("does not restart %s / %s as a full collection", async (status, source) => {
    mocks.fetchRuns.mockResolvedValue({
      ...RUNS,
      runs: [{ ...RUNS.runs[0], status, source }],
    });
    renderOperations();
    const restart = await screen.findByRole("button", { name: "Relancer" });
    expect((restart as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(restart);
    expect(mocks.startScroll).not.toHaveBeenCalled();
  });

  it.each(["llm_backfill", "llm_description_backfill"])(
    "never restarts a former AI description backfill (%s)",
    async (mode) => {
      mocks.fetchRuns.mockResolvedValue({
        ...RUNS,
        runs: [
          {
            ...RUNS.runs[0],
            source: "llm-description-backfill",
            status: "failed",
            summary: { mode, limit: 7 },
          },
        ],
      });
      renderOperations();
      const restart = await screen.findByRole("button", { name: "Relancer" });
      expect((restart as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(restart);
      expect(mocks.startScroll).not.toHaveBeenCalled();
    },
  );
});
