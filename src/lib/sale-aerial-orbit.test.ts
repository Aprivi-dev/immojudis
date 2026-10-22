import { describe, expect, it } from "vitest";
import { aerialOrbitTarget } from "./sale-aerial-orbit";

const base = {
  latitude: 44.8378,
  longitude: -0.5792,
  address: "12 rue Sainte-Catherine",
  postal_code: "33000",
  city: "Bordeaux",
  quality_flags: [] as unknown,
};

describe("aerialOrbitTarget", () => {
  it("retient une adresse avec numéro et type de voie", () => {
    expect(aerialOrbitTarget(base)).toEqual({
      lat: 44.8378,
      lng: -0.5792,
      address: "12 rue Sainte-Catherine, 33000, Bordeaux",
    });
  });

  it("ne répète pas le code postal et la commune déjà présents dans l'adresse", () => {
    expect(
      aerialOrbitTarget({ ...base, address: "12 rue Sainte-Catherine, 33000 Bordeaux, France" })
        ?.address,
    ).toBe("12 rue Sainte-Catherine, 33000 Bordeaux, France");
  });

  it.each(["3 bis, avenue Thiers", "Résidence Les Pins, 45 allée des Chênes", "7 Bd Gambetta"])(
    "accepte « %s »",
    (address) => {
      expect(aerialOrbitTarget({ ...base, address })).not.toBeNull();
    },
  );

  it.each([
    ["sans numéro", "rue Sainte-Catherine"],
    ["lieu-dit sans numéro", "Lieu-dit Les Granges"],
    ["commune seule", "Bordeaux"],
    ["numéro de lot, pas de voie", "Lot 12"],
    ["vide", "  "],
  ])("écarte une adresse %s", (_case, address) => {
    expect(aerialOrbitTarget({ ...base, address })).toBeNull();
  });

  it("écarte une vente sans coordonnées exploitables", () => {
    expect(aerialOrbitTarget({ ...base, latitude: null })).toBeNull();
    expect(aerialOrbitTarget({ ...base, longitude: 400 })).toBeNull();
  });

  it.each([
    "implausible_coordinates",
    "unverified_source_coordinates",
    "geocode_outside_department",
    "missing_address",
  ])("écarte une position signalée %s", (flag) => {
    expect(aerialOrbitTarget({ ...base, quality_flags: [flag] })).toBeNull();
  });

  it("ignore les autres signalements", () => {
    expect(aerialOrbitTarget({ ...base, quality_flags: ["dpe_enrichment_failed"] })).not.toBeNull();
  });
});
