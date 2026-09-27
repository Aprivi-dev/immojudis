import { describe, expect, it } from "vitest";
import { parseCadastralGeocode } from "./cadastre-neighborhood";

const input = {
  address: "63 Pl. des Martyrs de la Résistance",
  postalCode: "33000",
  city: "Bordeaux",
};

function result(
  properties: Record<string, unknown>,
  coordinates: unknown = [-0.586227, 44.842748],
) {
  return { features: [{ geometry: { coordinates }, properties }] };
}

describe("cadastral neighborhood geocoding", () => {
  it("accepts a street-level address in the expected commune as an indicative map center", () => {
    expect(
      parseCadastralGeocode(
        result({ type: "housenumber", score: 0.82, postcode: "33000", city: "Bordeaux" }),
        input,
      ),
    ).toEqual({
      lat: 44.842748,
      lng: -0.586227,
      source: "Adresse géocodée par l’IGN",
      kind: "address",
    });
  });

  it("accepts precise Géoplateforme address matches using the _type field", () => {
    expect(
      parseCadastralGeocode(
        result({ _type: "address", score: 0.82, postcode: "33000", city: "Bordeaux" }),
        input,
      ),
    ).toMatchObject({ lat: 44.842748, lng: -0.586227 });
  });

  it("labels a street-level fallback as a street rather than a precise address", () => {
    expect(
      parseCadastralGeocode(
        result({ type: "street", score: 0.86, postcode: "33000", city: "Bordeaux" }),
        input,
      ),
    ).toMatchObject({ kind: "street", source: "Rue localisée par l’IGN" });
  });

  it("rejects vague or mismatched matches so the map cannot suggest a wrong neighborhood", () => {
    expect(
      parseCadastralGeocode(
        result({ type: "municipality", score: 0.95, postcode: "33000", city: "Bordeaux" }),
        input,
      ),
    ).toBeNull();
    expect(
      parseCadastralGeocode(
        result({ type: "housenumber", score: 0.91, postcode: "33000", city: "Talence" }),
        input,
      ),
    ).toBeNull();
  });
});
