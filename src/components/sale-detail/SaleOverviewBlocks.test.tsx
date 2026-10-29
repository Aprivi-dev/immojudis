// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import type { ValuePreview } from "@/lib/value-preview";
import { FirstAuctionGuide, useFirstAuctionGuide } from "./FirstAuctionGuide";
import { MarketReference, marketReferenceScale } from "./MarketReference";
import { PriceSummaryCard } from "./PriceSummaryCard";
import { SaleTimeline } from "./SaleTimeline";
import { knownTabForAnchor, tabForAnchor } from "./sale-detail-anchors";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const preview = (values: Partial<ValuePreview> = {}): ValuePreview => ({
  available: true,
  lowEur: 215_000,
  highEur: 247_000,
  discountPct: 59,
  discountNotSignificant: false,
  startingPricePerM2: null,
  reliability: "forte",
  gapWithheld: null,
  ...values,
});

describe("MarketReference", () => {
  it("places the starting price on a scale that starts at zero", () => {
    const scale = marketReferenceScale(95_000, 215_000, 247_000);
    expect(scale.start).toBeLessThan(scale.low);
    expect(scale.low).toBeLessThan(scale.high);
    expect(scale.high).toBeLessThan(100);
    // 95 000 sur une échelle de 0 à 247 000 × 1,08 : environ 36 %, pas tout à gauche.
    expect(scale.start).toBeCloseTo(35.6, 0);
  });

  it("draws the scale for a vacant property with a meaningful gap", () => {
    render(<MarketReference startingPrice={95_000} preview={preview()} />);

    expect(
      screen.getByRole("img", { name: /Mise à prix de 95.000\s€ ; valeur estimée du bien entre/ }),
    ).toBeTruthy();
    expect(screen.getByText(/La mise à prix n’est pas le prix d’achat probable/)).toBeTruthy();
  });

  it("never compares an occupied property with the sales of vacant ones", () => {
    render(
      <MarketReference
        startingPrice={95_000}
        preview={preview({ discountPct: null, gapWithheld: "occupied" })}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByText(/Bien occupé : l’écart avec la valeur estimée n’est pas indiqué/),
    ).toBeTruthy();
    expect(screen.getByText(/215.000\s€ – 247.000\s€/)).toBeTruthy();
  });

  it("drops the scale for an implausible gap", () => {
    render(
      <MarketReference
        startingPrice={20_000}
        preview={preview({ discountPct: null, discountNotSignificant: true })}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/Écart non significatif/)).toBeTruthy();
  });

  it("invites a visitor to create an account instead of showing the range", () => {
    render(
      <MarketReference startingPrice={95_000} preview={null} signupHref="/login?reason=fiche" />,
    );
    expect(
      screen
        .getByRole("link", { name: "Créez un compte gratuit pour la voir" })
        .getAttribute("href"),
    ).toBe("/login?reason=fiche");
    expect(screen.queryByText(/215/)).toBeNull();
  });

  it("shows nothing without an estimate", () => {
    const { container } = render(
      <MarketReference startingPrice={95_000} preview={preview({ available: false })} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("SaleTimeline", () => {
  const upcoming = (values: Partial<AuctionSale> = {}): AuctionSale => ({
    ...EXAMPLE_SALE,
    sale_date: "2099-11-19T09:30:00+01:00",
    ...values,
  });

  it("lists the lawyer, the hearing, the overbid window and the payment from the sale rules", () => {
    render(<SaleTimeline sale={upcoming()} />);

    const steps = screen.getAllByRole("listitem").map((step) => step.textContent ?? "");
    expect(
      steps.some((step) => /Mandater un avocat.*barreau de Bordeaux.*9.500\s€/.test(step)),
    ).toBe(true);
    expect(steps.some((step) => /19 nov\..*Audience d’adjudication.*09 h 30/.test(step))).toBe(
      true,
    );
    expect(steps.some((step) => /\+10 jours.*n’est définitive qu’après ce délai/.test(step))).toBe(
      true,
    );
    expect(steps.some((step) => /\+2 mois.*Paiement du prix et des frais/.test(step))).toBe(true);
    expect(screen.getByRole("button", { name: "Définition : surenchère" })).toBeTruthy();
  });

  it("leaves the guarantee amount out while the starting price is under review", () => {
    render(<SaleTimeline sale={upcoming()} priceBlocked />);
    const lawyer = screen.getByText("Mandater un avocat").closest("li")!;
    expect(lawyer.textContent).not.toMatch(/9.500/);
    expect(lawyer.textContent).not.toContain("garantie");
  });

  it("says nothing for a past hearing or a blocked date", () => {
    const past = render(
      <SaleTimeline sale={upcoming({ sale_date: "2020-01-15T09:30:00+01:00" })} />,
    );
    expect(past.container.textContent).toBe("");
    past.unmount();
    const blocked = render(<SaleTimeline sale={upcoming()} dateBlocked />);
    expect(blocked.container.textContent).toBe("");
  });

  it("is reserved to court sales", () => {
    const { container } = render(
      <SaleTimeline
        sale={upcoming({ sale_venue_type: "notary", sale_procedure: null, source_blocks: null })}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("FirstAuctionGuide", () => {
  it("stays hidden on this device once closed, and comes back on request", () => {
    const first = renderHook(() => useFirstAuctionGuide());
    expect(first.result.current.visible).toBe(true);
    act(() => first.result.current.hide());
    expect(first.result.current.visible).toBe(false);
    first.unmount();

    const again = renderHook(() => useFirstAuctionGuide());
    expect(again.result.current.hidden).toBe(true);
    act(() => again.result.current.show());
    expect(again.result.current.visible).toBe(true);
  });

  it("links each step to the part of the listing that helps", () => {
    let hidden = false;
    render(
      <FirstAuctionGuide
        ceilingHref="#calculation"
        eligibleBar="Barreau de Bordeaux"
        onHide={() => {
          hidden = true;
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "Fixer votre plafond" }).getAttribute("href")).toBe(
      "#calculation",
    );
    expect(screen.getByRole("link", { name: "Mandater un avocat" }).getAttribute("href")).toBe(
      "#lawyer",
    );
    expect(screen.getByText(/du barreau de Bordeaux/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Masquer le guide de première vente" }));
    expect(hidden).toBe(true);
  });
});

describe("PriceSummaryCard", () => {
  it("shows the three amounts and links to the calculation", () => {
    render(
      <PriceSummaryCard
        startLabel="Mise à prix"
        startingPrice={95_000}
        value={{ kind: "amount", amount: 230_000, note: "d’après 12 ventes comparables" }}
        ceilingLabel="Enchère plafond (simulation)"
        ceiling={{
          kind: "amount",
          amount: 135_000,
          note: "selon vos hypothèses",
          reliability: "à consolider",
        }}
        detailHref="#calculation"
      />,
    );

    const card = screen.getByRole("region", { name: "Le prix" });
    expect(card.textContent).toMatch(/95.000\s€.*230.000\s€.*135.000\s€/);
    expect(card.textContent).toContain("fiabilité : à consolider");
    expect(screen.getByRole("link", { name: "Voir le calcul" }).getAttribute("href")).toBe(
      "#calculation",
    );
  });

  it("keeps the locked ceiling and the visitor's value behind their offers", () => {
    render(
      <PriceSummaryCard
        startLabel="Mise à prix"
        startingPrice={95_000}
        value={{ kind: "signup", href: "/login?reason=fiche" }}
        ceilingLabel="Enchère plafond (simulation)"
        ceiling={{ kind: "locked", action: <span>Avec l’offre Analyse</span> }}
        detailHref="#summary"
      />,
    );

    expect(screen.getByRole("link", { name: "Créez un compte gratuit" })).toBeTruthy();
    expect(screen.getByText("Avec l’offre Analyse")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Voir le détail" }).getAttribute("href")).toBe(
      "#summary",
    );
  });
});

describe("Quartier tab anchors", () => {
  it("opens the Quartier tab for the urbanism anchor and its own name", () => {
    expect(tabForAnchor("urbanism")).toBe("quartier");
    expect(knownTabForAnchor("quartier")).toBe("quartier");
    // Les points à vérifier restent dans l'Aperçu.
    expect(tabForAnchor("risks")).toBe("apercu");
  });
});
