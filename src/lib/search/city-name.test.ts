import { describe, expect, it } from "vitest";
import { displayCityName, withDisplayCity } from "./city-name";

describe("displayCityName", () => {
  it("met en minuscules les petits mots liés par un trait d'union", () => {
    expect(displayCityName("Aix-En-Provence")).toBe("Aix-en-Provence");
    expect(displayCityName("Boulogne-Sur-Mer")).toBe("Boulogne-sur-Mer");
    expect(displayCityName("Bourg-La-Reine")).toBe("Bourg-la-Reine");
    expect(displayCityName("Saint-Pierre-Des-Corps")).toBe("Saint-Pierre-des-Corps");
    expect(displayCityName("Villeneuve-Lès-Avignon")).toBe("Villeneuve-lès-Avignon");
    expect(displayCityName("Mont-De-Marsan")).toBe("Mont-de-Marsan");
    expect(displayCityName("Les Sables-D'Olonne")).toBe("Les Sables-d'Olonne");
    expect(displayCityName("Villeneuve-D’Ascq")).toBe("Villeneuve-d’Ascq");
  });

  it("laisse les noms déjà bien écrits, le premier mot et les noms en capitales", () => {
    for (const city of [
      "Aix-en-Provence",
      "Saint-Étienne",
      "Bourg-en-Bresse",
      "Le Havre",
      "La Rochelle",
      "L'Isle-Adam",
      "Paris 8e Arrondissement",
      "Longny les Villages",
      "AIX-EN-PROVENCE",
      "Clermont-Ferrand",
      "Saint-Denis",
    ]) {
      expect(displayCityName(city)).toBe(city);
    }
    expect(displayCityName(null)).toBeNull();
    expect(displayCityName(undefined)).toBeUndefined();
    expect(displayCityName("")).toBe("");
  });

  it("rend le même objet quand la commune ne change pas", () => {
    const sale = { id: "a", city: "Bordeaux" };
    expect(withDisplayCity(sale)).toBe(sale);
    const aix = { id: "b", city: "Aix-En-Provence" };
    expect(withDisplayCity(aix)).toEqual({ id: "b", city: "Aix-en-Provence" });
    expect(aix.city).toBe("Aix-En-Provence");
  });
});
