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
  AdminSectionHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
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
  startAdminScrollRequest: vi.fn(),
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
  mocks.publicationResult.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminDashboardPage", () => {
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
});

function renderAdmin(initialView: "overview" | "operations" = "overview") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminDashboardPage initialView={initialView} />
    </QueryClientProvider>,
  );
}
