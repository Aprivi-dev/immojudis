// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminCatalogueReadinessPanel } from "./AdminCatalogueReadinessPanel";
import { AdminCatalogueReadinessSettings } from "./AdminCatalogueReadinessSettings";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), action: vi.fn() }));

vi.mock("@/lib/client-api", () => ({
  fetchAdminCatalogueReadiness: mocks.fetch,
  runAdminCatalogueReadinessActionClient: mocks.action,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function overview(enforcementEnabled = true) {
  return {
    policy: {
      enforcementEnabled,
      policyVersion: "v1",
      premiumReadyMin: 70,
      minimumScoreConfidence: 0.8,
      updatedAt: "2026-10-08T08:00:00Z",
    },
    counts: { unassessed: 0, internal_only: 1, needs_enrichment: 1, premium_ready: 3 },
    activeSales: 5,
    pendingEvaluations: 0,
    canEnableEnforcement: true,
    total: 0,
    offset: 0,
    limit: 50,
    hasMore: false,
    items: [],
  };
}

function renderWithClient(...children: ReactNode[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe("AdminCatalogueReadinessSettings (onglet Réglages)", () => {
  it("affiche le seuil, les indicateurs et la politique, sans la file de travail", async () => {
    mocks.fetch.mockResolvedValue(overview());
    renderWithClient(<AdminCatalogueReadinessSettings />);

    expect(await screen.findByText("Seuil de maturité du catalogue")).toBeTruthy();
    expect(screen.getByText("Prêtes Analyse")).toBeTruthy();
    expect(screen.getByText(/seuil 70\/100/)).toBeTruthy();
    expect(screen.queryByText("File d’enrichissement")).toBeNull();
  });

  it("n'affiche pas le seuil dans la file de travail de « À contacter »", async () => {
    mocks.fetch.mockResolvedValue(overview());
    renderWithClient(<AdminCatalogueReadinessPanel />);

    expect(await screen.findByText("File d’enrichissement")).toBeTruthy();
    expect(screen.queryByText("Seuil de maturité du catalogue")).toBeNull();
    expect(screen.queryByRole("button", { name: /le filtre/ })).toBeNull();
  });

  it("bascule le filtre avec la même action qu'avant", async () => {
    mocks.fetch.mockResolvedValue(overview(true));
    mocks.action.mockResolvedValue({});
    renderWithClient(<AdminCatalogueReadinessSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Désactiver le filtre" }));

    await waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action.mock.calls[0][0]).toEqual({ action: "set_enforcement", enabled: false });
  });

  it("partage une seule requête avec la file quand les deux sont affichées", async () => {
    mocks.fetch.mockResolvedValue(overview());
    renderWithClient(<AdminCatalogueReadinessPanel />, <AdminCatalogueReadinessSettings />);

    await screen.findByText("Seuil de maturité du catalogue");
    await screen.findByText("File d’enrichissement");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
