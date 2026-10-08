// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminDashboardData } from "@/lib/admin.functions";
import { AdminDashboardPage } from "@/routes/admin";

const mocks = vi.hoisted(() => ({
  fetchDashboard: vi.fn(),
  fetchSubscriptions: vi.fn(),
  fetchReferrals: vi.fn(),
  fetchPrivacy: vi.fn(),
  publicationResult: vi.fn(),
  startScroll: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicPanelStub() {
      return <div data-testid="lazy-admin-panel" />;
    },
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

vi.mock("@/lib/router-compat", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { email: "admin@example.test" } }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchAdminDashboard: mocks.fetchDashboard,
  fetchAdminSubscriptions: mocks.fetchSubscriptions,
  fetchAdminLawyerReferralRequests: mocks.fetchReferrals,
  fetchAdminPrivacyRequests: mocks.fetchPrivacy,
  fetchAdminPublicationRequests: mocks.publicationResult,
  reviewAdminPublicationRequest: vi.fn(),
  startAdminScrollRequest: mocks.startScroll,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: (...args: unknown[]) => mocks.publicationResult(...args),
        }),
      }),
    }),
    storage: { from: () => ({ createSignedUrl: vi.fn() }) },
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const DASHBOARD: AdminDashboardData = {
  checkedAt: "2026-09-19T08:00:00.000Z",
  adminEmail: "admin@example.test",
  runner: { instantDispatchConfigured: true, mode: "queue_worker" },
  stats: {
    sales: 12,
    documents: 8,
    extractions: 5,
    riskOccurrences: 1,
    scoreFactors: 4,
    runs: 1,
    queuedRuns: 0,
    runningRuns: 0,
    failedRuns: 0,
    aiDescriptions: {
      expectedPromptVersion: "v1",
      total: 10,
      activeOrUpcoming: 10,
      ready: 10,
      missing: 0,
      promptVersionMismatch: 0,
      backfillRemaining: 0,
    },
  },
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

beforeEach(() => {
  mocks.fetchDashboard.mockResolvedValue(DASHBOARD);
  mocks.fetchSubscriptions.mockResolvedValue({ subscriptions: [] });
  mocks.fetchReferrals.mockResolvedValue({ requests: [], lawyers: [] });
  mocks.fetchPrivacy.mockResolvedValue({ requests: [] });
  mocks.publicationResult.mockResolvedValue({
    requests: [],
    pendingCount: 0,
    totalCount: 0,
    hasMore: false,
  });
  mocks.startScroll.mockResolvedValue({ message: "Traitement demandé", run: DASHBOARD.runs[0] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminDashboardPage", () => {
  it("loads publications beyond 100 in bounded pages and resets pagination with the filter", async () => {
    mocks.publicationResult.mockImplementation(async ({ offset, limit, status }) => ({
      requests: Array.from({ length: 30 }, (_, index) => ({
        id: `${status}-${offset + index}`,
        title: `${status} publication ${offset + index}`,
        status: "pending",
        created_at: "2026-10-04T12:00:00Z",
        document_types: [],
        promotion_options: [],
        submitted_documents: [],
      })),
      offset,
      limit,
      totalCount: 120,
      pendingCount: 120,
      hasMore: offset + limit < 120,
    }));

    renderAdmin("publications");
    await screen.findByRole("heading", { name: "all publication 0" });
    for (const last of [59, 89, 119]) {
      fireEvent.click(await screen.findByRole("button", { name: "Charger 30 de plus" }));
      await screen.findByRole("heading", { name: `all publication ${last}` });
    }
    expect(screen.getAllByRole("article")).toHaveLength(120);
    expect(
      mocks.publicationResult.mock.calls.map(([input]) => [input.offset, input.limit]),
    ).toEqual([
      [0, 30],
      [30, 30],
      [60, 30],
      [90, 30],
    ]);
    expect(screen.queryByRole("button", { name: "Charger 30 de plus" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "En attente" }));
    await screen.findByRole("heading", { name: "pending publication 0" });
    expect(screen.getAllByRole("article")).toHaveLength(30);
    expect(mocks.publicationResult).toHaveBeenLastCalledWith({
      status: "pending",
      search: "",
      offset: 0,
      limit: 30,
    });
  });

  it("does not report a healthy system while the overview is loading", () => {
    mocks.fetchDashboard.mockReturnValue(new Promise(() => {}));
    mocks.fetchSubscriptions.mockReturnValue(new Promise(() => {}));
    mocks.fetchReferrals.mockReturnValue(new Promise(() => {}));
    mocks.fetchPrivacy.mockReturnValue(new Promise(() => {}));
    mocks.publicationResult.mockReturnValue(new Promise(() => {}));

    renderAdmin();

    expect(screen.getByRole("heading", { name: "Vérification de la santé…" })).toBeTruthy();
    expect(screen.queryByText("Tous les systèmes sont opérationnels")).toBeNull();
    expect(screen.getAllByText("…").length).toBeGreaterThan(0);
  });

  it("shows a retryable error instead of a false healthy state", async () => {
    mocks.fetchDashboard.mockRejectedValue(new Error("dashboard indisponible"));

    renderAdmin();

    expect((await screen.findByRole("alert", {}, { timeout: 5_000 })).textContent).toContain(
      "dashboard indisponible",
    );
    expect(screen.getByRole("heading", { name: "État de santé indisponible" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Réessayer" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Tous les systèmes sont opérationnels")).toBeNull();
  });

  it("keeps partial overview failures visible instead of turning them into zero priorities", async () => {
    mocks.fetchSubscriptions.mockRejectedValue(new Error("abonnements indisponibles"));
    mocks.publicationResult.mockRejectedValue(new Error("publications indisponibles"));

    renderAdmin();

    expect(await screen.findByText(/Accès actifs indisponibles pour le moment/)).toBeTruthy();
    expect(await screen.findByText("Les priorités sont partiellement indisponibles.")).toBeTruthy();
    expect(screen.queryByText("Aucune action prioritaire pour le moment.")).toBeNull();
  });

  it("refreshes the active dashboard query from the section toolbar", async () => {
    renderAdmin("operations");
    await screen.findByRole("heading", { name: "Lancer une collecte" });

    const refresh = screen.getByRole("button", { name: "Actualiser" });
    fireEvent.click(refresh);

    await waitFor(() => expect(mocks.fetchDashboard).toHaveBeenCalledTimes(2));
  });

  it("refreshes the run history after a rejected dispatch", async () => {
    mocks.startScroll.mockRejectedValue(new Error("GitHub Actions a répondu HTTP 403"));
    renderAdmin("operations");
    await screen.findByRole("button", { name: "Relancer" });
    fireEvent.click(screen.getByRole("button", { name: "Lancer" }));
    await waitFor(() => expect(mocks.fetchDashboard).toHaveBeenCalledTimes(2));
  });

  it.each(["llm_backfill", "llm_description_backfill"])(
    "restarts an AI enrichment (%s) with its original batch size",
    async (mode) => {
      mocks.fetchDashboard.mockResolvedValue({
        ...DASHBOARD,
        runs: [
          {
            ...DASHBOARD.runs[0],
            source: "llm-description-backfill",
            status: "failed",
            summary: { mode, limit: 7 },
          },
        ],
      });
      renderAdmin("operations");
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
    mocks.fetchDashboard.mockResolvedValue({
      ...DASHBOARD,
      runs: [{ ...DASHBOARD.runs[0], status, source }],
    });
    renderAdmin("operations");
    const restart = await screen.findByRole("button", { name: "Relancer" });
    expect((restart as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(restart);
    expect(mocks.startScroll).not.toHaveBeenCalled();
  });

  it("only launches enrichment with a valid integer batch size", async () => {
    mocks.fetchDashboard.mockResolvedValue({
      ...DASHBOARD,
      stats: {
        ...DASHBOARD.stats,
        aiDescriptions: { ...DASHBOARD.stats.aiDescriptions, backfillRemaining: 5 },
      },
    });
    renderAdmin("operations");
    const limit = await screen.findByRole("spinbutton", { name: "Taille du lot" });
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

function renderAdmin(initialView: "overview" | "operations" | "publications" = "overview") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminDashboardPage initialView={initialView} />
    </QueryClientProvider>,
  );
}
