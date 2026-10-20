// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import type { SaleUnlockStatus } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => ({ checkoutOpen: vi.fn() }));
vi.mock("@/hooks/use-analysis-checkout-open", () => ({
  useAnalysisCheckoutOpen: () => mocks.checkoutOpen(),
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
  limit: 3,
  used: 1,
  remaining: 2,
  periodStart: "2026-09-30T22:00:00.000Z",
  resetsAt: "2026-10-31T23:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
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
  it("makes « Débloquer cette vente » the main link while unlocks are left, the offer comes second", () => {
    renderPreview(status());

    const unlock = screen.getByRole("link", {
      name: "Débloquer cette vente (il vous reste 2 sur 3)",
    });
    expect(unlock.getAttribute("href")).toBe(`#${UNLOCK_PANEL_ID}`);
    expect(
      screen.getByRole("link", { name: "Découvrir l’offre Analyse" }).getAttribute("href"),
    ).toBe("/offres");
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.indexOf("Débloquer cette vente (il vous reste 2 sur 3)")).toBeLessThan(
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
      screen.getByRole("link", { name: /Débloquer cette vente \(il vous reste 2 sur 3\)/ }),
    );

    // The default (a hash change) is cancelled: the page would fall back to the first tab.
    expect(click).toBe(false);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(button);
    card.remove();
  });

  it("tells when the unlocks come back once they are spent, then points to the offer", () => {
    renderPreview(status({ used: 3, remaining: 0 }));

    expect(screen.getByText("Vos 3 déblocages d’octobre reviennent le 1er novembre.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Voir l’offre Analyse" }).getAttribute("href")).toBe(
      "/offres",
    );
    expect(screen.queryByRole("link", { name: /Débloquer cette vente/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Me prévenir de l’ouverture" })).toBeNull();
  });

  it("offers the opening request instead of a dead end when the offer is closed", async () => {
    mocks.checkoutOpen.mockReturnValue(false);
    renderPreview(status({ used: 3, remaining: 0 }));

    // The request is loaded on demand.
    expect(await screen.findByRole("button", { name: "Me prévenir de l’ouverture" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Voir l’offre Analyse" })).toBeNull();
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
