import { describe, expect, it } from "vitest";
import { dpeRentalNote, suggestWorksScenario } from "./works-guidance";

describe("suggestWorksScenario", () => {
  it("reads the published condition before the DPE class", () => {
    expect(suggestWorksScenario("Rafraîchissement à prévoir", "G")?.scenario).toBe(
      "rafraichissement",
    );
    expect(suggestWorksScenario("Appartement à rénover", null)?.scenario).toBe("confort");
    expect(suggestWorksScenario("Maison très dégradée", null)?.scenario).toBe("premium");
    expect(suggestWorksScenario("Bon état général", null)).toEqual({
      scenario: null,
      reason: "Suggéré par l’état décrit (« Bon état général »).",
    });
  });

  it("falls back on a poor DPE class and otherwise suggests nothing", () => {
    expect(suggestWorksScenario(null, "f")?.scenario).toBe("confort");
    expect(suggestWorksScenario(null, "D")).toBeNull();
    expect(suggestWorksScenario("", null)).toBeNull();
  });
});

describe("dpeRentalNote", () => {
  it("follows the loi Climat et résilience calendar", () => {
    expect(dpeRentalNote("G")?.text).toContain("1er janvier 2025");
    expect(dpeRentalNote("F")?.text).toContain("1er janvier 2028");
    expect(dpeRentalNote("E")?.text).toContain("1er janvier 2034");
    expect(dpeRentalNote("D")?.tone).toBe("neutral");
    expect(dpeRentalNote("Z")).toBeNull();
    expect(dpeRentalNote(null)).toBeNull();
  });
});
