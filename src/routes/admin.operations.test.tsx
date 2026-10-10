// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AdminDashboardAiData,
  AdminDashboardCountsData,
  AdminDashboardRunsData,
} from "@/lib/admin.functions";
import { AdminOperationsPage } from "@/routes/admin.operations";

const mocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  fetchAi: vi.fn(),
  fetchCounts: vi.fn(),
  startScroll: vi.fn(),
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
  fetchAdminDashboardAi: mocks.fetchAi,
  fetchAdminDashboardCounts: mocks.fetchCounts,
  startAdminScrollRequest: mocks.startScroll,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

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

const aiData = (backfillRemaining: number): AdminDashboardAiData => ({
  checkedAt: "2026-09-19T08:00:00.000Z",
  aiDescriptions: {
    expectedPromptVersion: "v1",
    total: 10,
    activeOrUpcoming: 10,
    ready: 10 - backfillRemaining,
    missing: 0,
    promptVersionMismatch: 0,
    backfillRemaining,
  },
});

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
  mocks.fetchAi.mockResolvedValue(aiData(0));
  mocks.fetchCounts.mockResolvedValue(COUNTS);
  mocks.startScroll.mockResolvedValue({ message: "Traitement demandé", run: RUNS.runs[0] });
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
  it("loads runs and AI coverage, but not the table counts until the Documents tab", async () => {
    renderOperations();
    await screen.findByRole("heading", { name: "Lancer une collecte" });
    await waitFor(() => expect(mocks.fetchAi).toHaveBeenCalledTimes(1));
    expect(mocks.fetchRuns).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCounts).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Documents" }));
    expect(await screen.findByText("Documents indexés")).toBeTruthy();
    await waitFor(() => expect(mocks.fetchCounts).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("8")).toBeTruthy();
    expect(mocks.fetchAi).toHaveBeenCalledTimes(1);
  });

  it("shows the runs while the slow AI coverage is still being computed", async () => {
    mocks.fetchAi.mockReturnValue(new Promise(() => {}));
    renderOperations();

    expect(await screen.findByRole("button", { name: "Relancer" })).toBeTruthy();
    expect(screen.getByText("Calcul de la couverture IA en cours…")).toBeTruthy();
    const launch = screen.getByRole("button", { name: "Lancer le backfill" });
    expect((launch as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the runs usable when the AI coverage fails", async () => {
    mocks.fetchAi.mockRejectedValue(new Error("délai dépassé"));
    renderOperations();

    expect(
      await screen.findByText("Couverture IA indisponible pour le moment.", {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Relancer" })).toBeTruthy();
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

  it.each(["llm_backfill", "llm_description_backfill"])(
    "restarts an AI enrichment (%s) with its original batch size",
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
      fireEvent.click(await screen.findByRole("button", { name: "Relancer" }));
      await waitFor(() =>
        expect(mocks.startScroll).toHaveBeenCalledWith({
          data: { source: "all", mode: "llm_backfill", limit: 7 },
        }),
      );
    },
  );

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

  it("only launches enrichment with a valid integer batch size", async () => {
    mocks.fetchAi.mockResolvedValue(aiData(5));
    renderOperations();
    const limit = await screen.findByRole("spinbutton", { name: "Taille du lot" });
    await screen.findByText("5 annonces à traiter");
    const launch = screen.getByRole("button", { name: "Lancer le backfill" });
    for (const value of ["", "0", "2.5", "101"]) {
      fireEvent.change(limit, { target: { value } });
      expect((launch as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(launch);
    }
    expect(mocks.startScroll).not.toHaveBeenCalled();
    fireEvent.change(limit, { target: { value: "3" } });
    fireEvent.click(launch);
    await waitFor(() =>
      expect(mocks.startScroll).toHaveBeenCalledWith({
        data: { source: "all", mode: "llm_backfill", limit: 3 },
      }),
    );
  });
});
