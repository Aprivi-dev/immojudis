import { describe, expect, it } from "vitest";
import { PRESUMED_SURFACE_CRITERIA_NOTE, presumedSurfaceNote } from "./presumed-surface";
import { getDisplaySurface, getSaleSurface } from "./surface";

describe("presumedSurfaceNote", () => {
  it("dit la surface provisoire et pourquoi, pour un studio ou un T1 sans surface publiée", () => {
    const note =
      "Surface provisoire de 20 m² retenue pour les calculs : l'annonce ne publie pas la surface.";
    expect(presumedSurfaceNote(getSaleSurface({ title: "Studio" }))).toBe(note);
    expect(
      presumedSurfaceNote(getSaleSurface({ property_type: "apartment", rooms_count: 1 })),
    ).toBe(note);
  });

  it("ne dit rien pour une surface mesurée, un terrain, une vente sans surface ou une nature illisible", () => {
    expect(presumedSurfaceNote(getSaleSurface({ title: "Studio", app_surface_m2: 18 }))).toBeNull();
    expect(
      presumedSurfaceNote(getDisplaySurface({ property_type: "land", land_surface_m2: 900 })),
    ).toBeNull();
    expect(presumedSurfaceNote(getSaleSurface({ property_type: "house" }))).toBeNull();
    expect(presumedSurfaceNote({ kind: null, value: 20 })).toBeNull();
    expect(presumedSurfaceNote({ kind: "estimated", value: null })).toBeNull();
  });

  it("l'aide des critères cite la même surface provisoire", () => {
    expect(PRESUMED_SURFACE_CRITERIA_NOTE).toBe(
      "Un studio ou un appartement d'une pièce sans surface publiée compte pour une surface provisoire de 20 m².",
    );
  });
});
