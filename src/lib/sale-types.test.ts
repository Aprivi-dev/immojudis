import { describe, expect, it } from "vitest";
import { parseSaleType, saleVenueMatchesType, SALE_FAMILIES } from "./sale-types";
import { getSaleProcedure, saleEventLabel, saleVenueLabel } from "./sale-procedure";
import type { AuctionSale } from "./types";

describe("sale family vocabulary", () => {
  it.each(["tribunal", "notary", "state", "unknown"])("accepts %s as a filter", (value) => {
    expect(parseSaleType(value)).toBe(value);
  });
  it("keeps participation separate from the organizer", () => {
    expect(parseSaleType("online")).toBeUndefined();
    expect(saleVenueMatchesType("online", "unknown")).toBe(true);
    expect(saleVenueMatchesType("notary", "tribunal")).toBe(false);
    expect(saleVenueLabel("online")).toBe("Organisateur à confirmer");
    expect(getSaleProcedure({ sale_venue_type: "online" } as AuctionSale).participationMode).toBe(
      "online",
    );
    expect(SALE_FAMILIES.map((family) => family.type)).toEqual(["tribunal", "notary", "state"]);
  });
  it("reserves audience vocabulary for the tribunal", () => {
    expect(saleEventLabel("tribunal")).toBe("Audience");
    expect(saleEventLabel("notary")).toBe("Vente");
    expect(saleEventLabel("state")).toBe("Vente");
  });
});

describe("pilot sale types", () => {
  it("masque le notarial et le domanial tant que le drapeau est fermé", async () => {
    const { visibleSaleTypeOptions, visibleSaleFamilies } = await import("./sale-types");
    expect(visibleSaleTypeOptions({}).map((option) => option.value)).toEqual([
      "tribunal",
      "unknown",
    ]);
    expect(visibleSaleFamilies({}).map((family) => family.type)).toEqual(["tribunal"]);
    const open = { NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED: "true" };
    expect(visibleSaleTypeOptions(open).map((option) => option.value)).toEqual([
      "tribunal",
      "notary",
      "state",
      "unknown",
    ]);
    expect(visibleSaleFamilies(open)).toHaveLength(3);
  });
});
