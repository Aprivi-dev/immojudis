// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SaleHearingNav } from "@/components/sale-detail/SaleHearingNav";
import { SaleHearingSlot, SaleHearingSlotProvider } from "@/components/sale-detail/SaleHearingSlot";
import type { SaleHearing } from "@/lib/sale-hearing";

const hearing: SaleHearing = {
  dayKey: "2026-11-27",
  tribunalLabel: "tribunal judiciaire de Saint-Gaudens",
  tribunalCode: null,
  sales: [
    { id: "a", propertyType: "house", city: "Clarac", time: "9 h 00", startingPriceEur: 50_000 },
    { id: "b", propertyType: "house", city: "Eoux", time: "9 h 00", startingPriceEur: 57_000 },
    { id: "c", propertyType: "house", city: "Montmaurin", time: null, startingPriceEur: 50_000 },
  ],
  index: 1,
};

afterEach(cleanup);

describe("SaleHearingNav", () => {
  it("shows the position of the sale in its hearing and links to the other sales", () => {
    render(
      <SaleHearingSlotProvider nav={<SaleHearingNav hearing={hearing} />}>
        <SaleHearingSlot />
      </SaleHearingSlotProvider>,
    );

    const nav = within(screen.getByRole("navigation", { name: "Ventes de la même audience" }));
    expect(nav.getByText("Audience du vendredi 27 novembre 2026")).toBeTruthy();
    expect(nav.getByText("2 / 3")).toBeTruthy();
    expect(
      nav.getByRole("link", { name: /^Vente précédente de l’audience/ }).getAttribute("href"),
    ).toBe("/sales/a");
    expect(
      nav.getByRole("link", { name: /^Vente suivante de l’audience/ }).getAttribute("href"),
    ).toBe("/sales/c");
    expect(nav.getByText("Vous êtes ici").closest("[aria-current='page']")).toBeTruthy();
    expect(nav.getByText("heure à confirmer")).toBeTruthy();
  });

  it("offers no previous sale on the first one", () => {
    render(<SaleHearingNav hearing={{ ...hearing, index: 0 }} />);

    expect(screen.queryByRole("link", { name: /^Vente précédente/ })).toBeNull();
    expect(screen.getByRole("link", { name: /^Vente suivante/ })).toBeTruthy();
  });

  it("shows nothing without a shared hearing", () => {
    const { container } = render(
      <SaleHearingSlotProvider nav={null}>
        <SaleHearingSlot />
      </SaleHearingSlotProvider>,
    );

    expect(container.innerHTML).toBe("");
  });
});
