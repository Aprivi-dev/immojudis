import { describe, expect, it } from "vitest";
import {
  compareListingZone,
  landConstraintsOverview,
  landReportReliability,
  landZoneVerdict,
  listingPluZone,
  parcelSurfaceGap,
  rulesUnavailableReason,
} from "./land-report-coherence";

describe("listingPluZone", () => {
  it("reads the zone quoted next to the PLU", () => {
    expect(
      listingPluZone(
        "Jardin à l’arrière Cadastrée section SE n°11 pour 112 m². Zone UP1*1L40 du PLU.",
      ),
    ).toBe("UP1*1L40");
    expect(listingPluZone("Terrain classé en zone UB au PLUi de la métropole.")).toBe("UB");
    expect(listingPluZone("Selon le P.L.U. : zone Nh, constructions limitées.")).toBe("Nh");
    expect(listingPluZone(null, "Le terrain est situé en zone A du PLU.")).toBe("A");
  });

  it.each([
    ["Terrain en zone Nord du PLU."],
    ["Secteur Sud du PLU, belle vue."],
    ["Le PLU classe la zone Est en réserve."],
    ["Zone NATURELLE au PLU."],
    ["Selon le PLU, zone Ouest de la commune."],
  ])("does not take a word for a zone code: %s", (text) => {
    expect(listingPluZone(text)).toBeNull();
  });

  it.each([
    ["Zone AUs du PLU.", "AUs"],
    ["PLU : zone Ah", "Ah"],
    ["Terrain en zone N du PLU.", "N"],
  ])("keeps a short code: %s", (text, zone) => {
    expect(listingPluZone(text)).toBe(zone);
  });

  it("ignores texts that only mention the PLU", () => {
    expect(
      listingPluZone("Renseignements d’urbanisme : voir la zone du PLU en annexe."),
    ).toBeNull();
    expect(listingPluZone("Maison avec jardin, zone calme.")).toBeNull();
  });
});

describe("compareListingZone", () => {
  it("accepts a listing code that refines the official zone", () => {
    expect(compareListingZone("UP1*1L40", [{ label: "UP1" }])).toEqual({
      zone: "UP1*1L40",
      matches: true,
    });
  });

  it.each([
    ["A", "AU"],
    ["AU", "A"],
    ["N", "NA"],
    ["NA", "N"],
    ["U", "UA"],
    ["UA", "U"],
    ["UP1", "UP10"],
    ["UP10", "UP1"],
    ["UP1*1L40", "UP2"],
  ])("does not match the listing zone %s with the official zone %s", (quoted, official) => {
    expect(compareListingZone(quoted, [{ label: official }])?.matches).toBe(false);
  });

  it.each([
    ["UB", "UB"],
    ["ub", "UB"],
    ["Ah", "A"],
    ["A", "Ah"],
    ["UCa2*L12", "UCa2"],
    ["UC", "UCa2"],
    ["N", "Nh"],
    ["AUs", "AUs"],
    ["UP1*1L40", "UP1"],
  ])("matches the listing zone %s with the official zone %s", (quoted, official) => {
    expect(compareListingZone(quoted, [{ label: official }])?.matches).toBe(true);
  });

  it("flags a different zone and stays neutral without an official one", () => {
    expect(compareListingZone("UB", [{ label: "A" }])).toEqual({ zone: "UB", matches: false });
    expect(compareListingZone("UB", [])).toEqual({ zone: "UB", matches: null });
    expect(compareListingZone(null, [{ label: "A" }])).toBeNull();
  });
});

describe("parcelSurfaceGap", () => {
  it("flags parcels far smaller than the land announced", () => {
    expect(parcelSurfaceGap([{ surfaceM2: 640 }], 4348)).toContain("640 m²");
    expect(parcelSurfaceGap([{ surfaceM2: 640 }], 4348)).toContain("d’autres parcelles");
  });

  it("flags a parcel far larger than the land announced", () => {
    expect(parcelSurfaceGap([{ surfaceM2: 654 }], 120)).toContain("plus grande");
  });

  it("stays silent when the surfaces agree or are unknown", () => {
    expect(parcelSurfaceGap([{ surfaceM2: 112 }], 112)).toBeNull();
    expect(parcelSurfaceGap([{ surfaceM2: 19574 }], 19000)).toBeNull();
    expect(parcelSurfaceGap([{ surfaceM2: 100 }], 130)).toBeNull();
    expect(parcelSurfaceGap([{ surfaceM2: 640 }], null)).toBeNull();
    expect(parcelSurfaceGap([{ surfaceM2: null }], 4348)).toBeNull();
    expect(parcelSurfaceGap([], 4348)).toBeNull();
  });
});

