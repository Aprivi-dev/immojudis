import { describe, expect, it } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { pointsToVerify, pointsToVerifyLabel } from "./points-to-verify";

const NOW = new Date("2026-10-19T10:00:00Z");
const FUTURE = "2026-12-10T09:00:00Z";

function card(overrides: Record<string, unknown> = {}): AuctionSale {
  return {
    id: "sale-1",
    property_type: "apartment",
    city: "Pau",
    sale_date: FUTURE,
    app_surface_m2: 50,
    app_surface_kind: "habitable",
    occupancy_status: "libre",
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    status: "upcoming",
    ...overrides,
  } as unknown as AuctionSale;
}

const keys = (sale: AuctionSale, occupancyVisible = true) =>
  pointsToVerify(sale, { occupancyVisible, now: NOW }).map((point) => point.key);

describe("pointsToVerify", () => {
  it("n'a aucun point pour une carte complète", () => {
    expect(keys(card())).toEqual([]);
  });

  it("compte une surface absente, qui est déjà « Surface n.c. » sur la carte", () => {
    expect(keys(card({ app_surface_m2: null }))).toEqual(["surface"]);
    expect(keys(card({ app_surface_m2: 0 }))).toEqual(["surface"]);
  });

  it("ne compte pas la surface d'un terrain dont la surface de terrain est connue", () => {
    expect(
      keys(card({ property_type: "land", app_surface_m2: null, land_surface_m2: 640 })),
    ).toEqual([]);
  });

  it("compte une occupation inconnue, quelle que soit la façon de la dire", () => {
    for (const status of [null, "", "unknown", "inconnu", " Unknown "]) {
      expect(keys(card({ occupancy_status: status }))).toEqual(["occupancy"]);
    }
    for (const status of ["libre", "occupé", "loué", "owner_occupied"]) {
      expect(keys(card({ occupancy_status: status }))).toEqual([]);
    }
  });

  it("ne compte pas l'occupation quand la carte ne la montre pas", () => {
    expect(keys(card({ occupancy_status: null }), false)).toEqual([]);
  });

  it("compte une date de vente absente ou illisible", () => {
    expect(keys(card({ sale_date: null }))).toEqual(["date"]);
    expect(keys(card({ sale_date: "pas une date" }))).toEqual(["date"]);
  });

  it("ne compte pas l'absence de date d'une cession de l'État : c'est son fonctionnement", () => {
    expect(keys(card({ sale_date: null, sale_venue_type: "state" }))).toEqual([]);
  });

  it("compte une procédure sur laquelle les sources ne s'accordent pas", () => {
    expect(keys(card({ sale_verification_status: "conflict" }))).toEqual(["procedure"]);
    for (const status of ["verified", "cross_checked", "pending", null]) {
      expect(keys(card({ sale_verification_status: status }))).toEqual([]);
    }
  });

  it("additionne les points, dans l'ordre de la carte", () => {
    const points = pointsToVerify(
      card({
        app_surface_m2: null,
        occupancy_status: "unknown",
        sale_date: null,
        sale_verification_status: "conflict",
      }),
      { occupancyVisible: true, now: NOW },
    );
    expect(points.map((point) => point.key)).toEqual(["surface", "occupancy", "date", "procedure"]);
    for (const point of points) expect(point.label).not.toMatch(/\d|risque|attention|danger/i);
  });

  describe("données peu fiables : pas de point", () => {
    it("ne compte jamais un champ absent de la ligne (colonne non lue)", () => {
      const preview = {
        id: "sale-1",
        city: "Pau",
        starting_price_eur: 59_000,
        sale_venue_type: "tribunal",
      } as unknown as AuctionSale;
      expect(keys(preview)).toEqual([]);
    });

    it("n'a rien à dire d'une vente passée, retirée ou annulée", () => {
      const blank = { app_surface_m2: null, occupancy_status: null, sale_date: null };
      for (const status of ["past", "adjudicated", "cancelled", "withdrawn", "quarantined"]) {
        expect(keys(card({ ...blank, status }))).toEqual([]);
      }
      expect(keys(card({ app_surface_m2: null, sale_date: "2026-10-01T09:00:00Z" }))).toEqual([]);
    });

    it("garde une vente reportée, dont la date est à reconfirmer", () => {
      expect(keys(card({ status: "postponed", sale_date: null }))).toEqual(["date"]);
    });

    it("ne se sert pas du palier de complétude, qui ne dit pas ce qui manque", () => {
      expect(keys(card({ completeness_tier: 0 }))).toEqual([]);
      expect(keys(card({ completeness_tier: 1, app_surface_m2: null }))).toEqual(["surface"]);
    });
  });
});

describe("pointsToVerifyLabel", () => {
  it("accorde le pluriel et reste neutre", () => {
    expect(pointsToVerifyLabel(1)).toBe("1 point à vérifier");
    expect(pointsToVerifyLabel(2)).toBe("2 points à vérifier");
    expect(pointsToVerifyLabel(3)).toBe("3 points à vérifier");
  });
});
