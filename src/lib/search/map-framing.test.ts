import { describe, expect, it } from "vitest";
import {
  clusterSalesLabel,
  framingPoints,
  isInMetropolitanFrance,
  METROPOLITAN_FRANCE_BOUNDS,
} from "./map-framing";

describe("cadrage de la carte", () => {
  it("reconnaît Paris, Bordeaux, Ajaccio et Lille comme métropole", () => {
    expect(isInMetropolitanFrance(48.8566, 2.3522)).toBe(true);
    expect(isInMetropolitanFrance(44.8378, -0.5792)).toBe(true);
    expect(isInMetropolitanFrance(41.9192, 8.7386)).toBe(true);
    expect(isInMetropolitanFrance(50.6292, 3.0573)).toBe(true);
  });

  it("écarte l'Afrique du Nord, l'océan et les coordonnées inversées", () => {
    expect(isInMetropolitanFrance(36.75, 3.06)).toBe(false); // Alger
    expect(isInMetropolitanFrance(0, 0)).toBe(false);
    expect(isInMetropolitanFrance(2.3522, 48.8566)).toBe(false); // latitude et longitude inversées
    expect(isInMetropolitanFrance(Number.NaN, 2)).toBe(false);
  });

  it("ne cadre que sur les points plausibles", () => {
    const points = [
      { id: "paris", latitude: 48.85, longitude: 2.35 },
      { id: "alger", latitude: 36.75, longitude: 3.06 },
      { id: "inverse", latitude: 2.35, longitude: 48.85 },
    ];
    expect(framingPoints(points).map((point) => point.id)).toEqual(["paris"]);
  });

  it("les bornes entourent la France métropolitaine", () => {
    expect(METROPOLITAN_FRANCE_BOUNDS.south).toBeGreaterThan(40);
    expect(METROPOLITAN_FRANCE_BOUNDS.north).toBeLessThan(52);
  });

  it("un groupe affiche un nombre de ventes, pas un prix", () => {
    expect(clusterSalesLabel(1)).toBe("1 vente");
    expect(clusterSalesLabel(220)).toBe("220 ventes");
    expect(clusterSalesLabel(220)).not.toMatch(/€|K/);
  });
});
