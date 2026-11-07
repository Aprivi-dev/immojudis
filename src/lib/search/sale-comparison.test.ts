import { describe, expect, it } from "vitest";
import {
  COMPARE_SALE_PARAM,
  buildSaleComparisonSnapshot,
  compareSaleIdFromParam,
  readSaleComparisonSnapshot,
  type ComparedSale,
} from "./sale-comparison";

const sale: ComparedSale = {
  id: "c2500000-0000-4000-8000-000000000001",
  city: " Bordeaux ",
  department: "33",
  propertyType: "apartment",
  venueType: "tribunal",
  saleDate: "2026-10-12T09:00:00.000Z",
  startingPriceEur: 50_000,
  surfaceM2: 42,
  surfaceKind: "habitable",
  occupancy: "libre",
  rooms: 2,
  bedrooms: 1,
  bathrooms: 1,
};

describe("« Comparer » d'une fiche : /sales?comparer=<id>", () => {
  it("porte le nom attendu par le lien de la fiche", () => {
    expect(COMPARE_SALE_PARAM).toBe("comparer");
  });

  it("ne retient qu'un identifiant de vente (UUID), en minuscules", () => {
    expect(compareSaleIdFromParam("52D72DE3-D795-492E-BE50-58EB72D2EB47")).toBe(
      "52d72de3-d795-492e-be50-58eb72d2eb47",
    );
    expect(compareSaleIdFromParam(" 52d72de3-d795-492e-be50-58eb72d2eb47 ")).toBe(
      "52d72de3-d795-492e-be50-58eb72d2eb47",
    );
    for (const value of [null, undefined, "", "abc", "52d72de3", "../admin", "1 OR 1=1"]) {
      expect(compareSaleIdFromParam(value)).toBeNull();
    }
  });
});

describe("saved sale comparison snapshot", () => {
  it("round-trips only the versioned public comparison fields", () => {
    const snapshot = buildSaleComparisonSnapshot([sale], "2026-09-07T08:00:00.000Z");
    expect(snapshot).toEqual({
      version: 1,
      capturedAt: "2026-09-07T08:00:00.000Z",
      items: [{ ...sale, city: "Bordeaux" }],
    });
    expect(readSaleComparisonSnapshot(snapshot)).toEqual(snapshot.items);
  });

  it("drops unknown fields, invalid identifiers, duplicates and unsafe values", () => {
    const parsed = readSaleComparisonSnapshot({
      version: 1,
      items: [
        { ...sale, title: "Adresse privée", investmentScore: 99, rooms: 1.5 },
        { ...sale, city: "duplicate" },
        { ...sale, id: "javascript:alert(1)" },
        { ...sale, id: "c2500000-0000-4000-8000-000000000002", startingPriceEur: Infinity },
      ],
    });

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).not.toHaveProperty("title");
    expect(parsed[0]).not.toHaveProperty("investmentScore");
    expect(parsed[0].rooms).toBeNull();
    expect(parsed[1].startingPriceEur).toBeNull();
  });

  it("rejects unversioned and oversized payload structures", () => {
    expect(readSaleComparisonSnapshot({ items: [sale] })).toEqual([]);
    expect(readSaleComparisonSnapshot({ version: 2, items: [sale] })).toEqual([]);
    expect(readSaleComparisonSnapshot(null)).toEqual([]);
  });
});
