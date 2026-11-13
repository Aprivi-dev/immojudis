import { describe, expect, it } from "vitest";
import { occupationCaseForStatus } from "@/lib/bid-ceiling-defaults";
import { occupancyLabel } from "@/lib/format/property-labels";
import { marketGapWithheldReason } from "@/lib/market-gap-band";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { matchesOccupancyFilter, occupancyClassCodes } from "@/lib/occupancy-filter";
import {
  isOccupiedOccupancyStatus,
  isVacantOccupancyStatus,
  occupancyClass,
  occupancyDetail,
} from "@/lib/occupancy-status";
import type { AuctionSale } from "@/lib/types";

/**
 * Test de caractérisation (lot 9 A) : l'occupation était classée par quatre copies (statistiques
 * d'annonces, activité judiciaire, libellés, écart au marché). Colonnes : valeur, classe, libellé.
 */
const KNOWN_VALUES: ReadonlyArray<
  readonly [string | null, "vacant" | "occupied" | "rented" | null, string]
> = [
  [null, null, "Non renseigné"],
  ["", null, "Non renseigné"],
  ["unknown", null, "À confirmer"],
  ["vacant", "vacant", "Libre"],
  ["occupied", "occupied", "Occupé"],
  ["rented", "rented", "Loué"],
  ["owner_occupied", "occupied", "Occupé par le propriétaire"],
  ["tenant_occupied", "rented", "Loué"],
  ["occupied_other", "occupied", "Occupé"],
  ["squatted", "occupied", "Occupé sans droit ni titre"],
  // Ancienne valeur du filtre « Libre », pas un statut : lue à l'entrée par `currentFilterValue`.
  ["free", null, "free"],
  ["inconnu", null, "À confirmer"],
  ["Libre", "vacant", "Libre"],
  ["Inoccupé", "vacant", "Libre"],
  ["Loué", "rented", "Loué"],
  ["Occupé", "occupied", "Occupé"],
  ["Occupé par le propriétaire", "occupied", "Occupé par le propriétaire"],
  ["Squatté", "occupied", "Occupé sans droit ni titre"],
  ["  OCCUPIED ", "occupied", "Occupé"],
  ["n'importe quoi", null, "n'importe quoi"],
];

describe("occupancyClass", () => {
  it.each(KNOWN_VALUES)("%s", (value, occupancy, label) => {
    expect(occupancyClass(value)).toBe(occupancy);
    expect(occupancyLabel(value)).toBe(label);
    expect(isVacantOccupancyStatus(value)).toBe(occupancy === "vacant");
    expect(isOccupiedOccupancyStatus(value)).toBe(
      occupancy === "occupied" || occupancy === "rented",
    );
  });

  it("lit le vocabulaire du graphe des résultats", () => {
    expect(occupancyClass("tenant_occupied")).toBe("rented");
    expect(occupancyClass("occupied_other")).toBe("occupied");
  });
});

/**
 * Les six codes de la contrainte SQL de `occupancy_status` ont la même classe partout : libellé,
 * plafond, écart au marché, analyse d'occupation du rapport et filtre « Occupation ». Avant le lot 10,
 * l'analyse relisait le champ par des motifs de texte et laissait `occupied`, `owner_occupied` et
 * `squatted` « À confirmer ».
 */
describe("les six codes de la base", () => {
  it.each([
    ["vacant", "vacant", null, "Libre", "libre", null, "free"],
    ["occupied", "occupied", null, "Occupé", "occupe", "occupied", "occupied"],
    ["rented", "rented", null, "Loué", "loue", "occupied", "rented"],
    [
      "owner_occupied",
      "occupied",
      "owner_occupied",
      "Occupé par le propriétaire",
      "occupe",
      "occupied",
      "occupied",
    ],
    [
      "squatted",
      "occupied",
      "squatted",
      "Occupé sans droit ni titre",
      "squat",
      "occupied",
      "occupied",
    ],
    ["unknown", null, null, "À confirmer", "inconnu", "occupancy_unknown", "to_confirm"],
  ] as const)("%s", (code, occupancy, detail, label, ceiling, withheld, analysis) => {
    expect(occupancyClass(code)).toBe(occupancy);
    expect(occupancyDetail(code)).toBe(detail);
    expect(occupancyLabel(code)).toBe(label);
    expect(occupationCaseForStatus(code)).toBe(ceiling);
    expect(marketGapWithheldReason(code)).toBe(withheld);
    expect(buildOccupancyAnalysis({ id: "x", occupancy_status: code } as AuctionSale).status).toBe(
      analysis,
    );
    for (const filter of ["vacant", "occupied", "rented"] as const) {
      expect(matchesOccupancyFilter(code, filter), filter).toBe(occupancy === filter);
      expect(occupancyClassCodes(filter).includes(code), filter).toBe(occupancy === filter);
    }
  });

  it("donne au filtre « Occupé » les trois codes d'un bien occupé", () => {
    expect(occupancyClassCodes("vacant")).toEqual(["vacant"]);
    expect(occupancyClassCodes("occupied")).toEqual(["occupied", "owner_occupied", "squatted"]);
    expect(occupancyClassCodes("rented")).toEqual(["rented"]);
  });

  it("ne précise que la classe « occupé »", () => {
    expect(occupancyDetail("Squatté")).toBe("squatted");
    expect(occupancyDetail("Occupé par le propriétaire")).toBe("owner_occupied");
    expect(occupancyDetail("Loué au propriétaire")).toBeNull();
    expect(occupancyDetail(null)).toBeNull();
  });
});
