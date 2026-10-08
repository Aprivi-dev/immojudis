import { describe, expect, it } from "vitest";
import { climaScoreWidgetDocument, matchClimaScoreCommune } from "./climascore";

describe("ClimaScore commune identity", () => {
  it("selects the exact commune, ignoring accents and punctuation", () => {
    expect(
      matchClimaScoreCommune(
        [
          { code: "33063", nom: "Bordeaux" },
          { code: "33030", nom: "Bègles" },
        ],
        "Bègles",
      ),
    ).toEqual({ code: "33030", name: "Bègles" });
    expect(matchClimaScoreCommune([{ code: "2A004", nom: "Ajaccio" }], "AJACCIO")).toEqual({
      code: "2A004",
      name: "Ajaccio",
    });
  });
  it("does not mistake an approximate or ambiguous match for a location", () => {
    expect(
      matchClimaScoreCommune([{ code: "33063", nom: "Bordeaux" }], "Bordeaux-Saint-Clair"),
    ).toBeNull();
    expect(
      matchClimaScoreCommune(
        [
          { code: "12345", nom: "Saint Pierre" },
          { code: "54321", nom: "Saint-Pierre" },
        ],
        "Saint-Pierre",
      ),
    ).toBeNull();
    expect(matchClimaScoreCommune({ code: "33063" }, "Bordeaux")).toBeNull();
  });
  it("rejects executable content instead of interpolating it into the embed", () => {
    expect(climaScoreWidgetDocument('33063"><script>alert(1)</script>')).toBeNull();
    expect(climaScoreWidgetDocument("33063")).toContain(
      'src="https://climascore.fr/widget/climascore-33063.js"',
    );
    expect(climaScoreWidgetDocument("33063")).toContain(
      'href="https://climascore.fr/risques/33063"',
    );
  });
});
