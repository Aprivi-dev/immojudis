import { describe, expect, it } from "vitest";
import { isHouseWithLand } from "@/lib/alerts";
import { propertyTypeLabel } from "@/lib/format/property-labels";
import { resolveMarketPropertySegment } from "@/lib/market-estimation-engine";
import {
  matchesPropertyFamily,
  matchesPropertyTypeFilter,
  propertyFamily,
} from "@/lib/property-type-family";
import { isRentApplicable, rentSegmentFor } from "@/lib/rent-reference";
import { getMarketValuationSurfaces } from "@/lib/surface";
import { listingPropertyClass } from "@/lib/tribunal-listing-statistics";
import type { AuctionSale } from "@/lib/types";

/**
 * Test de caractérisation (lot 9 A) : chaque module classait le type de bien avec sa propre
 * expression rationnelle. Ce tableau fige ce que rend la famille commune et la découpe de chaque
 * module pour les valeurs connues : codes du pipeline, libellés français, libellés DVF.
 * Colonnes : valeur, famille, segment d'estimation, classe des statistiques d'annonces, segment de
 * loyer (2 pièces), référence de loyer applicable (sans surface), libellé affiché.
 */
const KNOWN_VALUES: ReadonlyArray<
  readonly [string | null, string, string, string | null, string, boolean, string]
> = [
  [null, "unknown", "unsupported", null, "apt_1_2", false, "Bien"],
  ["", "unknown", "unsupported", null, "apt_1_2", false, "Bien"],
  ["unknown", "unknown", "unsupported", null, "apt_1_2", false, "Bien à qualifier"],
  ["Unknown", "unknown", "unsupported", null, "apt_1_2", false, "Bien à qualifier"],
  ["inconnu", "unknown", "unsupported", null, "apt_1_2", false, "Bien à qualifier"],
  ["non précisé", "unknown", "unsupported", null, "apt_1_2", false, "Bien à qualifier"],
  ["other", "other", "unsupported", "other", "apt_1_2", false, "Bien à qualifier"],
  ["autre", "other", "unsupported", "other", "apt_1_2", false, "Bien à qualifier"],
  ["apartment", "apartment", "apartment", "apartment", "apt_1_2", true, "Appartement"],
  ["house", "house", "house", "house", "house", true, "Maison"],
  ["building", "building", "building", "other", "apt_all", false, "Immeuble"],
  ["land", "land", "land", "other", "apt_all", false, "Terrain"],
  ["commercial", "commercial", "commercial", "other", "apt_all", false, "Local commercial"],
  ["parking", "parking", "unsupported", "other", "apt_all", false, "Garage / Parking"],
  ["mixed", "mixed", "building", "other", "apt_1_2", false, "Bien mixte"],
  ["Appartement", "apartment", "apartment", "apartment", "apt_1_2", true, "Appartement"],
  ["Maison", "house", "house", "house", "house", true, "Maison"],
  ["Immeuble", "building", "building", "other", "apt_all", false, "Immeuble"],
  ["Terrain", "land", "land", "other", "apt_all", false, "Terrain"],
  ["Local commercial", "commercial", "commercial", "other", "apt_all", false, "Local commercial"],
  ["Parking", "parking", "unsupported", "other", "apt_all", false, "Garage / Parking"],
  ["Garage", "parking", "unsupported", "other", "apt_all", false, "Garage / Parking"],
  ["Box", "parking", "unsupported", "other", "apt_all", false, "Garage / Parking"],
  // « fermé » (l'adjectif) ne fait pas une ferme : ces deux valeurs étaient lues comme des maisons.
  ["Box fermé", "parking", "unsupported", "other", "apt_all", false, "Garage / Parking"],
  ["Garage fermé", "parking", "unsupported", "other", "apt_all", false, "Garage / Parking"],
  ["Cave", "other", "unsupported", "other", "apt_1_2", false, "Cave"],
  ["Studio", "apartment", "apartment", "apartment", "apt_1_2", true, "Appartement"],
  ["Loft", "apartment", "apartment", "apartment", "apt_1_2", true, "Appartement"],
  ["Duplex", "apartment", "apartment", "apartment", "apt_1_2", true, "Appartement"],
  ["T2", "apartment", "apartment", "apartment", "apt_1_2", true, "Appartement"],
  ["Villa", "house", "house", "house", "house", true, "Maison"],
  ["Pavillon", "house", "house", "house", "house", true, "Maison"],
  ["Chalet", "house", "house", "house", "house", true, "Maison"],
  ["Longère", "house", "house", "house", "house", true, "Maison"],
  ["Ferme", "house", "house", "house", "house", true, "Maison"],
  ["Ancienne ferme", "house", "house", "house", "house", true, "Maison"],
  ["Corps de ferme", "house", "house", "house", "house", true, "Maison"],
  ["Mas", "house", "house", "house", "house", true, "Maison"],
  ["Bastide", "house", "house", "house", "house", true, "Maison"],
  ["Propriété", "house", "house", "house", "house", true, "Maison"],
  ["Bureau", "commercial", "commercial", "other", "apt_all", false, "Local commercial"],
  ["Parcelle", "land", "land", "other", "apt_all", false, "Terrain"],
  ["Pré", "land", "land", "other", "apt_all", false, "Terrain"],
  ["Bois", "land", "land", "other", "apt_all", false, "Terrain"],
  ["Immeuble mixte", "building", "building", "other", "apt_all", false, "Immeuble"],
  ["Bien mixte", "mixed", "building", "other", "apt_1_2", false, "Bien mixte"],
  ["Maison avec terrain", "house", "house", "house", "house", true, "Maison"],
  [
    "Appartement avec parking",
    "apartment",
    "apartment",
    "apartment",
    "apt_1_2",
    true,
    "Appartement",
  ],
  [
    "Local industriel. commercial ou assimilé",
    "commercial",
    "commercial",
    "other",
    "apt_all",
    false,
    "Local commercial",
  ],
  ["Dépendance", "other", "unsupported", "other", "apt_1_2", false, "Dépendance"],
  ["BATI MIXTE - LOGEMENT/ACTIVITE", "mixed", "building", "other", "apt_1_2", false, "Bien mixte"],
  ["ACTIVITE", "other", "unsupported", "other", "apt_1_2", false, "ACTIVITE"],
  ["TERRAIN DE TYPE TAB", "land", "land", "other", "apt_all", false, "Terrain"],
  ["UN APPARTEMENT", "apartment", "apartment", "apartment", "apt_1_2", true, "Appartement"],
  ["DES MAISONS", "house", "house", "house", "house", true, "Maison"],
];

