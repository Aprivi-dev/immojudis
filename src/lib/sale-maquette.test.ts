import { describe, expect, it } from "vitest";
import { maquetteKind } from "./sale-maquette";

describe("maquette 3D : volume par type de bien", () => {
  it("un appartement, une maison et un terrain ont chacun leur volume", () => {
    expect(maquetteKind("apartment")).toBe("apartment");
    expect(maquetteKind("Maison avec terrain")).toBe("house");
    expect(maquetteKind("land")).toBe("land");
  });

  it("un immeuble, mixte ou non, est un immeuble entier", () => {
    expect(maquetteKind("building")).toBe("building");
    expect(maquetteKind("mixed")).toBe("building");
  });

  it("aucun volume pour un local, un parking ou un type inconnu", () => {
    for (const type of ["commercial", "parking", "other", "unknown", "", null, undefined]) {
      expect(maquetteKind(type)).toBeNull();
    }
  });
});
