import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAP_ACTIVE_FILL, MAP_PALETTE, MAP_PRICE_HALO } from "./map-palette";

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Jeton --${name} introuvable`);
  return match[1].toLowerCase();
}

describe("palette de la carte", () => {
  it("reprend les jetons de styles.css", () => {
    expect(MAP_PALETTE.navy).toBe(token("brand-navy"));
    expect(MAP_PALETTE.gold).toBe(token("gold"));
    expect(MAP_PALETTE.goldSoft).toBe(token("gold-soft"));
    expect(MAP_PALETTE.white).toBe("#ffffff");
  });

  it("dérive les fonds translucides des mêmes jetons", () => {
    expect(MAP_ACTIVE_FILL).toBe("rgba(201,141,69,0.25)");
    expect(MAP_PRICE_HALO).toBe("rgba(19,34,56,0.28)");
  });
});
