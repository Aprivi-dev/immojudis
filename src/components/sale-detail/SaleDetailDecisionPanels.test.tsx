// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { SaleUnlockOfferProvider } from "./UnlockCallToAction";
import { DiscoveryDecisionPanel, NonJudicialDecisionPanel } from "./SaleDetailDecisionPanels";

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

/** What the value route answers a free account on a sale it has not unlocked. */
function teaser(
  band: string | null,
  comparables: { count: number; radiusM: number } | null = null,
) {
  return { access: "teaser", band, comparables };
}

describe("DiscoveryDecisionPanel", () => {
  it("does not call the value route for a visitor and invites them to create a free account", () => {
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(mocks.fetchValuePreview).not.toHaveBeenCalled();
    expect(screen.queryByText("Pas encore d’estimation")).toBeNull();
    const link = screen.getByRole("link", {
      name: "Créez un compte gratuit pour voir le repère marché",
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

  it("shows a free account the level of the gap only: no range, no amount, no percentage", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue(teaser("under", { count: 14, radiusM: 500 }));
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(
      await screen.findByText("Mise à prix inférieure à la fourchette des ventes comparables"),
    ).toBeTruthy();
    expect(mocks.fetchValuePreview).toHaveBeenCalledWith(sale.id);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\d+ %/);
    expect(text).not.toMatch(/€\s*–/);
    expect(text).not.toContain("Valeur estimée");
    expect(screen.queryByRole("link", { name: /Créez un compte gratuit/ })).toBeNull();
  });

  it("offers the one-click feedback on a real level of gap, with the ceiling still to compute", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue(teaser("near"));
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("c’est le calcul de l’enchère plafond");
    const feedback = screen.getByTestId("sale-signal-feedback");
    expect(feedback.getAttribute("data-signal")).toBe("market_gap_band");
  });

  it("says why the gap is not situated for an occupied property, without feedback", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue(teaser("occupied"));
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(await screen.findByText(/^Bien occupé : la comparaison/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("sale-signal-feedback")).toBeNull();
  });

  it("offers no feedback to a visitor: no account, no anonymous measure", () => {
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(screen.queryByTestId("sale-signal-feedback")).toBeNull();
  });

  it("keeps « Pas encore d’estimation » for an account without estimate", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue(teaser(null));
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(await screen.findByText("Pas encore d’estimation")).toBeTruthy();
  });

  describe("comparables found", () => {
    it("counts them in the plural, with the search radius", async () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser("under", { count: 14, radiusM: 1_500 }));
      renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

      const line = await screen.findByTestId("comparables-teaser");
      expect(line.textContent?.replace(/\s/g, " ")).toContain(
        "14 ventes comparables trouvées dans un rayon de 1 500 m",
      );
    });

    it("says it in the singular for one sale", async () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser("near", { count: 1, radiusM: 300 }));
      renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

      expect((await screen.findByTestId("comparables-teaser")).textContent).toContain(
        "1 vente comparable trouvée dans un rayon de 300 m",
      );
    });

    it("shows no line when the count is unknown or zero", async () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser("near", null));
      const { unmount } = renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);
      await screen.findByText("Mise à prix dans la fourchette des ventes comparables");
      expect(screen.queryByTestId("comparables-teaser")).toBeNull();
      unmount();

      mocks.fetchValuePreview.mockResolvedValue(teaser("near", { count: 0, radiusM: 500 }));
      renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);
      await screen.findByText("Mise à prix dans la fourchette des ventes comparables");
      expect(screen.queryByTestId("comparables-teaser")).toBeNull();
      expect(document.body.textContent).not.toContain("0 vente");
    });
  });

  describe("unlock link", () => {
    const tribunalSale = { ...sale, sale_venue_type: "tribunal" } as unknown as AuctionSale;
    const offer = {
      saleId: sale.id,
      unlocked: false,
      unlockable: true,
      analysisAccess: false,
      limit: 1,
      used: 0,
      remaining: 1,
    };

    it("links the ceiling row and the comparables found on a tribunal sale to the unlock card", async () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser("under", { count: 8, radiusM: 500 }));
      renderWithQuery(
        <SaleUnlockOfferProvider status={offer}>
          <DiscoveryDecisionPanel sale={tribunalSale} />
        </SaleUnlockOfferProvider>,
      );

      await screen.findByTestId("comparables-teaser");
      const links = screen.getAllByRole("link", {
        name: "Débloquer cette vente avec mon compte gratuit",
      });
      // The row of the ceiling, and the line of the comparables found.
      expect(links).toHaveLength(2);
      for (const link of links) expect(link.getAttribute("href")).toBe("#debloquer");
    });

    it("names both terms of the ceiling of a notarial sale", () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser(null));
      const notary = { ...sale, sale_venue_type: "notary" } as unknown as AuctionSale;
      renderWithQuery(
        <SaleUnlockOfferProvider status={offer}>
          <DiscoveryDecisionPanel sale={notary} />
        </SaleUnlockOfferProvider>,
      );

      expect(screen.getAllByRole("link", { name: /Débloquer cette vente/ })).toHaveLength(1);
      // The mode of the sale (candle or interactive) is not readable before the unlock.
      expect(document.body.textContent).toContain("Enchère plafond ou offre plafond (simulation)");
    });

    it("offers no unlock for a notarial sale when the server lists the tribunal only", () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser(null));
      const notary = { ...sale, sale_venue_type: "notary" } as unknown as AuctionSale;
      renderWithQuery(
        <SaleUnlockOfferProvider status={offer}>
          <DiscoveryDecisionPanel sale={notary} openFeeRegimes={["tribunal"]} />
        </SaleUnlockOfferProvider>,
      );

      expect(screen.getAllByRole("link", { name: /Débloquer cette vente/ })).toHaveLength(1);
    });

    it("keeps the single hint of the ceiling row on a sale without ceiling (domanial)", () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser(null));
      const state = { ...sale, sale_venue_type: "state" } as unknown as AuctionSale;
      renderWithQuery(
        <SaleUnlockOfferProvider status={offer}>
          <DiscoveryDecisionPanel
            sale={state}
            openFeeRegimes={["tribunal", "notary_auction", "notary_online", "state_auction"]}
          />
        </SaleUnlockOfferProvider>,
      );

      expect(screen.getAllByRole("link", { name: /Débloquer cette vente/ })).toHaveLength(1);
    });

    it("keeps only the offer next to the comparables when the page has no unlock card", async () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue(teaser("under", { count: 8, radiusM: 500 }));
      renderWithQuery(<DiscoveryDecisionPanel sale={tribunalSale} />);

      await screen.findByTestId("comparables-teaser");
      expect(screen.queryByRole("link", { name: /Débloquer cette vente/ })).toBeNull();
      expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
    });
  });

  it("shows a zero starting price as to be confirmed", () => {
    renderWithQuery(<DiscoveryDecisionPanel sale={{ ...sale, starting_price_eur: 0 }} />);

    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(screen.queryByText(/0\s€/)).toBeNull();
  });
});

