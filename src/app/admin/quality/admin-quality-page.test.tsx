// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminQualityPage } from "./admin-quality-page";

const mocks = vi.hoisted(() => ({ quality: vi.fn(), sales: vi.fn(), valuation: vi.fn() }));
vi.mock("@/lib/client-api", () => ({
  fetchAdminDataQuality: mocks.quality,
  fetchValuationAdminOverview: mocks.valuation,
}));
vi.mock("@/lib/queries", () => ({ getSales: mocks.sales }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminShell: ({
    children,
    onRefresh,
    adminEmail,
  }: {
    children: ReactNode;
    onRefresh: () => void;
    adminEmail?: string;
  }) => (
    <main>
      <p>Adresse : {adminEmail}</p>
      <button onClick={onRefresh}>Actualiser</button>
      {children}
    </main>
  ),
}));
// Le tableau des retours par vente a son propre test (AdminSaleFeedbackPanel.test.tsx).
vi.mock("@/components/admin/AdminSaleFeedbackPanel", () => ({
  AdminSaleFeedbackPanel: () => null,
}));
// Les contrôles qualité du catalogue ont leur propre test (AdminCatalogueQualityPanel.test.tsx).
vi.mock("@/components/admin/AdminCatalogueQualityPanel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/admin/AdminCatalogueQualityPanel")>()),
  AdminCatalogueQualityPanel: () => null,
}));
// L'onglet Pépites a son propre test (AdminPepitesPanel.test.tsx).
vi.mock("@/components/admin/AdminPepitesPanel", () => ({
  PEPITES_QUERY_KEY: ["admin-pepites"],
  AdminPepitesPanel: () => <p>Panneau des pépites</p>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
});

function renderPage() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminQualityPage />
    </QueryClientProvider>,
  );
}

describe("AdminQualityPage onglets", () => {
  it("ouvre l'onglet Pépites demandé par l'adresse sans charger les indicateurs", async () => {
    window.history.replaceState(null, "", "/admin/quality?onglet=pepites");
    renderPage();

    expect(await screen.findByText("Panneau des pépites")).toBeTruthy();
    // L'adresse de l'administrateur reste affichée, comme sur l'ancienne page des pépites.
    expect(screen.getByText("Adresse : admin@example.test")).toBeTruthy();
    const tabs = screen.getByRole("tablist", { name: "Rubriques de la qualité" });
    expect(tabs).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Pépites" }).getAttribute("aria-selected")).toBe("true");
    expect(mocks.quality).not.toHaveBeenCalled();

    mocks.quality.mockResolvedValue(emptyReport);
    mocks.valuation.mockResolvedValue({
      runtime: { status: "healthy", estimates: 0, driftSignals: [] },
      activeModels: [],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Indicateurs" }));
    await waitFor(() => expect(mocks.quality).toHaveBeenCalled());
    expect(window.location.search).toBe("?onglet=indicateurs");
  });

  it("ouvre les indicateurs par défaut", async () => {
    mocks.quality.mockResolvedValue(emptyReport);
    mocks.valuation.mockResolvedValue({
      runtime: { status: "healthy", estimates: 0, driftSignals: [] },
      activeModels: [],
    });
    renderPage();

    expect(await screen.findByText("Surface exploitable")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Indicateurs" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByText("Panneau des pépites")).toBeNull();
  });
});

describe("AdminQualityPage libellés", () => {
  it("parle en clair des estimations, sans jargon technique", async () => {
    mocks.quality.mockResolvedValue(emptyReport);
    mocks.valuation.mockResolvedValue({
      runtime: {
        status: "healthy",
        estimates: 12,
        hybridSharePct: 40,
        actionableSharePct: 80,
        driftSignals: [],
      },
      activeModels: [],
    });
    renderPage();

    expect(await screen.findByText("Fonctionnement normal")).toBeTruthy();
    expect(screen.getByText("Avec le modèle appris")).toBeTruthy();
    expect(screen.getByText("Estimations exploitables")).toBeTruthy();
    expect(screen.getByText(/occupation et score de confiance/)).toBeTruthy();
    const text = document.body.textContent ?? "";
    for (const jargon of ["LightGBM", "Runtime", "Actionnables", "confiance score"]) {
      expect(text).not.toContain(jargon);
    }
  });
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
    expect(screen.getByText("25 %")).toBeTruthy();
    expect(mocks.sales).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("no longer shows the AI summary coverage, which the pipeline stopped producing", async () => {
    mocks.quality.mockResolvedValue({
      ...emptyReport,
      sampleSize: 4,
      sourceCoverage: [
        {
          source: "avoventes",
          count: 4,
          sharePct: 100,
          missingLocation: 0,
          missingSurface: 1,
          missingDocuments: 0,
          missingRichDocuments: 0,
          missingOccupation: 2,
          missingConfidence: 0,
          averageConfidencePct: 80,
          weakCount: 2,
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
    expect(await screen.findByText("avoventes")).toBeTruthy();
    expect(screen.getByText("2 dossiers à reprendre")).toBeTruthy();
    expect(screen.getByText("Surface exploitable")).toBeTruthy();
    expect(screen.queryByText(/Synthèse IA/)).toBeNull();
    expect(screen.queryByText("IA", { exact: true })).toBeNull();
  });
});
