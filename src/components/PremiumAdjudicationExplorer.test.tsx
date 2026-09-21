// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdjudicationPriceStatisticsDirectoryResponse } from "@/lib/adjudication-price-statistics";

const mocks = vi.hoisted(() => ({ useAuth: vi.fn(), fetchPlan: vi.fn(), fetchDirectory: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/client-api", () => ({ fetchAccessPlan: mocks.fetchPlan }));
vi.mock("@/lib/adjudication-price-statistics-client", () => ({
  fetchAdjudicationPriceStatisticsDirectory: mocks.fetchDirectory,
}));
vi.mock("@/components/BillingActions", () => ({
  BillingActions: () => <button>Débloquer Analyse</button>,
}));

import { PremiumAdjudicationExplorer } from "./PremiumAdjudicationExplorer";

const scope = (
  scopeType: "national" | "tribunal",
  courtCode: string | null,
  label: string,
  sampleSize: number,
) => ({
  scopeType,
  courtCode,
  label,
  judicialRegion: null,
  periodStart: "2023-09-20",
  periodEnd: "2026-09-20",
  sampleSize,
  reliability: "extended" as const,
  metrics: {
    medianHammerToStartingRatio: 1.93,
    aboveStartingRate: 0.89,
    atLeastDoubleRate: 0.48,
    medianHammerPriceEur: 126000,
    medianStartingPriceEur: 55000,
  },
});
const directory: AdjudicationPriceStatisticsDirectoryResponse = {
  national: scope("national", null, "France entière", 3798),
  tribunals: [
    scope("tribunal", "paris", "TJ Paris", 494),
    scope("tribunal", "bordeaux", "TJ Bordeaux", 146),
  ],
  meta: {
    sourceName: "licitor",
    sourceLabel: "Résultats d’adjudication publiés par Licitor",
    methodologyVersion: "licitor_canonical_price_statistics_v1",
    builtAt: "2026-09-20T18:58:53.000Z",
    reviewedAt: "2026-09-20T18:59:39.000Z",
    experimental: true,
    warning:
      "Source tierce non officielle : prix publiés par Licitor, non vérifiés auprès du greffe et non présentés comme définitifs. Agrégats descriptifs uniquement, sans valeur prédictive ni estimation du bien.",
  },
};

function renderExplorer(selectedCourtCode: string | null = "bordeaux") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <PremiumAdjudicationExplorer selectedCourtCode={selectedCourtCode} />
    </QueryClientProvider>,
  );
}

describe("PremiumAdjudicationExplorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({ session: { user: { id: "premium-user" } }, loading: false });
    mocks.fetchPlan.mockResolvedValue({ plan: { hasAnalysisAccess: true } });
    mocks.fetchDirectory.mockResolvedValue(directory);
  });
  afterEach(cleanup);

  it("n’expose aucun chiffre protégé au visiteur ou au plan Découverte", async () => {
    mocks.useAuth.mockReturnValue({ session: null, loading: false });
    renderExplorer();
    expect(screen.getByText(/résultats chiffrés sont réservés/i)).toBeTruthy();
    expect(screen.queryByText(/126\s?000/)).toBeNull();
    expect(mocks.fetchDirectory).not.toHaveBeenCalled();
    cleanup();

    mocks.useAuth.mockReturnValue({ session: { user: { id: "free-user" } }, loading: false });
    mocks.fetchPlan.mockResolvedValue({ plan: { hasAnalysisAccess: false } });
    renderExplorer();
    expect(await screen.findByText(/résultats chiffrés sont réservés/i)).toBeTruthy();
    expect(mocks.fetchDirectory).not.toHaveBeenCalled();
  });

  it("affiche la médiane France et le tribunal exact, puis change de tribunal", async () => {
    renderExplorer();
    const heading = await screen.findByRole("heading", {
      name: "Prix d’adjudication par tribunal",
    });
    expect(heading).toBeTruthy();
    const selected = (await screen.findByRole("combobox", {
      name: "Tribunal",
    })) as HTMLSelectElement;
    expect(selected.value).toBe("bordeaux");
    expect(screen.getAllByText(/126\s?000/).length).toBeGreaterThan(0);
    const panel = screen.getByRole("region", { name: "Prix d’adjudication par tribunal" });
    expect(within(panel).getByText(/146 prix publiés/)).toBeTruthy();
    fireEvent.change(selected, { target: { value: "paris" } });
    expect(selected.value).toBe("paris");
    expect(within(panel).getByText(/494 prix publiés/)).toBeTruthy();
    expect(within(panel).getByText(/non vérifiés auprès du greffe/i)).toBeTruthy();
  });
});
