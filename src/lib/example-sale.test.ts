import { describe, expect, it } from "vitest";
import {
  EXAMPLE_HEARING_LEAD_DAYS,
  EXAMPLE_SALE,
  EXAMPLE_SALE_KEYS,
  exampleHeadlineFigures,
  exampleSaleSchedule,
  getExampleSaleRecords,
} from "./example-sale";
import { getListingPublicInformation } from "./listing-public-information";
import { computeMarketCeiling, DEFAULTS, estimateWorksBudget } from "./profitability";

describe("example hearing date", () => {
  it("is always 21 days after the day the page is generated", () => {
    const now = new Date("2026-10-09T14:12:00+02:00");
    const { hearing, visits } = exampleSaleSchedule(now);
    expect(EXAMPLE_HEARING_LEAD_DAYS).toBe(21);
    expect(hearing).toBe("2026-10-30T08:30:00.000Z"); // 30 Oct 2026, 09:30 in Paris (UTC+1 after DST)
    expect(visits).toEqual(["2026-10-19 à 14:00", "2026-10-23 à 10:30"]);
  });

  it("keeps the 09:30 Paris hour across the daylight-saving change", () => {
    const summer = exampleSaleSchedule(new Date("2026-10-01T12:00:00+02:00")).hearing;
    const winter = exampleSaleSchedule(new Date("2026-11-01T12:00:00+01:00")).hearing;
    expect(summer).toBe("2026-10-22T07:30:00.000Z"); // UTC+2
    expect(winter).toBe("2026-11-22T08:30:00.000Z"); // UTC+1
  });

  it("moves with the date of generation, never frozen", () => {
    const first = getExampleSaleRecords(new Date("2026-10-09T10:00:00Z")).bordeaux.sale;
    const later = getExampleSaleRecords(new Date("2027-03-01T10:00:00Z")).bordeaux.sale;
    expect(new Date(first.sale_date!).getTime()).toBeGreaterThan(Date.parse("2026-10-09"));
    expect(new Date(later.sale_date!).getTime()).toBeGreaterThan(Date.parse("2027-03-01"));
    expect(first.sale_date).not.toBe(later.sale_date);
    for (const key of EXAMPLE_SALE_KEYS) {
      const sale = getExampleSaleRecords(new Date("2026-10-09T10:00:00Z"))[key].sale;
      expect(Date.parse(sale.sale_date!)).toBeGreaterThan(Date.parse("2026-10-09T10:00:00Z"));
      const visits = sale.visit_dates as string[];
      expect(visits.every((visit) => visit < sale.sale_date!.slice(0, 10))).toBe(true);
    }
  });
});

describe("example is fictitious and consistent", () => {
  it("never carries a real address", () => {
    for (const key of EXAMPLE_SALE_KEYS) {
      expect(getExampleSaleRecords()[key].sale.address).toBe("12 rue de l'Exemple");
    }
    expect(EXAMPLE_SALE.address).not.toMatch(/Martyrs|Résistance/);
  });

  it("uses a single surface for the sale and the market study", () => {
    const { sale, marketEstimate } = getExampleSaleRecords().bordeaux;
    expect(sale.app_surface_m2).toBe(68);
    expect(sale.habitable_surface_m2).toBe(68);
    expect(sale.carrez_surface_m2).toBe(68);
    expect(marketEstimate.subjectSurfaceM2).toBe(68);
    expect(sale.description).not.toMatch(/42[,.]6/);
    expect(sale.llm_display_description).toContain("68 m²");
    expect(sale.rooms_count).toBe(3);
  });

  it.each(EXAMPLE_SALE_KEYS)(
    "gives a source to every field the %s page shows, never 'Source à préciser'",
    (key) => {
      const { sale } = getExampleSaleRecords()[key];
      const facts = getListingPublicInformation(sale).items;
      const shown = facts.filter((fact) => fact.status !== "missing");
      expect(shown.length).toBeGreaterThanOrEqual(15);
      for (const fact of shown) {
        expect(fact.sources.length, `${fact.id} has no source`).toBeGreaterThan(0);
        expect(fact.status, fact.id).not.toBe("reported");
        for (const source of fact.sources) {
          expect(source.url).toMatch(/^https:\/\/immojudis\.com\//);
          expect(source.label).toMatch(/exemple fictif/);
        }
      }
    },
  );

  it("names the source of every key figure", () => {
    const { sale } = getExampleSaleRecords().bordeaux;
    const sources = (sale.source_blocks as { field_sources: Record<string, string> }).field_sources;
    for (const field of [
      "starting_price_eur",
      "sale_date",
      "visit_dates",
      "surface",
      "address",
      "tribunal",
      "market_value",
    ]) {
      expect(sources[field]).toBeTruthy();
    }
  });
});

describe("home page figures", () => {
  it("are the ones the example page computes", () => {
    const figures = exampleHeadlineFigures();
    const { sale, marketEstimate } = getExampleSaleRecords().bordeaux;
    expect(figures.surfaceM2).toBe(sale.app_surface_m2);
    expect(figures.startingPrice).toBe(sale.starting_price_eur);
    expect(figures.marketValue).toBe(marketEstimate.estimatedValueEur);

    // The example page opens with the default scenario: refresh works, standard fees.
    const ceiling = computeMarketCeiling({
      surface: sale.app_surface_m2,
      price: sale.starting_price_eur!,
      works: estimateWorksBudget(sale.app_surface_m2, "rafraichissement"),
      fpt: DEFAULTS.fpt,
      scenario: "prudent",
      medianPricePerM2: marketEstimate.medianPricePerM2,
    });
    expect(Math.abs(figures.ceiling - ceiling.maxBid)).toBeLessThanOrEqual(50);
  });

  it("add up: value - fees and works - margin = ceiling", () => {
    const { marketValue, feesAndWorks, safetyMargin, ceiling } = exampleHeadlineFigures();
    expect(marketValue - feesAndWorks - safetyMargin).toBe(ceiling);
    expect(ceiling).toBeGreaterThan(exampleHeadlineFigures().startingPrice);
    expect(ceiling).toBeLessThan(marketValue);
  });
});