describe("NonJudicialDecisionPanel", () => {
  it("says « Prix non publié » for a domanial sale without price, and keeps « À confirmer » elsewhere", () => {
    const render = (fields: Record<string, unknown>) =>
      renderWithQuery(
        <NonJudicialDecisionPanel
          sale={{ ...sale, ...fields } as AuctionSale}
          marketEstimate={null}
          marketLoading={false}
        />,
      );
    const state = render({ sale_venue_type: "state", starting_price_eur: null });
    expect(screen.getByText("Prix publié")).toBeTruthy();
    expect(screen.getByText("Prix non publié")).toBeTruthy();
    expect(screen.queryByText("À confirmer")).toBeNull();
    state.unmount();

    const notary = render({ sale_venue_type: "notary", starting_price_eur: null });
    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(screen.queryByText("Prix non publié")).toBeNull();
    notary.unmount();

    render({ sale_venue_type: "state", starting_price_eur: 90_000 });
    expect(screen.queryByText("Prix non publié")).toBeNull();
  });

  it("keeps « À confirmer » for a domanial sale whose price the AI review blocks", () => {
    renderWithQuery(
      <NonJudicialDecisionPanel
        sale={{ ...sale, sale_venue_type: "state", starting_price_eur: null } as AuctionSale}
        marketEstimate={null}
        marketLoading={false}
        priceBlocked
      />,
    );
    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(screen.queryByText("Prix non publié")).toBeNull();
  });

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
