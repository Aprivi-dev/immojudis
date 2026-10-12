import { describe, expect, it } from "vitest";
import {
  courtShortName,
  mapPublicTribunalActivity,
  publicTribunalTotals,
} from "./public-tribunal-activity";

describe("public tribunal activity", () => {
  it("names a court by its city, without repeating « tribunal judiciaire »", () => {
    expect(courtShortName("TJ Bobigny")).toBe("Bobigny");
    expect(courtShortName("TJ Tribunal judiciaire du Mans")).toBe("Le Mans");
    expect(courtShortName("TJ Tribunal judiciaire des Sables-d'Olonne")).toBe(
      "Les Sables-d'Olonne",
    );
    expect(courtShortName("Tribunal judiciaire d’Évry")).toBe("Évry");
  });

  it("keeps courts with upcoming sales, busiest first, and totals them", () => {
    const items = mapPublicTribunalActivity([
      {
        tribunal_code: "pau",
        tribunal_name: "TJ Pau",
        tribunal_city: "Pau",
        department: "64",
        upcoming_count: 7,
        next_sale_date: "2026-10-16T00:00:00Z",
        median_starting_price_eur: "59000",
        house_count: 4,
        apartment_count: 3,
        other_count: 0,
      },
      {
        tribunal_code: "bobigny",
        tribunal_name: "TJ Bobigny",
        tribunal_city: "Bobigny",
        department: "93",
        upcoming_count: 107,
        next_sale_date: null,
        median_starting_price_eur: null,
        house_count: 17,
        apartment_count: 67,
        other_count: 23,
      },
      {
        tribunal_code: "empty",
        tribunal_name: "TJ Vide",
        tribunal_city: null,
        department: null,
        upcoming_count: 0,
        next_sale_date: null,
        median_starting_price_eur: null,
        house_count: 0,
        apartment_count: 0,
        other_count: 0,
      },
    ]);
    expect(items.map((item) => item.name)).toEqual(["Bobigny", "Pau"]);
    expect(items[1].medianStartingPriceEur).toBe(59_000);
    expect(publicTribunalTotals(items)).toEqual({ tribunals: 2, upcoming: 114 });
  });
});
