// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminQualityPage } from "@/routes/admin.quality";

const mocks = vi.hoisted(() => ({ quality: vi.fn(), sales: vi.fn(), valuation: vi.fn() }));
vi.mock("@/lib/client-api", () => ({
  fetchAdminDataQuality: mocks.quality,
  fetchValuationAdminOverview: mocks.valuation,
}));
vi.mock("@/lib/queries", () => ({ getSales: mocks.sales }));
vi.mock("@/lib/router-compat", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({ children, onRefresh }: { children: ReactNode; onRefresh: () => void }) => (
    <main>
      <button onClick={onRefresh}>Actualiser</button>
      {children}
    </main>
  ),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const emptyReport = {
  sampleSize: 0,
  fields: [],
  capabilities: [],
  sourceCoverage: [],
  prioritySales: [],
};

describe("AdminQualityPage error recovery", () => {
  it("reports failed priority and valuation diagnostics instead of healthy empty states", async () => {
    mocks.quality.mockRejectedValue(new Error("Qualité indisponible"));
    mocks.valuation.mockRejectedValue(new Error("Modèles indisponibles"));
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <AdminQualityPage />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/Les dossiers prioritaires n’ont pas pu être vérifiés/),
    ).toBeTruthy();
    expect(await screen.findByText(/Le diagnostic des estimations est indisponible/)).toBeTruthy();
    expect(screen.queryByText("Aucun dossier faible dans l'échantillon chargé.")).toBeNull();
    expect(screen.getByText("Estimations 24 h").parentElement?.textContent).toContain("—");

    mocks.quality.mockResolvedValue({ ...emptyReport, prioritySales: [] });
    mocks.valuation.mockResolvedValue({
      runtime: { status: "healthy", estimates: 12, driftSignals: [] },
      activeModels: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await waitFor(() =>
      expect(screen.queryByText(/Le diagnostic des estimations est indisponible/)).toBeNull(),
    );
    expect(screen.getByText("Estimations 24 h").parentElement?.textContent).toContain("12");
    expect(screen.getByText("Aucun dossier faible dans l'échantillon chargé.")).toBeTruthy();
  });
  it("renders compact priority summaries from the report without a second catalogue scan", async () => {
    mocks.quality.mockResolvedValue({
      ...emptyReport,
      sampleSize: 1200,
      prioritySales: [
        {
          id: "priority-1",
          title: "Appartement prioritaire",
          city: "Lyon",
          property_type: "apartment",
          score_confidence: 0.25,
          flags: ["confiance faible", "surface absente"],
        },
      ],
    });
    mocks.valuation.mockResolvedValue({
      runtime: { status: "healthy", estimates: 0, driftSignals: [] },
      activeModels: [],
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <AdminQualityPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Appartement prioritaire")).toBeTruthy();
    expect(screen.getByText("confiance faible · surface absente")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(mocks.sales).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