describe("landReportReliability", () => {
  const parcel = (match: string) => ({ match }) as never;

  it("ranks a parcel cited by the listing above one found from the address", () => {
    expect(
      landReportReliability({
        parcels: [parcel("listing_reference")],
        locationStatus: "references_matched",
      }),
    ).toMatchObject({ tone: "good", text: expect.stringContaining("l’annonce") });
    expect(
      landReportReliability({
        parcels: [parcel("address_point")],
        locationStatus: "point_candidate",
      }),
    ).toMatchObject({ tone: "watch", text: expect.stringContaining("d’après l’adresse") });
    expect(
      landReportReliability({
        parcels: [parcel("address_point"), parcel("address_point")],
        locationStatus: "ambiguous",
      }).text,
    ).toContain("Plusieurs parcelles");
    expect(landReportReliability({ parcels: [], locationStatus: "unresolved" }).tone).toBe("weak");
  });
});

describe("rulesUnavailableReason", () => {
  it("names the reason in plain words", () => {
    expect(
      rulesUnavailableReason([{ message: "PDF refusé : taille supérieure à 32 Mo." }]),
    ).toContain("trop volumineux");
    expect(
      rulesUnavailableReason([{ message: "Le règlement publié ne contient pas de texte lisible" }]),
    ).toContain("numérisé");
    expect(rulesUnavailableReason([{ message: "Délai dépassé après 15000 ms." }])).toContain(
      "téléchargé",
    );
    expect(rulesUnavailableReason([])).toContain("Aucun article");
  });
});

describe("landZoneVerdict", () => {
  it.each([
    [[{ label: "UCa2", type: "U" }], "zone urbaine (U)"],
    [[{ label: "1AUh", type: "AUc" }], "zone à urbaniser (AU)"],
    [[{ label: "Ap", type: "A" }], "zone agricole (A)"],
    [[{ label: "Nh", type: "unknown" }], "zone naturelle (N)"],
  ])("names the family in plain words", (zones, expected) => {
    expect(landZoneVerdict(zones)).toContain(expected);
  });

  it("lists several families and stays silent without a zone", () => {
    expect(
      landZoneVerdict([
        { label: "UB", type: "U" },
        { label: "N", type: "N" },
      ]),
    ).toBe("Terrain à cheval sur plusieurs zones : zone urbaine (U) et zone naturelle (N).");
    expect(landZoneVerdict([])).toBeNull();
    expect(landZoneVerdict([{ label: "Zone GPU", type: "unknown" }])).toBeNull();
  });
});

describe("landConstraintsOverview", () => {
  const parcels = [{}] as never;
  const layer = (key: string, status: string) => ({ key, status }) as never;

  it("counts what was found", () => {
    expect(
      landConstraintsOverview({ parcels, constraints: [{}, {}] as never, checks: [] }),
    ).toEqual({ status: "found", count: 2 });
  });

  it("says « none » only when the layers were really read", () => {
    expect(
      landConstraintsOverview({
        parcels,
        constraints: [],
        checks: [layer("gpu.prescription-surf", "empty"), layer("gpu.assiette-sup-s", "available")],
      }),
    ).toEqual({ status: "none" });
  });

  it.each([
    ["no parcel", { parcels: [], checks: [layer("gpu.info-surf", "empty")] }],
    ["no layer read", { parcels, checks: [layer("planning", "unavailable")] }],
    ["a layer down", { parcels, checks: [layer("gpu.info-surf", "unavailable")] }],
    ["a layer partial", { parcels, checks: [layer("gpu.info-lin", "partial")] }],
  ])("is unverified with %s", (_name, planning) => {
    expect(landConstraintsOverview({ constraints: [], ...planning })).toMatchObject({
      status: "unverified",
      reason: expect.any(String),
    });
  });
});
