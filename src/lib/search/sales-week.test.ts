import { describe, expect, it } from "vitest";
import { parisToday, upcomingWeekScope } from "./sales-week";

describe("parisToday", () => {
  it("donne le jour de Paris, pas celui d'UTC", () => {
    // 23 h 30 UTC le 6 novembre = 0 h 30 à Paris le 7 novembre (heure d'hiver).
    expect(parisToday(new Date("2026-11-06T23:30:00Z"))).toBe("2026-11-07");
    expect(parisToday(new Date("2026-11-06T10:00:00Z"))).toBe("2026-11-06");
  });
});

describe("upcomingWeekScope", () => {
  it("borne la recherche aux sept prochains jours, aujourd'hui compris", () => {
    const scope = upcomingWeekScope({ city: "Pau", page: 3, sort: "price_asc" }, "2026-11-06");
    expect(scope).toEqual({
      kind: "count",
      search: {
        city: "Pau",
        minSaleDate: "2026-11-06",
        maxSaleDate: "2026-11-12",
        page: undefined,
        limit: undefined,
        sort: undefined,
        map: undefined,
      },
    });
  });

  it("passe la fin de mois et d'année", () => {
    const scope = upcomingWeekScope({}, "2026-12-28");
    expect(scope.kind === "count" && scope.search.maxSaleDate).toBe("2027-01-03");
  });

  it("croise les dates choisies avec la semaine", () => {
    const scope = upcomingWeekScope(
      { minSaleDate: "2026-11-08", maxSaleDate: "2026-12-31" },
      "2026-11-06",
    );
    expect(scope.kind === "count" && [scope.search.minSaleDate, scope.search.maxSaleDate]).toEqual([
      "2026-11-08",
      "2026-11-12",
    ]);
  });

  it("vaut zéro sans requête quand les dates choisies sont hors de la semaine", () => {
    expect(upcomingWeekScope({ minSaleDate: "2026-12-01" }, "2026-11-06")).toEqual({
      kind: "none",
    });
    expect(upcomingWeekScope({ maxSaleDate: "2026-11-05" }, "2026-11-06")).toEqual({
      kind: "none",
    });
  });

  it("ne compte pas une recherche à filtres lus sur les lignes (balayage complet)", () => {
    expect(upcomingWeekScope({ pepite: true }, "2026-11-06")).toEqual({ kind: "unavailable" });
    expect(upcomingWeekScope({ belowRange: true }, "2026-11-06")).toEqual({
      kind: "unavailable",
    });
  });
});
