// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import type { SaleUnlockStatus } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => ({
  checkoutOpen: vi.fn(),
  purchase: null as { label: string; amountCents: number } | null,
}));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.checkoutOpen(),
}));
// The spent-unlock links read the subscription and the purchase of a single sale in one go.
vi.mock("@/hooks/use-sale-unlock-purchase-offer", () => ({
  useSaleUnlockPurchaseOffer: () => {
    const open = mocks.checkoutOpen();
    return open === null
      ? { status: "loading" }
      : {
          status: "ready",
          analysisOpen: open,
          analysisLabel: "59 € TTC / mois",
          analysisCents: 5900,
          purchase: mocks.purchase,
          firstMonthDeductionCents: 0,
        };
  },
}));
vi.mock("@/components/OfferOpeningRequest", () => ({
  OfferOpeningRequest: () => <button type="button">Me prévenir de l’ouverture</button>,
}));

import { SaleUnlockOfferProvider, UNLOCK_PANEL_ID, UnlockCallToAction } from "./UnlockCallToAction";

const status = (overrides: Partial<SaleUnlockStatus> = {}): SaleUnlockStatus => ({
  saleId: "11111111-1111-4111-8111-111111111111",
  unlocked: false,
  unlockable: true,
  analysisAccess: false,
  limit: 1,
  used: 0,
  remaining: 1,
  ...overrides,
});

beforeEach(() => {
  mocks.purchase = null;
  mocks.checkoutOpen.mockReset();
  mocks.checkoutOpen.mockReturnValue(true);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function renderPreview(offer: SaleUnlockStatus | null) {
  return render(
    <SaleUnlockOfferProvider status={offer}>
      <PremiumFeaturePreview
        title="Titre"
        description="Description"
        labels={["A", "B"]}
        unlockOffer
      />
    </SaleUnlockOfferProvider>,
  );
}

describe("UnlockCallToAction in a paid preview", () => {
  it("makes « Débloquer cette vente » the main link while the unlock is left, the offer comes second", () => {
    renderPreview(status());

    const unlock = screen.getByRole("link", {
      name: "Débloquer cette vente avec mon compte gratuit",
    });
    expect(unlock.getAttribute("href")).toBe(`#${UNLOCK_PANEL_ID}`);
    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.indexOf("Débloquer cette vente avec mon compte gratuit")).toBeLessThan(
      links.indexOf("Découvrir l’offre Analyse"),
    );
  });

  it("scrolls to the unlock card and puts the focus on its button, wherever the page was", () => {
    renderPreview(status());
    const card = document.createElement("section");
    card.id = UNLOCK_PANEL_ID;
    const button = document.createElement("button");
    card.append(button);
    document.body.append(card);
    const scroll = vi.fn();
    card.scrollIntoView = scroll;

    const click = fireEvent.click(
      screen.getByRole("link", { name: "Débloquer cette vente avec mon compte gratuit" }),
    );

    // The default (a hash change) is cancelled: the page would fall back to the first tab.
    expect(click).toBe(false);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(button);
    card.remove();
  });

  it("says the unlock is spent on another sale, without a return date, then points to the offer", () => {
    renderPreview(status({ used: 1, remaining: 0 }));

    expect(screen.getByText("Votre compte gratuit a déjà débloqué une vente.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/reviennent|1er|ce mois/);
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" }).getAttribute("href")).toBe(
      "/offres",
    );
    expect(screen.queryByRole("link", { name: /Débloquer cette vente/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Me prévenir de l’ouverture" })).toBeNull();
  });

  it("offers the opening request instead of a dead end when the offer is closed", async () => {
    mocks.checkoutOpen.mockReturnValue(false);
    renderPreview(status({ used: 1, remaining: 0 }));

    // The request is loaded on demand.
    expect(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Voir l’offre Analyse" })).toBeNull();
  });

  it("with a credit left, makes « Débloquer cette vente avec mon crédit » the main link", () => {
    renderPreview(status({ used: 1, remaining: 0, credits: 1 }));

    const credit = screen.getByRole("link", { name: "Débloquer cette vente avec mon crédit" });
    expect(credit.getAttribute("href")).toBe(`#${UNLOCK_PANEL_ID}`);
    expect(screen.queryByText("Votre compte gratuit a déjà débloqué une vente.")).toBeNull();
    expect(screen.queryByRole("link", { name: /Acheter/ })).toBeNull();
  });

  it("once the purchase is open, adds « Acheter cette vente » to the card before the offer", () => {
    mocks.purchase = { label: "19 €", amountCents: 1900 };
    renderPreview(status({ used: 1, remaining: 0 }));

    const links = screen.getAllByRole("link").map((link) => link.textContent);
    const buy = screen.getByRole("link", { name: "Acheter cette vente : 19 €" });
    expect(buy.getAttribute("href")).toBe(`#${UNLOCK_PANEL_ID}`);
    expect(links.indexOf("Acheter cette vente : 19 €")).toBeLessThan(
      links.indexOf("Voir l’offre Analyse"),
    );
  });

  it("never mentions a purchase while it is closed", () => {
    renderPreview(status({ used: 1, remaining: 0 }));
    expect(screen.queryByRole("link", { name: /Acheter/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/à l’unité|19/);
  });

  it("keeps the single link to the offer when the page has no unlock card", () => {
    renderPreview(null);

    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
    expect(screen.queryByRole("link", { name: /Débloquer/ })).toBeNull();
  });

  it("never offers an unlock for a preview of what an unlock does not open", () => {
    render(
      <SaleUnlockOfferProvider status={status()}>
        <PremiumFeaturePreview title="Travaux" description="Description" labels={["A"]} />
      </SaleUnlockOfferProvider>,
    );
    expect(screen.queryByRole("link", { name: /Débloquer/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Découvrir l’offre Analyse" })).toBeTruthy();
  });
});

describe("UnlockCallToAction on its own", () => {
  it("renders nothing without an unlock card when it is only a hint", () => {
    const { container } = render(<UnlockCallToAction onlyWithUnlockCard />);
    expect(container.textContent).toBe("");
  });

  it("uses the label of the host for the single link to the offer", () => {
    render(<UnlockCallToAction offerLabel="Découvrir l’analyse" />);
    expect(screen.getByRole("link", { name: "Découvrir l’analyse" }).getAttribute("href")).toBe(
      "/offres",
    );
  });

  it("follows the hash when the card is not on the page", () => {
    render(
      <SaleUnlockOfferProvider status={status()}>
        <UnlockCallToAction />
      </SaleUnlockOfferProvider>,
    );
    const link = screen.getByRole("link", { name: /Débloquer cette vente/ });
    expect(fireEvent.click(link)).toBe(true);
  });
});
