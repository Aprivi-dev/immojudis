import { describe, expect, it } from "vitest";
import {
  getDisplaySurface,
  getMarketValuationSurfaces,
  getSaleSurface,
  STUDIO_ESTIMATED_SURFACE_M2,
} from "./surface";

describe("getSaleSurface", () => {
  it("prefers app surface over habitable and carrez surfaces", () => {
    const surface = getSaleSurface({
      app_surface_m2: 42,
      habitable_surface_m2: 45,
      carrez_surface_m2: 40,
    });

    expect(surface.value).toBe(42);
    expect(surface.estimated).toBe(false);
    expect(surface.kind).toBe("recorded");
  });

  it("estimates a missing studio surface conservatively", () => {
    const surface = getSaleSurface({ title: "Studio vendu occupé" });

    expect(surface.value).toBe(STUDIO_ESTIMATED_SURFACE_M2);
    expect(surface.estimated).toBe(true);
    expect(surface.kind).toBe("estimated");
  });
});

describe("getDisplaySurface", () => {
  it("falls back to land surface for display only", () => {
    const surface = getDisplaySurface({ property_type: "terrain", land_surface_m2: 720 });

    expect(surface.value).toBe(720);
    expect(surface.metricLabel).toBe("Terrain");
    expect(surface.kind).toBe("land");
  });

  it("keeps a normalized land application surface typed as land", () => {
    const surface = getDisplaySurface({
      property_type: "land",
      app_surface_m2: 720,
      app_surface_kind: "land",
      surface_scope: "land",
      land_surface_m2: 720,
    });

    expect(surface).toMatchObject({ value: 720, metricLabel: "Terrain", kind: "land" });
  });
});

describe("getMarketValuationSurfaces", () => {
  it("never exposes a land application surface as built area", () => {
    expect(
      getMarketValuationSurfaces({
        property_type: "land",
        app_surface_m2: 800,
        app_surface_kind: "land",
        surface_scope: "land",
        land_surface_m2: 800,
      }),
    ).toEqual({
      builtSurfaceM2: null,
      landSurfaceM2: 800,
      builtSurfaceEstimated: false,
      builtSurfaceAssumption: null,
      builtSurfaceUncertaintyPct: null,
      surfaceKind: "land",
      surfaceScope: "land",
    });
  });

  it.each(["commercial", "building", "mixed"])(
    "does not invent a built area for a %s lot from rooms or a default",
    (property_type) => {
      for (const rooms_count of [2, null]) {
        expect(getMarketValuationSurfaces({ property_type, rooms_count })).toMatchObject({
          builtSurfaceM2: null,
          builtSurfaceEstimated: false,
          builtSurfaceAssumption: null,
        });
      }
      expect(
        getMarketValuationSurfaces({ property_type, rooms_count: 2, app_surface_m2: 83 }),
      ).toMatchObject({ builtSurfaceM2: 83, builtSurfaceEstimated: false });
    },
  );

  it("estimates a missing apartment surface from the room count", () => {
    expect(
      getMarketValuationSurfaces({
        property_type: "apartment",
        rooms_count: 3,
      }),
    ).toMatchObject({
      builtSurfaceM2: 62,
      builtSurfaceEstimated: true,
    });
  });

  it("estimates a missing house surface from bedrooms when rooms are absent", () => {
    expect(
      getMarketValuationSurfaces({
        property_type: "house",
        bedrooms_count: 3,
      }),
    ).toMatchObject({
      builtSurfaceM2: 100,
      builtSurfaceEstimated: true,
    });
  });

  it("uses a wide, explicit fallback when no surface or room count is published", () => {
    expect(getMarketValuationSurfaces({ property_type: "house" })).toMatchObject({
      builtSurfaceM2: 100,
      builtSurfaceEstimated: true,
      builtSurfaceUncertaintyPct: 45,
    });
  });
  it("keeps the built surface of a house whose title mentions a terrain", () => {
    expect(
      getMarketValuationSurfaces({
        title: "Maison avec terrain de 500 m²",
        property_type: "house",
        app_surface_m2: 90,
        land_surface_m2: 500,
      }),
    ).toMatchObject({
      builtSurfaceM2: 90,
      landSurfaceM2: 500,
      builtSurfaceEstimated: false,
      surfaceKind: null,
    });
  });

  it("keeps the built surface of a house sold with an adjoining plot", () => {
    expect(
      getMarketValuationSurfaces({
        title: "Maison + parcelle attenante",
        property_type: "Maison avec terrain",
        app_surface_m2: 90,
      }),
    ).toMatchObject({ builtSurfaceM2: 90, landSurfaceM2: null, surfaceKind: null });
  });

  it("estimates a house surface from its type even when the title mentions a terrain", () => {
    expect(
      getMarketValuationSurfaces({
        title: "Maison avec terrain",
        property_type: "house",
        rooms_count: 4,
      }),
    ).toMatchObject({ builtSurfaceM2: 100, builtSurfaceEstimated: true });
  });

  it.each(["land", "terrain", "Parcelle"])("still treats a %s typed lot as bare land", (type) => {
    expect(getMarketValuationSurfaces({ property_type: type, app_surface_m2: 800 })).toMatchObject({
      builtSurfaceM2: null,
      landSurfaceM2: 800,
      surfaceKind: "land",
    });
  });
});

// Le type de bien connu décide de la famille ; le titre ne sert que si le type est inconnu.
describe("surface bâtie estimée selon le type de bien et le titre", () => {
  // [type, titre, pièces, surface bâtie retenue pour l'estimation de valeur]
  it.each([
    // Une maison titrée « Appartement T3 » est une maison : barème des maisons.
    ["house", "Appartement T3", null, 100],
    ["house", "Appartement T3", 3, 80],
    ["house", "Studio", null, 100],
    // Un appartement reste un appartement, quels que soient les mots du titre.
    ["apartment", "Appartement dans un immeuble", null, 50],
    ["apartment", "Appartement dans un immeuble", 3, 62],
    ["apartment", "Local commercial", 3, 62],
    // Le titre précise la taille dans la famille appartement : un studio.
    ["apartment", "Studio", null, 20],
    // Un parking, ou un bien « autre », n'a pas de surface bâtie estimée.
    ["parking", "Studio", null, null],
    ["parking", "Studio", 3, null],
    ["other", "Appartement T3", 3, null],
    // Type inconnu : la famille vient du titre.
    ["unknown", "Appartement T3", 3, 62],
    [null, "Maison de ville", null, 100],
    [null, "Studio vendu occupé", null, 20],
    [null, "Immeuble de rapport", 3, null],
  ] as const)(
    "%s titré « %s », %s pièce(s) : %s m²",
    (property_type, title, rooms_count, built) => {
      expect(getMarketValuationSurfaces({ property_type, title, rooms_count }).builtSurfaceM2).toBe(
        built,
      );
    },
  );

  it("n'affiche une surface de studio estimée que pour un appartement", () => {
    expect(getSaleSurface({ property_type: "apartment", title: "Studio" })).toMatchObject({
      value: STUDIO_ESTIMATED_SURFACE_M2,
      kind: "estimated",
    });
    for (const property_type of ["parking", "house", "commercial"]) {
      expect(getSaleSurface({ property_type, title: "Studio" })).toMatchObject({
        value: null,
        kind: "none",
      });
    }
  });
});
