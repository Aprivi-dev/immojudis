import { describe, expect, it } from "vitest";
import { DEPARTMENT_NEIGHBORS } from "./department-neighbors";
import { DEPARTMENTS } from "./department-pages";
import {
  DEPARTMENT_CENTROIDS,
  DEPARTMENT_REGIONS,
  FRANCE_MAP_HEIGHT,
  FRANCE_MAP_INSET,
  FRANCE_MAP_INSET_DEPARTMENTS,
  FRANCE_MAP_MAX_RADIUS,
  FRANCE_MAP_WIDTH,
  departmentRegionName,
  franceMapLegendValues,
  franceMapRadius,
  projectInFranceMapInset,
  projectOnFranceMap,
} from "./department-geography";
import { haversineKm } from "./geo";
import { resolveFrenchGeoSearch } from "./search/french-geo-search";

const OVERSEAS = ["971", "972", "973", "974", "976"];
const METROPOLE = DEPARTMENTS.map((department) => department.code).filter(
  (code) => !OVERSEAS.includes(code),
);

describe("régions des départements", () => {
  it("range chacun des 101 départements dans une seule région : 13 régions et l'outre-mer", () => {
    const listed = DEPARTMENT_REGIONS.flatMap((region) => region.departments);
    expect(listed).toHaveLength(DEPARTMENTS.length);
    expect(new Set(listed)).toEqual(new Set(DEPARTMENTS.map((department) => department.code)));
    expect(DEPARTMENT_REGIONS).toHaveLength(14);
    expect(DEPARTMENT_REGIONS.filter((region) => region.inseeCode)).toHaveLength(13);
    expect(DEPARTMENT_REGIONS.at(-1)?.name).toBe("Outre-mer");
  });

  it("concorde avec les régions de la recherche (`search/french-geo-search.ts`)", () => {
    // La recherche tire ses régions de cette table : elle y ajoute des sigles (IDF, PACA…) et range
    // chaque département d'outre-mer dans sa propre région.
    for (const region of DEPARTMENT_REGIONS.filter((item) => item.inseeCode)) {
      expect(resolveFrenchGeoSearch(region.name), region.name).toEqual({
        kind: "region",
        departments: [...region.departments],
      });
    }
    const overseas = DEPARTMENT_REGIONS.find((region) => region.inseeCode == null)!;
    for (const code of overseas.departments) {
      const name = DEPARTMENTS.find((department) => department.code === code)!.name;
      expect(resolveFrenchGeoSearch(name), name).toMatchObject({ departments: [code] });
    }
  });

  it("nomme la région d'un département", () => {
    expect(departmentRegionName("75")).toBe("Île-de-France");
    expect(departmentRegionName("33")).toBe("Nouvelle-Aquitaine");
    expect(departmentRegionName("2A")).toBe("Corse");
    expect(departmentRegionName("972")).toBe("Outre-mer");
    expect(departmentRegionName("99")).toBeNull();
  });
});

describe("centres des départements", () => {
  it("couvre exactement les 96 départements de métropole", () => {
    expect(Object.keys(DEPARTMENT_CENTROIDS).sort()).toEqual([...METROPOLE].sort());
  });

  it("place chaque centre en France métropolitaine", () => {
    for (const [code, [lat, lon]] of Object.entries(DEPARTMENT_CENTROIDS)) {
      expect(lat, code).toBeGreaterThan(41.3);
      expect(lat, code).toBeLessThan(51.1);
      expect(lon, code).toBeGreaterThan(-5.2);
      expect(lon, code).toBeLessThan(9.6);
    }
  });

  it("garde les départements voisins proches et retrouve des repères connus", () => {
    const point = (code: string) => {
      const [lat, lng] = DEPARTMENT_CENTROIDS[code];
      return { lat, lng };
    };
    // Deux départements limitrophes ont leurs centres à moins de 160 km.
    for (const [code, neighbors] of Object.entries(DEPARTMENT_NEIGHBORS)) {
      for (const neighbor of neighbors) {
        expect(haversineKm(point(code), point(neighbor)), `${code}-${neighbor}`).toBeLessThan(160);
      }
    }
    // Le centre de Paris est à moins de 2 km de Notre-Dame ; celui du Rhône au nord-ouest de Lyon.
    expect(haversineKm(point("75"), { lat: 48.853, lng: 2.3499 })).toBeLessThan(2);
    expect(haversineKm(point("69"), { lat: 45.764, lng: 4.8357 })).toBeLessThan(25);
  });
});

describe("carte de l'index", () => {
  it("met la métropole hors du médaillon dans le cadre, et le médaillon sur l'océan", () => {
    const inset = FRANCE_MAP_INSET;
    for (const [code, [lat, lon]] of Object.entries(DEPARTMENT_CENTROIDS)) {
      const { x, y } = FRANCE_MAP_INSET_DEPARTMENTS.has(code)
        ? projectInFranceMapInset(lat, lon)
        : projectOnFranceMap(lat, lon);
      expect(x, code).toBeGreaterThan(FRANCE_MAP_MAX_RADIUS / 2);
      expect(x, code).toBeLessThan(FRANCE_MAP_WIDTH);
      expect(y, code).toBeGreaterThan(FRANCE_MAP_MAX_RADIUS / 2);
      expect(y, code).toBeLessThan(FRANCE_MAP_HEIGHT);
      const inBox =
        x > inset.x && x < inset.x + inset.width && y > inset.y && y < inset.y + inset.height;
      expect(inBox, code).toBe(FRANCE_MAP_INSET_DEPARTMENTS.has(code));
    }
  });

  it("garde le nord en haut et l'ouest à gauche", () => {
    const at = (code: string) => {
      const [lat, lon] = DEPARTMENT_CENTROIDS[code];
      return projectOnFranceMap(lat, lon);
    };
    expect(at("59").y).toBeLessThan(at("13").y);
    expect(at("29").x).toBeLessThan(at("67").x);
  });

  it("donne aux ronds une aire proportionnelle au nombre de ventes", () => {
    expect(franceMapRadius(50, 50)).toBe(FRANCE_MAP_MAX_RADIUS);
    const quarter = franceMapRadius(10, 40)!;
    expect(quarter ** 2 * 4).toBeCloseTo(FRANCE_MAP_MAX_RADIUS ** 2, 6);
    expect(franceMapRadius(0, 40)).toBeNull();
    expect(franceMapRadius(3, 0)).toBeNull();
  });

  it("choisit des valeurs de légende rondes, sans dépasser le maximum", () => {
    expect(franceMapLegendValues(53)).toEqual([1, 10, 50]);
    expect(franceMapLegendValues(230)).toEqual([1, 50, 200]);
    expect(franceMapLegendValues(5)).toEqual([1, 5]);
    expect(franceMapLegendValues(1)).toEqual([1]);
    expect(franceMapLegendValues(0)).toEqual([]);
  });
});
