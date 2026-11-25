import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) as Record<
  string,
  unknown
>;

describe("manifeste de l'application", () => {
  it("reprend le papier de la marque et l'accroche du site", () => {
    expect(manifest.background_color).toBe("#ece6d3");
    expect(manifest.theme_color).toBe("#45201a");
    expect(manifest.description).toBe("Les enchères immobilières, en toute clarté");
    expect(manifest.name).toBe("Immojudis");
  });
});
