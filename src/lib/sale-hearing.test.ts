import { describe, expect, it } from "vitest";
import { saleHearing } from "@/lib/sale-hearing";
import type { PublicHearing } from "@/lib/upcoming-hearings";

function hearing(overrides: Partial<PublicHearing> & { id: string }): PublicHearing {
  return {
    saleDate: "2026-11-27T08:00:00.000Z",
    dayKey: "2026-11-27",
    time: "9 h 00",
    propertyType: "house",
    city: "Clarac",
    department: "31",
    tribunalCode: "TJ31483",
    tribunalKey: "TJ31483",
    tribunalLabel: "tribunal judiciaire de Saint-Gaudens",
    startingPriceEur: 50_000,
    sourceGroup: null,
    ...overrides,
  };
}

describe("saleHearing", () => {
  const hearings = [
    hearing({ id: "b", city: "Eoux", startingPriceEur: 57_000 }),
    hearing({ id: "a" }),
    hearing({ id: "c", city: "Montmaurin", saleDate: "2026-11-27T09:30:00.000Z" }),
    hearing({ id: "other-day", dayKey: "2026-12-04", saleDate: "2026-12-04T08:00:00.000Z" }),
    hearing({ id: "other-court", tribunalKey: "TJ31555", tribunalCode: "TJ31555" }),
  ];

  it("lists the sales of the same court on the same day, with the position of the sale", () => {
    const result = saleHearing(hearings, "B");

    expect(result?.sales.map((sale) => sale.id)).toEqual(["a", "b", "c"]);
    expect(result?.index).toBe(1);
    expect(result?.tribunalLabel).toBe("tribunal judiciaire de Saint-Gaudens");
    expect(result?.sales[1]).toEqual({
      id: "b",
      propertyType: "house",
      city: "Eoux",
      time: "9 h 00",
      startingPriceEur: 57_000,
    });
  });

  it("shows nothing for a sale alone at its hearing or absent from the list", () => {
    expect(saleHearing(hearings, "other-day")).toBeNull();
    expect(saleHearing(hearings, "unknown")).toBeNull();
  });

  it("counts a sale published twice once, and keeps the sale being read", () => {
    const twice = [
      hearing({ id: "a", sourceGroup: "a" }),
      hearing({ id: "z", sourceGroup: "a" }),
      hearing({ id: "c", city: "Montmaurin" }),
    ];

    expect(saleHearing(twice, "z")?.sales.map((sale) => sale.id)).toEqual(["z", "c"]);
    expect(saleHearing(twice, "c")?.sales.map((sale) => sale.id)).toEqual(["a", "c"]);
  });
});
