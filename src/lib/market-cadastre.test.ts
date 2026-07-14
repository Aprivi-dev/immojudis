import { describe, expect, it } from "vitest";
import { cadastreSurfaceFromPayload } from "@/lib/market-cadastre";

describe("market cadastre fallback", () => {
  it("extracts the smallest intersecting official parcel surface", () => {
    expect(
      cadastreSurfaceFromPayload({
        features: [
          { properties: { idu: "large", contenance: 2035 } },
          { properties: { idu: "small", contenance: "480" } },
        ],
      }),
    ).toMatchObject({ surfaceM2: 480, parcelId: "small" });
  });

  it("rejects malformed or empty parcel responses", () => {
    expect(cadastreSurfaceFromPayload({ features: [] })).toBeNull();
    expect(
      cadastreSurfaceFromPayload({ features: [{ properties: { contenance: 0 } }] }),
    ).toBeNull();
  });
});
