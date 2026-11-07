// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleAnalysisSet, SaleAnalysisSetListResponse } from "@/lib/sale-analysis-sets";
import { ComparisonsPage } from "./ComparisonsPage";

const mocks = vi.hoisted(() => ({
  userId: "user-1",
  fetch: vi.fn(),
  enableShare: vi.fn(),
  disableShare: vi.fn(),
  deleteSet: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: mocks.userId }, loading: false }),
}));

vi.mock("@/lib/client-api", () => ({
  fetchSaleAnalysisSets: mocks.fetch,
  enableSaleComparisonShare: mocks.enableShare,
  disableSaleComparisonShare: mocks.disableShare,
  deleteSaleAnalysisSet: mocks.deleteSet,
}));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({ sets: [], limit: 1, itemLimit: 3 });
  mocks.enableShare.mockResolvedValue({
    enabled: true,
    url: "https://www.immojudis.fr/comparaisons/shared-token",
    expiresAt: "2026-11-01T12:00:00.000Z",
  });
  mocks.disableShare.mockResolvedValue({ enabled: false, url: null, expiresAt: null });
  mocks.deleteSet.mockResolvedValue({ ok: true });
});

function renderPage(response: SaleAnalysisSetListResponse = { sets: [], limit: 1, itemLimit: 3 }) {
  mocks.fetch.mockResolvedValue(response);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ComparisonsPage />
    </QueryClientProvider>,
  );
}

function comparisonSet(overrides: Partial<SaleAnalysisSet> = {}): SaleAnalysisSet {
  return {
    id: "7d335032-e935-4550-9347-ed22b0f63449",
    user_id: "user-1",
    name: "Maisons à Bordeaux",
    analysis_kind: "comparison",
    notes: null,
    assumptions: {},
    summary_snapshot: {},
    is_archived: false,
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-02T10:00:00.000Z",
    items: [
      {
        id: "item-1",
        analysis_set_id: "7d335032-e935-4550-9347-ed22b0f63449",
        user_id: "user-1",
        sale_id: "0d335032-e935-4550-9347-ed22b0f63440",
        item_order: 0,
        decision_status: "shortlisted",
        user_max_bid_eur: 120_000,
        target_yield_pct: null,
        expected_margin_pct: null,
        notes: null,
        created_at: "2026-09-01T10:00:00.000Z",
        updated_at: "2026-09-02T10:00:00.000Z",
        sale: {
          id: "0d335032-e935-4550-9347-ed22b0f63440",
          title: "Maison judiciaire",
          city: "Bordeaux",
          department: "33",
          startingPriceEur: 100_000,
          saleDate: "2026-10-15T09:00:00.000Z",
          investmentScore: 82,
        },
      },
    ],
    summary: {
      itemCount: 1,
      totalStartingPriceEur: 100_000,
      pricedItemCount: 1,
      totalUserMaxBidEur: 120_000,
      averageInvestmentScore: 82,
      earliestSaleDate: "2026-10-15T09:00:00.000Z",
      cities: ["Bordeaux"],
    },
    sharing: { enabled: false, sharedAt: null, expiresAt: null },
    ...overrides,
  } as SaleAnalysisSet;
}

