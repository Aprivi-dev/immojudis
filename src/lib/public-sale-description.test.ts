import { describe, expect, it } from "vitest";
import { publicDossierContents, publicSaleDescription } from "./public-sale-description";
import type { AuctionSale } from "./types";

const sale = (fields: Partial<AuctionSale>) => fields as AuctionSale;

describe("public sale description", () => {
  it("describes a house from its structured facts", () => {
    const result = publicSaleDescription(
      sale({
        property_type: "house",
        app_surface_m2: 112,
        rooms_count: 5,
        bedrooms_count: 3,
        land_surface_m2: 781,
        city: "Tancarville",
        department: "76",
        has_garden: true,
        has_pool: false,
        has_double_glazing: true,
        parking_count: 2,
      }),
    );
    expect(result.sentence).toBe(
      "Maison de 112 m², 5 pièces dont 3 chambres, sur un terrain de 781 m², à Tancarville (76).",
    );
    expect(result.amenities).toEqual(["Jardin", "Double vitrage", "2 places de stationnement"]);
  });

  it("ignores the co-ownership parcel of an apartment and unknown amenities", () => {
    const result = publicSaleDescription(
      sale({
        property_type: "apartment",
        app_surface_m2: 48,
        land_surface_m2: 1200,
        city: "Lyon",
        has_garden: null,
      }),
    );
    expect(result.sentence).toBe("Appartement de 48 m², à Lyon.");
    expect(result.amenities).toEqual([]);
  });

  it("lists what the free account reveals without exposing it", () => {
    const items = publicDossierContents(
      sale({ photo_count: 6, has_visit_dates: true, document_count: 1 }),
    );
    expect(items[0]).toBe("6 photos du bien");
    expect(items).toContain("Les dates et le lieu des visites");
    expect(items.at(-1)).toMatch(/^1 pièce au dossier/);
    expect(publicDossierContents(sale({ photo_count: 1 }))).not.toContain(
      "Les dates et le lieu des visites",
    );
  });
});
