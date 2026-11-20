import { describe, expect, it } from "vitest";
import { MAQUETTE_HOURS, maquetteHourLabel, maquetteLight } from "./light";

describe("maquette 3D : lumière selon l'heure", () => {
  it("le soleil passe de l'est à l'ouest et culmine en milieu de journée", () => {
    const morning = maquetteLight(8);
    const noon = maquetteLight(13.5);
    const evening = maquetteLight(19);
    expect(morning.sunDirection[0]).toBeGreaterThan(0);
    expect(evening.sunDirection[0]).toBeLessThan(0);
    expect(noon.sunDirection[1]).toBeGreaterThan(morning.sunDirection[1]);
    expect(noon.sunDirection[1]).toBeGreaterThan(evening.sunDirection[1]);
  });

  it("le soleil reste au-dessus de l'horizon et sa direction est un vecteur unitaire", () => {
    for (let hour = MAQUETTE_HOURS.min; hour <= MAQUETTE_HOURS.max; hour += MAQUETTE_HOURS.step) {
      const [x, y, z] = maquetteLight(hour).sunDirection;
      expect(y).toBeGreaterThan(0);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    }
  });

  it("la lumière baisse et les fenêtres s'allument à la nuit tombée", () => {
    const noon = maquetteLight(12.5);
    const night = maquetteLight(21);
    expect(night.sunIntensity).toBeLessThan(noon.sunIntensity);
    expect(noon.windowGlow).toBe(0);
    expect(night.windowGlow).toBe(1);
  });

  it("interpole les couleurs entre deux repères", () => {
    // Entre 8 h (0x6fa3d8) et 12 h 30 (0x4f97e0), à mi-chemin.
    expect(maquetteLight(10.25).zenith).toBe(0x5f9ddc);
  });

  it("borne l'heure à la plage du curseur", () => {
    expect(maquetteLight(2)).toEqual(maquetteLight(MAQUETTE_HOURS.min));
    expect(maquetteLight(23)).toEqual(maquetteLight(MAQUETTE_HOURS.max));
  });

  it("dit l'heure en clair", () => {
    expect(maquetteHourLabel(10)).toBe("10 h");
    expect(maquetteHourLabel(14.5)).toBe("14 h 30");
  });
});
