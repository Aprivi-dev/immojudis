import { describe, expect, it } from "vitest";
import {
  parentCommuneCode,
  arrondissementCode,
  communeCodeFromGeocode,
  normalizeCommuneCode,
  saleCommuneCode,
} from "./sale-commune-code";

describe("saleCommuneCode", () => {
  it("reads the accepted geocode of the pipeline payload", () => {
    expect(
      saleCommuneCode({ raw_payload: { geocode: { accepted: true, citycode: "33063" } } }),
    ).toBe("33063");
    expect(saleCommuneCode({ raw_payload: { geocode: { citycode: "2a004" } } })).toBe("2A004");
    expect(saleCommuneCode({ raw_payload: { geocode: { citycode: "75108" } } })).toBe("75108");
  });

  it("returns null when the payload is absent, rejected or malformed", () => {
    expect(saleCommuneCode({})).toBeNull();
    expect(saleCommuneCode({ raw_payload: null })).toBeNull();
    expect(saleCommuneCode({ raw_payload: "texte" })).toBeNull();
    expect(saleCommuneCode({ raw_payload: [] })).toBeNull();
    expect(saleCommuneCode({ raw_payload: { geocode: "x" } })).toBeNull();
    expect(
      saleCommuneCode({ raw_payload: { geocode: { accepted: false, citycode: "33063" } } }),
    ).toBeNull();
    expect(saleCommuneCode({ raw_payload: { geocode: { citycode: "3306" } } })).toBeNull();
    expect(saleCommuneCode({ raw_payload: { geocode: { citycode: 33063 } } })).toBeNull();
  });

  it("normalises and validates INSEE codes", () => {
    expect(normalizeCommuneCode(" 97411 ")).toBe("97411");
    expect(normalizeCommuneCode("ABCDE")).toBeNull();
    expect(normalizeCommuneCode(null)).toBeNull();
    expect(communeCodeFromGeocode(undefined)).toBeNull();
  });
});

describe("saleCommuneCode : le point de raccord", () => {
  it("lit d'abord l'arrondissement écrit par le lot « code commune », puis la commune, puis le géocodage", () => {
    const geocode = { accepted: true, citycode: "75056" };
    expect(
      saleCommuneCode({
        raw_payload: { commune: { arrondissement_insee: "75108", insee: "75056" }, geocode },
      }),
    ).toBe("75108");
    expect(saleCommuneCode({ raw_payload: { commune: { insee: "33063" }, geocode } })).toBe(
      "33063",
    );
    expect(saleCommuneCode({ raw_payload: { commune: { insee: "bad" }, geocode } })).toBe("75056");
    expect(
      saleCommuneCode({
        raw_payload: { commune: { arrondissement_insee: "bad", insee: "33063" } },
      }),
    ).toBe("33063");
    expect(saleCommuneCode({ raw_payload: { commune: "texte" } })).toBeNull();
  });

  it("déduit l'arrondissement du code postal pour Paris, Lyon et Marseille", () => {
    const from = (citycode: string, postal_code: string | null) =>
      saleCommuneCode({ raw_payload: { geocode: { accepted: true, citycode } }, postal_code });

    expect(from("75056", "75008")).toBe("75108");
    expect(from("75056", "75016")).toBe("75116");
    expect(from("75056", "75116")).toBe("75116");
    expect(from("75056", "75001")).toBe("75101");
    expect(from("75056", "75020")).toBe("75120");
    expect(from("69123", "69003")).toBe("69383");
    expect(from("69123", "69009")).toBe("69389");
    expect(from("13055", "13008")).toBe("13208");
    expect(from("13055", "13016")).toBe("13216");
  });

  it("garde la commune quand le code postal ne permet pas de conclure", () => {
    expect(arrondissementCode("75056", null)).toBe("75056");
    expect(arrondissementCode("75056", "92100")).toBe("75056");
    expect(arrondissementCode("75056", "75021")).toBe("75056");
    expect(arrondissementCode("69123", "69100")).toBe("69123");
    expect(arrondissementCode("13055", "13017")).toBe("13055");
    expect(arrondissementCode(null, "75008")).toBeNull();
    // Une autre commune, ou un arrondissement déjà connu, ne bouge pas.
    expect(arrondissementCode("33063", "33000")).toBe("33063");
    expect(arrondissementCode("75108", "75008")).toBe("75108");
  });
});

describe("parentCommuneCode", () => {
  it.each([
    ["75101", "75056"],
    ["75108", "75056"],
    ["75116", "75056"],
    ["75120", "75056"],
    ["69381", "69123"],
    ["69389", "69123"],
    ["13201", "13055"],
    ["13216", "13055"],
    ["75056", "75056"],
    ["69123", "69123"],
    ["13055", "13055"],
    ["33063", "33063"],
    ["2a004", "2A004"],
  ])("%s a pour parent %s", (code, parent) => {
    expect(parentCommuneCode(code)).toBe(parent);
  });

  it("ne confond pas un code voisin avec un arrondissement", () => {
    for (const code of ["75121", "69380", "69390", "13217", "13200", "75100"]) {
      expect(parentCommuneCode(code), code).toBe(code);
    }
  });

  it("rend null pour un code absent ou invalide", () => {
    for (const code of [null, undefined, "", "abc", "7510"]) {
      expect(parentCommuneCode(code)).toBeNull();
    }
  });
});
