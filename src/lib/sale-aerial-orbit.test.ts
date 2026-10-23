import { describe, expect, it } from "vitest";
import { aerialOrbitTarget, hasNumberedStreetAddress } from "./sale-aerial-orbit";

const base = {
  latitude: 44.8378,
  longitude: -0.5792,
  address: "12 rue Sainte-Catherine",
  postal_code: "33000",
  city: "Bordeaux",
  quality_flags: [] as unknown,
  location_precision: "address" as string | null | undefined,
  property_type: "apartment" as string | null | undefined,
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
    ["mer du Nord, au large du Royaume-Uni", 54.27, -0.4],
    ["(0, 0)", 0, 0],
    ["latitude et longitude inversées", 6.9, 43.65],
  ])("écarte une position hors de France : %s", (_case, latitude, longitude) => {
    expect(aerialOrbitTarget({ ...base, latitude, longitude })).toBeNull();
  });

  it("accepte un point d'outre-mer", () => {
    expect(
      aerialOrbitTarget({
        ...base,
        latitude: -21.115,
        longitude: 55.536,
        address: "8 rue Maréchal Leclerc",
      }),
    ).not.toBeNull();
  });

  it.each(["address", "parcel", " Address "])("retient la précision %s", (location_precision) => {
    expect(aerialOrbitTarget({ ...base, location_precision })).not.toBeNull();
  });

  it.each(["street", "municipality", "locality", "", "inconnue", null, undefined])(
    "écarte la précision %s : pas de vue 360°",
    (location_precision) => {
      expect(aerialOrbitTarget({ ...base, location_precision })).toBeNull();
    },
  );

  it("écarte une vente sans colonne de précision", () => {
    const { location_precision: _precision, ...withoutPrecision } = base;
    expect(aerialOrbitTarget(withoutPrecision)).toBeNull();
  });

  it.each(["parking", "land", "Parking"])("écarte un bien de type %s", (property_type) => {
    expect(aerialOrbitTarget({ ...base, property_type })).toBeNull();
  });

  it.each(["apartment", "house", "building", "commercial", null, undefined])(
    "garde un bien de type %s",
    (property_type) => {
      expect(aerialOrbitTarget({ ...base, property_type })).not.toBeNull();
    },
  );

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

describe("hasNumberedStreetAddress", () => {
  it.each([
    "12 rue de la Paix",
    "12 allées Jean Jaurès",
    "4 rte de Lyon",
    "12-14 rue Thiers",
    "12 - 14 avenue Foch",
    "12 Grande Rue",
    "5 Grand'Rue",
    "5 Cité Bergère",
    "5 cité Bergère, 75009 Paris",
    "9 ter, chemin des Vignes",
    "Résidence Les Pins, 45 allée des Chênes",
    "Lot 3, 12 rue Sainte-Catherine",
    "2 av. Foch",
    "8 pl. de la Mairie",
    "6 impasse du Moulin",
    "14 montée de la Grande Côte",
    "3 chaussée de l’Étang",
  ])("reconnaît « %s »", (address) => {
    expect(hasNumberedStreetAddress(address)).toBe(true);
  });

  it.each([
    "Lot 2 place de parking",
    "Lot 12, Résidence Les Pins",
    "lots 12 résidence",
    "Appartement 4 rue",
    "12 places de parking",
    "2 place de stationnement",
    "rue Sainte-Catherine",
    "Lieu-dit Les Granges",
    "12",
    "",
  ])("refuse « %s »", (address) => {
    expect(hasNumberedStreetAddress(address)).toBe(false);
  });
});
