import { describe, expect, it } from "vitest";
import {
  PLANNING_CALENDAR_MAX_SALES,
  buildPlanning,
  planningCalendarSaleIds,
  planningDaysLabel,
} from "@/lib/favorite-planning";
import type { FavoriteSale } from "@/lib/favorites";
import type { AuctionSale } from "@/lib/types";

// Mardi 20 octobre 2026, 10 h à Paris.
const NOW = new Date("2026-10-20T08:00:00Z");

function favorite(id: string, sale: Partial<AuctionSale>): FavoriteSale {
  return {
    id: `fav-${id}`,
    saleId: id,
    favoritedAt: "2026-10-01T10:00:00.000Z",
    sale: { id, status: "upcoming", sale_venue_type: "tribunal", ...sale } as AuctionSale,
    personalStatus: null,
    bidCeilingEur: null,
    bidCeilingSavedAt: null,
  };
}

describe("buildPlanning", () => {
  it("classe les audiences par date, avec les jours restants", () => {
    const { dated, undated } = buildPlanning({
      now: NOW,
      favorites: [
        favorite("loin", { sale_date: "2026-12-01T09:00:00Z" }),
        favorite("demain", { sale_date: "2026-10-21T13:00:00Z" }),
        favorite("aujourdhui", { sale_date: "2026-10-20T13:00:00Z" }),
      ],
    });
    expect(dated.map((entry) => [entry.favorite.saleId, entry.daysUntil])).toEqual([
      ["aujourdhui", 0],
      ["demain", 1],
      ["loin", 42],
    ]);
    expect(undated).toEqual([]);
  });

  it("compte le jour de Paris", () => {
    const { dated } = buildPlanning({
      now: NOW,
      // 23 h 30 UTC le 20 = 1 h 30 à Paris le 21.
      favorites: [favorite("nuit", { sale_date: "2026-10-20T23:30:00Z" })],
    });
    expect(dated[0]?.daysUntil).toBe(1);
    expect(dated[0]?.dayKey).toBe("2026-10-21");
  });

  it("met à part sans date : date absente, vente reportée, conflit de sources, date écartée", () => {
    const { dated, undated } = buildPlanning({
      now: NOW,
      favorites: [
        favorite("sans", { sale_date: null }),
        favorite("reportee", { sale_date: "2026-11-02T09:00:00Z", status: "postponed" }),
        favorite("conflit", {
          sale_date: "2026-11-03T09:00:00Z",
          sale_verification_status: "conflict",
        }),
        favorite("ecartee", { sale_date: "2026-11-04T09:00:00Z" }),
        favorite("ok", { sale_date: "2026-11-05T09:00:00Z" }),
      ],
      dateBlocked: (saleId) => saleId === "ecartee",
    });
    expect(dated.map((entry) => entry.favorite.saleId)).toEqual(["ok"]);
    expect(undated.map((item) => item.saleId)).toEqual(["sans", "reportee", "conflit", "ecartee"]);
  });

  it("ne reprend pas une audience passée (elle a sa section « Ventes passées »)", () => {
    const { dated, undated } = buildPlanning({
      now: NOW,
      favorites: [favorite("passee", { sale_date: "2026-10-10T09:00:00Z" })],
    });
    expect(dated).toEqual([]);
    expect(undated).toEqual([]);
  });

  it("donne l'heure seulement quand l'annonce la publie", () => {
    const { dated } = buildPlanning({
      now: NOW,
      favorites: [
        favorite("heure", { sale_date: "2026-10-22T12:00:00Z" }),
        favorite("jour", { sale_date: "2026-10-23T00:00:00Z" }),
      ],
    });
    expect(dated[0]?.time).toBe("14 h 00");
    expect(dated[1]?.time).toBeNull();
  });
});

describe("planningDaysLabel", () => {
  it("écrit « J-x » et « Aujourd’hui »", () => {
    expect(planningDaysLabel(0)).toBe("Aujourd’hui");
    expect(planningDaysLabel(1)).toBe("J-1");
    expect(planningDaysLabel(12)).toBe("J-12");
  });
});

describe("planningCalendarSaleIds", () => {
  it("ne garde que les ventes au tribunal, les plus proches, plafonnées", () => {
    const favorites = [
      favorite("notaire", { sale_date: "2026-10-21T09:00:00Z", sale_venue_type: "notary" }),
      ...Array.from({ length: PLANNING_CALENDAR_MAX_SALES + 3 }, (_, index) =>
        favorite(`t${String(index).padStart(3, "0")}`, {
          sale_date: new Date(Date.UTC(2026, 10, 1 + (index % 20), 9 + (index % 5))).toISOString(),
        }),
      ),
    ];
    const { dated } = buildPlanning({ now: NOW, favorites });
    const { saleIds, truncated } = planningCalendarSaleIds(dated);
    expect(saleIds).toHaveLength(PLANNING_CALENDAR_MAX_SALES);
    expect(saleIds).not.toContain("notaire");
    expect(truncated).toBe(true);
    expect(planningCalendarSaleIds(dated.slice(0, 3)).truncated).toBe(false);
  });
});
