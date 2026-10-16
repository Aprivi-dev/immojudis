// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { SaleKeyFactsBand } from "./SaleKeyFactsBand";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return { ...EXAMPLE_SALE, ...overrides } as AuctionSale;
}

describe("SaleKeyFactsBand", () => {
  it("shows price, hearing date and time, court and next visit in one band", () => {
    render(<SaleKeyFactsBand sale={sale()} />);

    const band = screen.getByRole("region", { name: "Repères de la vente" });
    expect(screen.getAllByRole("region", { name: "Repères de la vente" })).toHaveLength(1);
    const text = band.textContent?.replace(/\s/g, " ") ?? "";
    expect(text).toContain("Mise à prix");
    expect(text).toContain("95 000 €");
    expect(text).toContain("Audience annoncée");
    expect(text).toMatch(/15 octobre 2026.*09:30/);
    expect(text).toContain("Tribunal");
    expect(text).toContain("Tribunal judiciaire de Bordeaux");
    expect(text).toContain("Prochaine visite");
    expect(text).toContain("2 octobre 2026");
  });

  it("defines « Mise à prix » with the accessible bubble", () => {
    render(<SaleKeyFactsBand sale={sale()} />);

    const band = screen.getByRole("region", { name: "Repères de la vente" });
    expect(within(band).getByRole("button", { name: "Définition : mise à prix" })).toBeTruthy();
  });

  it("leaves out the visit and the court when the file does not give them", () => {
    render(
      <SaleKeyFactsBand
        sale={sale({
          visit_dates: [],
          source_blocks: {},
          sale_procedure: null,
          tribunal: null,
          tribunal_name: null,
        } as Partial<AuctionSale>)}
      />,
    );

    expect(screen.queryByText("Prochaine visite")).toBeNull();
    expect(screen.queryByText("Tribunal")).toBeNull();
    expect(screen.getByText("Mise à prix")).toBeTruthy();
  });

  it("says « À confirmer » instead of inventing a price or a date", () => {
    render(<SaleKeyFactsBand sale={sale({ starting_price_eur: 0, sale_date: null })} />);

    expect(screen.getAllByText("À confirmer").length).toBeGreaterThan(0);
    expect(screen.getByText("Date à confirmer")).toBeTruthy();
  });

  it("shows the status of a postponed sale in place of the date, without a visit", () => {
    render(<SaleKeyFactsBand sale={sale({ status: "postponed" })} />);

    expect(screen.getByText("Vente reportée · nouvelle date à confirmer")).toBeTruthy();
    expect(screen.queryByText("Prochaine visite")).toBeNull();
  });

  it("has no structural accessibility violation", async () => {
    const { container } = render(<SaleKeyFactsBand sale={sale()} />);

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id }) => id)).toEqual([]);
  });
});
