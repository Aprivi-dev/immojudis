// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminDashboardRunsData } from "@/lib/admin.functions";
import { AdminHomePage } from "./admin-home-page";

const mocks = vi.hoisted(() => ({ fetchRuns: vi.fn() }));

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

beforeEach(() => {
  mocks.fetchRuns.mockResolvedValue(RUNS);
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

describe("AdminHomePage", () => {
  it("is a light landing page: one fast request and a link to every view", async () => {
    renderHome();
    await screen.findByRole("heading", { name: "Aucun échec récent détecté" });

    expect(mocks.fetchRuns).toHaveBeenCalledTimes(1);
    const nav = screen.getByRole("navigation", { name: "Vues de l’administration" });
    const hrefs = Array.from(nav.querySelectorAll("a")).map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/admin/operations",
      "/admin/agent-ia",
      "/admin/quality",
      "/admin/publications",
      "/admin/clients",
      "/admin/lawyers",
      "/admin/compliance",
      "/admin/settings",
    ]);
  });

  it("does not report a healthy system while the overview is loading", () => {
    mocks.fetchRuns.mockReturnValue(new Promise(() => {}));

    renderHome();

    expect(screen.getByRole("heading", { name: "Vérification de la santé…" })).toBeTruthy();
    expect(screen.queryByText("Aucun échec récent détecté")).toBeNull();
  });

  it("shows a retryable error instead of a false healthy state", async () => {
    mocks.fetchRuns.mockRejectedValue(new Error("dashboard indisponible"));

    renderHome();

    expect((await screen.findByRole("alert", {}, { timeout: 5_000 })).textContent).toContain(
      "dashboard indisponible",
    );
    expect(screen.getByRole("heading", { name: "État de santé indisponible" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Réessayer" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Aucun échec récent détecté")).toBeNull();
  });

  it("asks for an intervention when a recent run failed", async () => {
    mocks.fetchRuns.mockResolvedValue({
      ...RUNS,
      stats: { queuedRuns: 0, runningRuns: 0, failedRuns: 2 },
    });

    renderHome();

    await screen.findByRole("heading", { name: "Une intervention est requise" });
    expect(screen.queryByText("Aucun échec récent détecté")).toBeNull();
  });
});
