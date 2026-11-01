import { describe, expect, it } from "vitest";
import { occupancyLabel, propertyTypeLabel } from "./property-labels";

describe("occupancyLabel", () => {
  // Tous les statuts de la contrainte SQL de `occupancy_status` (vacant, occupied, rented,
  // owner_occupied, squatted, unknown), puis les variantes françaises du pipeline.
  it.each([
    ["vacant", "Libre"],
    ["occupied", "Occupé"],
    ["rented", "Loué"],
    ["owner_occupied", "Occupé par le propriétaire"],
    ["squatted", "Occupé sans droit ni titre"],
    ["unknown", "À confirmer"],
    [null, "Non renseigné"],
    [undefined, "Non renseigné"],
    ["", "Non renseigné"],
    ["tenant_occupied", "Loué"],
    ["inoccupé", "Libre"],
    ["Inoccupé", "Libre"],
    ["libre", "Libre"],
    ["free", "Libre"],
    ["loué", "Loué"],
    ["Occupé par le propriétaire", "Occupé par le propriétaire"],
    ["inconnu", "À confirmer"],
  ])("labels %s as %s", (status, label) => {
    expect(occupancyLabel(status)).toBe(label);
  });

  it("never shows an English code for a status of the SQL constraint", () => {
    for (const status of [
      "vacant",
      "occupied",
      "rented",
      "owner_occupied",
      "squatted",
      "unknown",
    ]) {
      expect(occupancyLabel(status), status).not.toMatch(/[a-z]_[a-z]|squatted|vacant|rented/);
    }
  });

  it("keeps a free-text status that no rule recognizes", () => {
    expect(occupancyLabel("En cours de vérification")).toBe("En cours de vérification");
  });
});

describe("propertyTypeLabel", () => {
  it.each([
    ["apartment", "Appartement"],
    ["house", "Maison"],
    ["building", "Immeuble"],
    ["land", "Terrain"],
    ["parking", "Garage / Parking"],
    ["commercial", "Local commercial"],
    ["mixed", "Bien mixte"],
    ["other", "Bien à qualifier"],
  ])("labels %s", (code, label) => {
    expect(propertyTypeLabel(code)).toBe(label);
  });

  it("never shows an internal code that has no label yet", () => {
    expect(propertyTypeLabel("agricultural_estate")).toBe("Bien à qualifier");
    expect(propertyTypeLabel(null)).toBe("Bien");
  });

  it("keeps a human-written label untouched", () => {
    expect(propertyTypeLabel("Château")).toBe("Château");
  });
});
