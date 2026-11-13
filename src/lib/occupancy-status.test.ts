import { describe, expect, it } from "vitest";
import { occupancyLabel } from "@/lib/format/property-labels";
import {
  isOccupiedOccupancyStatus,
  isVacantOccupancyStatus,
  occupancyClass,
} from "@/lib/occupancy-status";

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
  ["free", null, "Libre"],
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