describe("propertyFamily et les découpes de chaque module", () => {
  it.each(KNOWN_VALUES)(
    "%s",
    (value, family, segment, listingClass, rentSegment, rentApplicable, label) => {
      expect(propertyFamily(value)).toBe(family);
      expect(resolveMarketPropertySegment({ propertyType: value })).toBe(segment);
      expect(listingPropertyClass(value)).toBe(listingClass);
      expect(rentSegmentFor({ property_type: value, rooms_count: 2 })).toBe(rentSegment);
      expect(isRentApplicable({ property_type: value })).toBe(rentApplicable);
      expect(propertyTypeLabel(value)).toBe(label);
    },
  );

  it("lit les codes du pipeline house et land (la complétude les prenait pour inconnus)", () => {
    expect(propertyFamily("house")).toBe("house");
    expect(propertyFamily("land")).toBe("land");
  });

  it("ne fait d'un terrain nu qu'un bien de la famille terrain", () => {
    const landOnly = (property_type: string) =>
      getMarketValuationSurfaces({ property_type, app_surface_m2: 500 }).surfaceKind === "land";
    expect(landOnly("land")).toBe(true);
    expect(landOnly("Terrain à bâtir")).toBe(true);
    expect(landOnly("Maison avec terrain")).toBe(false);
    expect(landOnly("apartment")).toBe(false);
  });

  it("compte une maison ou un immeuble avec jardin, et ne lit le titre que sans type qualifié", () => {
    const withGarden = (property_type: string | null, title: string | null) =>
      isHouseWithLand({ property_type, title, has_garden: true } as AuctionSale);
    expect(withGarden("house", null)).toBe(true);
    expect(withGarden("building", null)).toBe(true);
    expect(withGarden("apartment", "Appartement dans une maison")).toBe(false);
    expect(withGarden("unknown", "Maison de ville")).toBe(true);
    expect(withGarden("other", "Pavillon avec jardin")).toBe(true);
    expect(isHouseWithLand({ property_type: "house", has_garden: false } as AuctionSale)).toBe(
      false,
    );
  });
});

describe("matchesPropertyFamily", () => {
  it("accepte tout pour un sujet de type inconnu", () => {
    expect(matchesPropertyFamily("Dépendance", null)).toBe(true);
    expect(matchesPropertyFamily(null, "unknown")).toBe(true);
  });

  it("rapproche un code du pipeline et un libellé DVF de la même famille", () => {
    expect(matchesPropertyFamily("Maison", "house")).toBe(true);
    expect(matchesPropertyFamily("Appartement", "apartment")).toBe(true);
    expect(matchesPropertyFamily("Local industriel. commercial ou assimilé", "commercial")).toBe(
      true,
    );
    expect(matchesPropertyFamily("BATI MIXTE - LOGEMENT/ACTIVITE", "mixed")).toBe(true);
    expect(matchesPropertyFamily("Appartement", "house")).toBe(false);
    expect(matchesPropertyFamily(null, "house")).toBe(false);
  });

  it("ne rapproche jamais deux types « autre »", () => {
    expect(matchesPropertyFamily("other", "other")).toBe(false);
    expect(matchesPropertyFamily("Dépendance", "other")).toBe(false);
  });
});

describe("matchesPropertyTypeFilter", () => {
  // La recherche serveur compare la colonne au code du filtre : la règle n'est la même que si chaque
  // code de la contrainte SQL de `property_type` est le nom de sa propre famille.
  it.each([
    "apartment",
    "house",
    "building",
    "land",
    "commercial",
    "parking",
    "mixed",
    "other",
    "unknown",
  ])("le code %s est sa propre famille", (code) => {
    expect(propertyFamily(code)).toBe(code);
  });

  it("compare les familles, pas le texte", () => {
    expect(matchesPropertyTypeFilter("parking", "garage")).toBe(true);
    expect(matchesPropertyTypeFilter("house", "Maison")).toBe(true);
    expect(matchesPropertyTypeFilter("apartment", "house")).toBe(false);
    expect(matchesPropertyTypeFilter(null, "house")).toBe(false);
  });
});
