import { describe, expect, it } from "vitest";
import { compareListingZone, listingPluZone, parcelSurfaceGap } from "./land-report-coherence";

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
