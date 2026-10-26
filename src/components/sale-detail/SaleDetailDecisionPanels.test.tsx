// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("states the gap in % when it is significant", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue({
      available: true,
      lowEur: 80_000,
      highEur: 100_000,
      discountPct: 40,
      discountNotSignificant: false,
      startingPricePerM2: null,
    });
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(
      await screen.findByText(/La mise à prix est environ 40 % sous la valeur estimée du bien\./),
    ).toBeTruthy();
  });

  it("never shows a percentage for an implausible gap of 85 %, only the price per m²", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue({
      available: true,
      lowEur: 270_000,
      highEur: 330_000,
      // The API sends no percentage for an implausible gap (see `buildValuePreview`).
      discountPct: null,
      discountNotSignificant: true,
      startingPricePerM2: 750,
    });
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    const status = await screen.findByRole("status");
    const text = (status.textContent ?? "").replace(/\s/g, " ");
    expect(text).toContain("Écart non significatif : mise à prix de");
    expect(text).toContain("750");
    expect(text).toContain("m²");
    expect(text).not.toMatch(/\d+ %/);
    expect(text).not.toContain("sous la valeur estimée");
    expect(text).toContain("c’est le calcul de l’enchère plafond");
  });

  it("offers the one-click feedback on the gap to a signed-in account, and only with a gap", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue({
      available: true,
      lowEur: 80_000,
      highEur: 100_000,
      discountPct: 40,
      discountNotSignificant: false,
      startingPricePerM2: null,
    });
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    await screen.findByText(/La mise à prix est environ 40 % sous la valeur estimée du bien\./);
    const feedback = screen.getByTestId("sale-signal-feedback");
    expect(feedback.getAttribute("data-signal")).toBe("market_gap_band");
    expect(screen.getByRole("button", { name: "Utile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pas pertinent" })).toBeTruthy();
  });

  it("keeps the range but says the gap is withheld for an occupied property or an unknown occupation", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue({
      available: true,
      lowEur: 80_000,
      highEur: 100_000,
      discountPct: null,
      discountNotSignificant: false,
      startingPricePerM2: null,
      gapWithheld: "occupancy_unknown",
    });
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Occupation du bien non précisée");
    expect(status.textContent).not.toMatch(/\d+ %|sous la valeur estimée/);
    expect(screen.getByText(/80\s000\s€\s–\s100\s000\s€/)).toBeTruthy();
    expect(screen.queryByTestId("sale-signal-feedback")).toBeNull();
  });

  it("offers no feedback to a visitor: no account, no anonymous measure", () => {
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    expect(screen.queryByTestId("sale-signal-feedback")).toBeNull();
  });

  it("shows no sentence when the preview carries no gap at all", async () => {
    mocks.auth = { user: { id: "user-1" }, loading: false };
    mocks.fetchValuePreview.mockResolvedValue({
      available: true,
      lowEur: 80_000,
      highEur: 100_000,
      discountPct: null,
      discountNotSignificant: false,
      startingPricePerM2: null,
    });
    renderWithQuery(<DiscoveryDecisionPanel sale={sale} />);

    await screen.findByText(/80\s000\s€\s–\s100\s000\s€/);
    expect(screen.queryByRole("status")).toBeNull();
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

    it("offers no unlock for a notary sale even when notarial regimes are listed as open", () => {
      mocks.auth = { user: { id: "user-1" }, loading: false };
      mocks.fetchValuePreview.mockResolvedValue({ available: false });
      const notary = { ...sale, sale_venue_type: "notary" } as unknown as AuctionSale;
      renderWithQuery(
        <SaleUnlockOfferProvider status={offer}>
          <DiscoveryDecisionPanel
            sale={notary}
            openFeeRegimes={["tribunal", "notary_auction", "notary_online"]}
          />
        </SaleUnlockOfferProvider>,
      );

      expect(screen.getAllByRole("link", { name: /Débloquer cette vente/ })).toHaveLength(1);
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

    expect(screen.getByText("Aucun prix ne tient")).toBeTruthy();
    expect(
      screen.getByText(
        "Les frais, les travaux et la libération dépassent déjà le budget que permettent la valeur du bien et vos objectifs.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("À compléter")).toBeNull();
  });

  it.each([
    [
      "above",
      90_000,
      45_000,
      /^Selon vos hypothèses, vous pouvez enchérir jusqu’à 90\s000\s€, soit 45\s000\s€ au-dessus de la mise à prix\.$/,
    ],
    [
      "narrow",
      46_000,
      1_000,
      /^Peu d’écart avec la mise à prix : selon vos hypothèses, vous pouvez enchérir jusqu’à 46\s000\s€, soit 1\s000\s€ au-dessus de la mise à prix\.$/,
    ],
    [
      "below",
      36_000,
      -9_000,
      /^Avec ces hypothèses, votre enchère plafond \(36\s000\s€\) est 9\s000\s€ \(20\s%\) sous la mise à prix : le bien ne tient pas à son prix de départ\.$/,
    ],
  ])(
    "says in words where the ceiling stands against the starting price (%s)",
    (kind, ceiling, gap, text) => {
      renderWithQuery(
        <AnalysisDecisionPanel
          {...base}
          recommendedCeiling={ceiling}
          ceilingAvailable
          startingPriceGap={gap}
        />,
      );

      const status = screen.getByRole("status");
      expect(status.textContent).toMatch(text);
      // Warning style only when the margin is thin or missing, not when the ceiling is comfortable.
      expect(/surfaceCaution/.test(status.className)).toBe(kind !== "above");
    },
  );

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

  it("says the ceiling is before works until a works budget is entered", () => {
    const { container } = renderWithQuery(<AnalysisDecisionPanel {...base} worksBudget={null} />);

    expect(
      screen.getByText("Plafond hors travaux : ajoutez votre budget travaux pour l’affiner"),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("Travaux inclus");
    expect(container.textContent).not.toContain("à chiffrer");
  });

  it("names the works budget the ceiling is computed after", () => {
    renderWithQuery(<AnalysisDecisionPanel {...base} worksBudget={34_080} />);

    expect(screen.getByText(/^Plafond après 34\s080\s€ de travaux$/)).toBeTruthy();
  });

  it("keeps « aucun (bien repris en l’état) » for a zero works budget", () => {
    renderWithQuery(<AnalysisDecisionPanel {...base} worksBudget={0} />);

    expect(screen.getByText("Travaux inclus : aucun (bien repris en l’état)")).toBeTruthy();
  });

  it("keeps « Chiffrer les travaux » as the action of the panel", () => {
    const onEditWorks = vi.fn();
    renderWithQuery(
      <AnalysisDecisionPanel {...base} worksBudget={null} onEditWorks={onEditWorks} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chiffrer les travaux" }));
    expect(onEditWorks).toHaveBeenCalledOnce();
  });

  it("explains « Mise à prix » and « Enchère plafond » with a definition bubble", () => {
    renderWithQuery(<AnalysisDecisionPanel {...base} />);

    fireEvent.click(screen.getByRole("button", { name: "Définition : mise à prix" }));
    expect(screen.getByRole("note").textContent).toContain("Prix de départ de la vente");
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#lexique-mise-a-prix",
    );
    const ceiling = screen.getByRole("button", { name: "Définition : enchère plafond" });
    fireEvent.pointerDown(ceiling); // a real press first closes the other bubble
    fireEvent.click(ceiling);
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#lexique-enchere-plafond",
    );
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