describe("ComparisonsPage", () => {
  it("shows a loading state while the saved comparisons are fetched", () => {
    mocks.fetch.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ComparisonsPage />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("status").textContent).toContain("Chargement de vos comparaisons");
  });

  it("lists a saved comparison, opens its sale detail and creates a share link", async () => {
    renderPage({ sets: [comparisonSet()], limit: 1, itemLimit: 3 });

    expect(await screen.findByRole("heading", { name: "Maisons à Bordeaux" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Maison judiciaire/ }).getAttribute("href")).toBe(
      "/sales/0d335032-e935-4550-9347-ed22b0f63440",
    );
    // L'origine (« Retour à mes comparaisons ») s'ajoute dès que le lien est approché.
    fireEvent.pointerEnter(screen.getByRole("link", { name: /Maison judiciaire/ }));
    expect(screen.getByRole("link", { name: /Maison judiciaire/ }).getAttribute("href")).toBe(
      "/sales/0d335032-e935-4550-9347-ed22b0f63440?from=%2Fcomparaisons",
    );
    expect(screen.getByText(/Plafonds saisis/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Créer un lien de partage" }));

    await waitFor(() =>
      expect(mocks.enableShare).toHaveBeenCalledWith({
        setId: "7d335032-e935-4550-9347-ed22b0f63449",
      }),
    );
    expect(
      (await screen.findByRole("link", { name: "Ouvrir le partage" })).getAttribute("href"),
    ).toBe("https://www.immojudis.fr/comparaisons/shared-token");
  });

  it("shows a starting price of 0 as not communicated, never as 0 €", async () => {
    const base = comparisonSet();
    renderPage({
      sets: [
        comparisonSet({
          items: base.items.map((item) => ({
            ...item,
            sale: item.sale ? { ...item.sale, startingPriceEur: 0 } : item.sale,
          })),
          summary: { ...base.summary, totalStartingPriceEur: null, pricedItemCount: 0 },
        }),
      ],
      limit: 1,
      itemLimit: 3,
    });

    expect(await screen.findByText(/Mise à prix : Prix non communiqué/)).toBeTruthy();
    expect(screen.queryByText(/Mise à prix : 0/)).toBeNull();
    expect(screen.queryByText(/Total partiel/)).toBeNull();
  });

  it("flags a starting-price total that covers only some of the properties", async () => {
    const base = comparisonSet();
    renderPage({
      sets: [
        comparisonSet({
          summary: { ...base.summary, itemCount: 3, pricedItemCount: 2 },
        }),
      ],
      limit: 1,
      itemLimit: 3,
    });

    expect(await screen.findByText("Total partiel : 2 biens sur 3")).toBeTruthy();
  });

  it("shows no partial note when every property has a starting price", async () => {
    renderPage({ sets: [comparisonSet()], limit: 1, itemLimit: 3 });

    await screen.findByText("Mises à prix");
    expect(screen.queryByText(/Total partiel/)).toBeNull();
  });

  it("explains how to start when there are no saved comparisons", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Aucune comparaison enregistrée" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Ouvrir le catalogue" }).getAttribute("href")).toBe(
      "/sales",
    );
  });

  it("keeps the error state visible and retries the API request", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("Service momentanément indisponible"));
    mocks.fetch.mockResolvedValueOnce({ sets: [comparisonSet()], limit: 1, itemLimit: 3 });
    const view = renderPage();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Service momentanément indisponible",
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("heading", { name: "Maisons à Bordeaux" })).toBeTruthy();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("suit la mise en page des pages de compte et les couleurs de la charte (repasse design n° 12, 14, 15, 17)", async () => {
    const { container } = renderPage({
      sets: [
        comparisonSet({
          sharing: {
            enabled: true,
            sharedAt: "2026-10-01T10:00:00.000Z",
            expiresAt: "2026-11-30T10:00:00.000Z",
          },
        }),
      ],
      limit: 1,
      itemLimit: 3,
    });

    await screen.findByRole("heading", { name: "Maisons à Bordeaux" });
    const title = screen.getByRole("heading", { level: 1, name: "Mes comparaisons" });
    expect(title.previousElementSibling?.textContent).toBe("Mon espace");
    expect(screen.getByText(/Lien actif jusqu’au/).className).toContain("bg-success-tint");
    const remove = screen.getByRole("button", { name: "Supprimer" });
    expect(remove.className).toContain("text-danger");
    for (const name of ["Générer un nouveau lien", "Désactiver le lien", "Supprimer"]) {
      expect(screen.getByRole("button", { name }).className).toContain("min-h-11");
    }
    expect(container.innerHTML).not.toMatch(/\b(?:text|bg|border)-(?:red|amber|emerald)-\d/);
    expect(container.innerHTML).not.toMatch(/liquid-|glass-|text-\[11px\]/);
  });
});
