import { describe, expect, it } from "vitest";
import {
  ANIL_RENT_SOURCES,
  defaultRentPerM2,
  isRentApplicable,
  median,
  rentReference,
  rentReferenceFromAnilMedian,
  rentReferenceFromAnilRow,
  rentReliability,
  rentSegmentFor,
  resolveRentReference,
  type AnilRentRow,
} from "./rent-reference";
import {
  ANIL_CURRENT_EDITION,
  formatRentSourceDate,
  isAnilRentReference,
  RENT_ATTRIBUTION,
  rentSourceDetail,
  rentSourceNotice,
} from "./rent-source-notice";

const row: AnilRentRow = {
  commune_code: "33063",
  segment: "apt_all",
  rent_per_m2: 15.9931,
  rent_low_per_m2: 12.272,
  rent_high_per_m2: 20.8427,
  prediction_type: "commune",
  observations_commune: 84_641,
  r2_adj: 0.821385,
  vintage: 2025,
  source_updated_on: "2025-12-11",
};

describe("rentSegmentFor", () => {
  it("picks the house segment for a house, whatever the number of rooms", () => {
    expect(rentSegmentFor({ property_type: "house", rooms_count: 5 })).toBe("house");
    expect(rentSegmentFor({ property_type: "Maison de ville", rooms_count: null })).toBe("house");
  });

  it("splits apartments at two rooms", () => {
    expect(rentSegmentFor({ property_type: "apartment", rooms_count: 1 })).toBe("apt_1_2");
    expect(rentSegmentFor({ property_type: "apartment", rooms_count: 2 })).toBe("apt_1_2");
    expect(rentSegmentFor({ property_type: "apartment", rooms_count: 3 })).toBe("apt_3p");
    expect(rentSegmentFor({ property_type: "appartement", rooms_count: 6 })).toBe("apt_3p");
  });

  it("falls back to all apartments when the rooms or the type are unknown", () => {
    expect(rentSegmentFor({ property_type: "apartment", rooms_count: null })).toBe("apt_all");
    expect(rentSegmentFor({ property_type: "apartment", rooms_count: 0 })).toBe("apt_all");
    expect(rentSegmentFor({ property_type: null, rooms_count: null })).toBe("apt_all");
    expect(rentSegmentFor({ property_type: "parking", rooms_count: 1 })).toBe("apt_all");
    expect(rentSegmentFor({ property_type: "building", rooms_count: 8 })).toBe("apt_all");
  });
});

describe("dwellings and the others", () => {
  it("recognises the farms, châteaux, mas, properties and bastides as houses", () => {
    for (const type of [
      "ferme",
      "Château",
      "chateau",
      "mas",
      "propriété",
      "propriete",
      "bastide",
      "longère",
      "pavillon",
    ]) {
      expect(rentSegmentFor({ property_type: type, rooms_count: 2 }), type).toBe("house");
      expect(isRentApplicable({ property_type: type }), type).toBe(true);
    }
    // « mas » is a word, not a syllable.
    expect(rentSegmentFor({ property_type: "masseur", rooms_count: 2 })).toBe("apt_1_2");
  });

  it("gives no rent reference to land, parkings, garages, premises, offices or buildings", () => {
    for (const type of [
      "land",
      "terrain",
      "parking",
      "garage",
      "box",
      "cave",
      "local commercial",
      "bureau",
      "building",
      "immeuble",
      "entrepôt",
    ]) {
      expect(isRentApplicable({ property_type: type }), type).toBe(false);
    }
  });

  it("keeps houses and apartments (pipeline codes and French wording) as dwellings", () => {
    for (const type of [
      "apartment",
      "house",
      "appartement",
      "Appartement T3",
      "studio",
      "duplex",
    ]) {
      expect(isRentApplicable({ property_type: type }), type).toBe(true);
    }
  });

  it("uses a white list: mixed and other lots, and unrecognised types, have no rent reference", () => {
    // Codes anglais du pipeline (`normalize_property_type`) : seuls house et apartment sont des logements.
    const codes: Record<string, boolean> = {
      house: true,
      apartment: true,
      mixed: false,
      other: false,
      land: false,
      building: false,
      commercial: false,
      unknown: false,
    };
    for (const [type, expected] of Object.entries(codes)) {
      expect(isRentApplicable({ property_type: type }), type).toBe(expected);
      // Une surface ne change rien pour un type connu qui n'est pas un logement.
      expect(isRentApplicable({ property_type: type, app_surface_m2: 60 }), type).toBe(
        expected || type === "unknown",
      );
    }
    expect(isRentApplicable({ property_type: "lot divers", app_surface_m2: 60 })).toBe(false);
  });

  it("gives unknown or missing types a reference only when the sale publishes a surface", () => {
    for (const property_type of ["unknown", "", null, undefined]) {
      expect(isRentApplicable({ property_type }), String(property_type)).toBe(false);
      expect(isRentApplicable({ property_type, app_surface_m2: 0 })).toBe(false);
      expect(isRentApplicable({ property_type, app_surface_m2: 45 })).toBe(true);
      expect(isRentApplicable({ property_type, habitable_surface_m2: 45 })).toBe(true);
      expect(isRentApplicable({ property_type, carrez_surface_m2: 45 })).toBe(true);
    }
  });
});

