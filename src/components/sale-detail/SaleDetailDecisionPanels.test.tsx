// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { SaleUnlockOfferProvider } from "./UnlockCallToAction";
import {
  AnalysisDecisionPanel,
  DiscoveryDecisionPanel,
  NonJudicialDecisionPanel,
} from "./SaleDetailDecisionPanels";

const mocks = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null, loading: false },
  fetchValuePreview: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/client-api", () => ({ fetchValuePreview: mocks.fetchValuePreview }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({ useAnalysisCheckoutOpen: () => true }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  mocks.auth = { user: null, loading: false };
});

const sale = {
  id: "11111111-2222-4333-8444-555555555555",
  starting_price_eur: 45_000,
  property_type: "apartment",
  app_surface_m2: 60,
  app_surface_kind: "habitable",
} as unknown as AuctionSale;

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("DiscoveryDecisionPanel", () => {
  it("does not call the value route for a visitor and invites them to create a free account", () => {
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(mocks.fetchValuePreview).not.toHaveBeenCalled();
    expect(screen.queryByText("Pas encore d’estimation")).toBeNull();
    const link = screen.getByRole("link", {
      name: "Créez un compte gratuit pour voir la fourchette de valeur",
    });
    expect(link.getAttribute("href")).toBe(
      `/login?redirect=${encodeURIComponent(`/sales/${sale.id}`)}&mode=investor&reason=fiche`,
    );
  });

  it("does not show the invitation while the session is still being restored", () => {
    mocks.auth = { user: null, loading: true };
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(screen.queryByRole("link", { name: /Créez un compte gratuit/ })).toBeNull();
    expect(mocks.fetchValuePreview).not.toHaveBeenCalled();
  });

  it("shows the value range to a signed-in account", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue({
      available: true,
      lowEur: 80_000,
      highEur: 100_000,
      discountPct: 40,
    });
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(await screen.findByText(/80\s000\s€\s–\s100\s000\s€/)).toBeTruthy();
    expect(mocks.fetchValuePreview).toHaveBeenCalledWith(sale.id);
    expect(screen.queryByRole("link", { name: /Créez un compte gratuit/ })).toBeNull();
  });

  it("keeps « Pas encore d’estimation » for an account without estimate", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue({ available: false });
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(await screen.findByText("Pas encore d’estimation")).toBeTruthy();
  });

  describe("unlock link", () => {
    const tribunalSale = { ...sale, sale_venue_type: "tribunal" } as unknown as AuctionSale;
    const offer = {
      saleId: sale.id,
      unlocked: false,
      unlockable: true,
      analysisAccess: false,
      limit: 3,
      used: 1,
      remaining: 2,
      periodStart: "2026-09-30T22:00:00.000Z",
      resetsAt: "2026-10-31T23:00:00.000Z",
    };

    it("links the ceiling row and the preview of a tribunal sale to the unlock card", () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue({ available: false });
      renderWithQuery(
        <SaleUnlockOfferProvider status={offer}>
          <DiscoveryDecisionPanel sale={tribunalSale} />
        </SaleUnlockOfferProvider>,
      );

      const links = screen.getAllByRole("link", {
        name: "Débloquer cette vente (il vous reste 2 sur 3)",
      });
      // The row of the ceiling, and the main link of the paid preview.
      expect(links).toHaveLength(2);
      for (const link of links) expect(link.getAttribute("href")).toBe("#debloquer");
    });

    it("keeps only the offer when the page has no unlock card", () => {
      renderWithQuery(<DiscoveryDecisionPanel sale={tribunalSale} />);

      expect(screen.queryByRole("link", { name: /Débloquer cette vente/ })).toBeNull();
      expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
    });

    it("does not offer the unlock for the preview of a sale without ceiling", () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue({ available: false });
      const notary = { ...sale, sale_venue_type: "notary" } as unknown as AuctionSale;
      renderWithQuery(
        <SaleUnlockOfferProvider status={offer}>
          <DiscoveryDecisionPanel sale={notary} />
        </SaleUnlockOfferProvider>,
      );

      // Only the hint of the ceiling row remains: the preview talks about comparables and works.
      expect(screen.getAllByRole("link", { name: /Débloquer cette vente/ })).toHaveLength(1);
    });
  });

  it("shows a zero starting price as to be confirmed", () => {
    renderWithQuery(<DiscoveryDecisionPanel sale={{ ...sale, starting_price_eur: 0 }} />);

    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(screen.queryByText(/0\s€/)).toBeNull();
  });
});

describe("AnalysisDecisionPanel", () => {
  const base = {
    sale,
    marketEstimate: null,
    marketLoading: false,
    worksBudget: 0,
    recommendedCeiling: 0,
    ceilingAvailable: false,
    onAdjust: () => undefined,
  };

  it("gives the reason instead of a bare « À compléter »", () => {
    renderWithQuery(
      <AnalysisDecisionPanel
        {...base}
        valueReason="surface manquante"
        ceilingGap={{ kind: "incomplete", reason: "surface manquante" }}
      />,
    );

    expect(screen.getAllByText("À compléter")).toHaveLength(2);
    expect(screen.getAllByText("surface manquante")).toHaveLength(2);
  });

  it("names the pending estimate", () => {
    renderWithQuery(
      <AnalysisDecisionPanel
        {...base}
        valueReason="estimation en cours"
        ceilingGap={{ kind: "incomplete", reason: "estimation en cours" }}
      />,
    );

    expect(screen.getAllByText("estimation en cours")).toHaveLength(2);
  });

  it("separates a missing input from a calculation without profitable bid", () => {
    renderWithQuery(
      <AnalysisDecisionPanel
        {...base}
        marketEstimate={{ actionable: true, estimatedValueEur: 100_000 } as never}
        valueReason="valeur de marché manquante"
        ceilingGap={{ kind: "unprofitable", reason: "aucune enchère rentable" }}
      />,
    );

    expect(screen.getByText("Marge de sécurité non tenue avec ces hypothèses")).toBeTruthy();
    expect(screen.queryByText("À compléter")).toBeNull();
  });

  it("calls the ceiling a simulation everywhere it is named", () => {
    const { container } = renderWithQuery(<AnalysisDecisionPanel {...base} />);

    expect(screen.getByText("Enchère plafond (simulation)")).toBeTruthy();
    expect(container.textContent).not.toContain("Plafond indicatif");
    expect(container.textContent).toContain("Enchère plafond (simulation), selon vos hypothèses");
    expect(container.textContent).not.toMatch(/Enchère plafond(?! \(simulation\))/);
  });

  it("shows a zero starting price as to be confirmed", () => {
    renderWithQuery(
      <AnalysisDecisionPanel {...base} sale={{ ...sale, starting_price_eur: 0 } as AuctionSale} />,
    );

    expect(screen.getByText("À confirmer")).toBeTruthy();
  });
});

describe("NonJudicialDecisionPanel", () => {
  it("shows a zero starting price as to be confirmed", () => {
    renderWithQuery(
      <NonJudicialDecisionPanel
        sale={{ ...sale, starting_price_eur: 0 } as AuctionSale}
        marketEstimate={null}
        marketLoading={false}
      />,
    );

    expect(screen.getByText("À confirmer")).toBeTruthy();
  });
});
