import { describe, expect, it } from "vitest";
import { parcelOutlines } from "./land-parcel-outline";
import type { LandParcel } from "./land-report-types";

const parcel = (overrides: Partial<LandParcel> = {}): LandParcel =>
  ({
    id: "33063000SE0011",
    codeInsee: "33063",
    section: "SE",
    number: "0011",
    prefix: "000",
    city: "Bordeaux",
    surfaceM2: 112,
    match: "listing_reference",
    sourceUrl: "https://apicarto.ign.fr/api/cadastre/parcelle",
    geometry: {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [-0.5533, 44.8743],
            [-0.5532, 44.8743],
            [-0.5532, 44.8745],
            [-0.5533, 44.8743],
          ],
        ],
      ],
    },
    ...overrides,
  }) as LandParcel;

describe("parcelOutlines", () => {
  it("frames the parcels and marks the ones cited by the listing", () => {
    const result = parcelOutlines([parcel()]);
    expect(result?.confirmed).toBe(true);
    expect(result?.outlines[0]?.label).toBe("Section SE n° 0011");
    expect(result?.bounds).toEqual([
      [-0.5533, 44.8743],
      [-0.5532, 44.8745],
    ]);
    expect(result?.center.lat).toBeCloseTo(44.8744, 4);
  });

  it("keeps a parcel found around the address as probable", () => {
    expect(parcelOutlines([parcel({ match: "address_point" })])?.confirmed).toBe(false);
  });

  it("returns nothing without a usable geometry", () => {
    expect(parcelOutlines([])).toBeNull();
    expect(parcelOutlines([parcel({ geometry: { type: "Polygon", coordinates: [] } })])).toBeNull();
  });
});