describe("rentReliability", () => {
  it("is reliable only for a commune estimate with 30 observations and an R2 of 0.5", () => {
    const base = { prediction_type: "commune", observations_commune: 30, r2_adj: 0.5 };
    expect(rentReliability(base)).toBe("reliable");
    expect(rentReliability({ ...base, observations_commune: 29 })).toBe("indicative");
    expect(rentReliability({ ...base, r2_adj: 0.49 })).toBe("indicative");
    expect(rentReliability({ ...base, r2_adj: null })).toBe("indicative");
    expect(rentReliability({ ...base, observations_commune: null })).toBe("indicative");
    expect(rentReliability({ ...base, prediction_type: "maille" })).toBe("indicative");
    expect(rentReliability({ ...base, prediction_type: "epci" })).toBe("indicative");
  });
});

describe("rentReferenceFromAnilRow", () => {
  it("keeps the rent, its bounds, the vintage and the update date of the row", () => {
    expect(rentReferenceFromAnilRow(row)).toEqual({
      rentPerM2: 15.9931,
      source: "anil_commune",
      reliability: "reliable",
      segment: "apt_all",
      communeCode: "33063",
      lowPerM2: 12.272,
      highPerM2: 20.8427,
      observations: 84_641,
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
  });

  it("maps the prediction type to the source and reads numeric strings", () => {
    expect(rentReferenceFromAnilRow({ ...row, prediction_type: "maille" })?.source).toBe(
      "anil_maille",
    );
    expect(rentReferenceFromAnilRow({ ...row, prediction_type: "epci" })?.source).toBe("anil_epci");
    const fromString = rentReferenceFromAnilRow({
      ...row,
      rent_per_m2: "9.7577" as unknown as number,
      rent_low_per_m2: null,
    });
    expect(fromString?.rentPerM2).toBe(9.7577);
    expect(fromString?.lowPerM2).toBeNull();
  });

  it("drops an unusable row", () => {
    expect(rentReferenceFromAnilRow({ ...row, prediction_type: "autre" })).toBeNull();
    expect(rentReferenceFromAnilRow({ ...row, rent_per_m2: 0 })).toBeNull();
    expect(rentReferenceFromAnilRow({ ...row, rent_per_m2: Number.NaN })).toBeNull();
  });
});

describe("department fallback", () => {
  it("keeps the department table when no ANIL reference exists", () => {
    expect(rentReference("33")).toEqual({
      rentPerM2: 14,
      source: "department_estimate",
      reliability: "indicative",
    });
    expect(rentReference("Gironde")?.rentPerM2).toBe(14);
    expect(rentReference("23")).toBeNull();
    expect(rentReference(null)).toBeNull();
    expect(defaultRentPerM2("33")).toBe(14);
    expect(defaultRentPerM2("23")).toBeNull();
  });

  it("prefers the ANIL reference over the department one", () => {
    const anil = rentReferenceFromAnilRow(row);
    expect(resolveRentReference(anil, "33")?.source).toBe("anil_commune");
    expect(defaultRentPerM2("33", anil)).toBe(15.9931);
    expect(resolveRentReference(null, "33")?.source).toBe("department_estimate");
    // A department without any reference stays without one: no invented rent.
    expect(resolveRentReference(null, "23")).toBeNull();
    // An ANIL reference serves a department that the old table did not cover.
    expect(defaultRentPerM2("23", anil)).toBe(15.9931);
  });

  it("tells ANIL references from the fallback", () => {
    expect(isAnilRentReference(rentReferenceFromAnilRow(row))).toBe(true);
    expect(isAnilRentReference(rentReference("33"))).toBe(false);
    expect(isAnilRentReference(null)).toBe(false);
  });
});

describe("source notice", () => {
  it("formats the update date in French", () => {
    expect(formatRentSourceDate("2025-12-11")).toBe("11 décembre 2025");
    expect(formatRentSourceDate("2025-12-11T14:50:11+00:00")).toBe("11 décembre 2025");
    expect(formatRentSourceDate(null)).toBeNull();
    expect(formatRentSourceDate("hier")).toBeNull();
  });

  it("states the credit exactly, then the edition and the responsibility, for ANIL data only", () => {
    expect(RENT_ATTRIBUTION).toBe(
      "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
    );
    const anil = rentReferenceFromAnilRow(row);
    expect(rentSourceDetail(anil)).toBe(
      "Carte des loyers 2025 (loyers d’annonce, charges comprises), mise à jour du 11 décembre 2025, Licence Ouverte 2.0. " +
        "Rendement calculé par Immojudis, sous sa seule responsabilité : ni l’ANIL, ni SeLoger, ni leboncoin n’en sont responsables.",
    );
    expect(rentSourceNotice(anil)).toBe(`${RENT_ATTRIBUTION} ${rentSourceDetail(anil)}`);
    expect(rentSourceNotice(rentReference("33"))).toBeNull();
    expect(rentSourceNotice(null)).toBeNull();
  });

  it("shows the edition of the data actually used", () => {
    const older = rentReferenceFromAnilRow({
      ...row,
      vintage: 2024,
      source_updated_on: "2024-12-05",
    });
    expect(rentSourceDetail(older)).toContain("Carte des loyers 2024");
    expect(rentSourceDetail(older)).toContain("mise à jour du 5 décembre 2024");
    expect(ANIL_CURRENT_EDITION).toEqual({ vintage: 2025, sourceUpdatedOn: "2025-12-11" });
  });
});

describe("median fallbacks computed on the ANIL map", () => {
  it("takes the middle value, or the mean of the two middle ones", () => {
    expect(median([30, 34, 40])).toBe(34);
    expect(median([30, 34, 36, 40])).toBe(35);
    expect(median([12])).toBe(12);
    expect(median([])).toBeNull();
    expect(median([Number.NaN, 10])).toBe(10);
  });

  it("builds an indicative reference that keeps the vintage and the date of the map", () => {
    expect(
      rentReferenceFromAnilMedian({
        rentPerM2: 13.123456,
        source: "anil_department_median",
        segment: "house",
        vintage: 2025,
        sourceUpdatedOn: "2025-12-11",
      }),
    ).toEqual({
      rentPerM2: 13.1235,
      source: "anil_department_median",
      reliability: "indicative",
      segment: "house",
      communeCode: null,
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
    });
    expect(
      rentReferenceFromAnilMedian({
        rentPerM2: Number.NaN,
        source: "anil_department_median",
        segment: null,
        vintage: null,
        sourceUpdatedOn: null,
      }),
    ).toBeNull();
  });

  it("credits the ANIL for every source derived from its map, and for no other", () => {
    expect(ANIL_RENT_SOURCES).toContain("anil_arrondissements_median");
    expect(ANIL_RENT_SOURCES).toContain("anil_department_median");
    expect(ANIL_RENT_SOURCES).not.toContain("department_estimate");
    for (const source of ANIL_RENT_SOURCES) {
      expect(isAnilRentReference({ rentPerM2: 1, source, reliability: "indicative" })).toBe(true);
    }
    expect(
      rentSourceDetail({ source: "anil_department_median", vintage: 2025, sourceUpdatedOn: null }),
    ).toContain("Carte des loyers 2025");
  });
});
