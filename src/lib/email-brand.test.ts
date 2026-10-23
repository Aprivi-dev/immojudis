import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EMAIL_BRAND_NAME, EMAIL_COLORS, EMAIL_COLOR_TOKENS } from "./email-brand";

const css = readFileSync("src/styles.css", "utf8");

function token(name: string): string {
  const match = new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m").exec(css);
  if (!match) throw new Error(`Jeton ${name} introuvable dans src/styles.css`);
  return match[1].toLowerCase();
}

describe("palette des emails", () => {
  it.each(Object.entries(EMAIL_COLOR_TOKENS))(
    "%s reprend le jeton %s de la feuille de style",
    (key, name) => {
      expect(EMAIL_COLORS[key as keyof typeof EMAIL_COLOR_TOKENS].toLowerCase()).toBe(token(name));
    },
  );

  it("nomme la marque « Immojudis », pas en capitales", () => {
    expect(EMAIL_BRAND_NAME).toBe("Immojudis");
  });

  it("garde un texte doré lisible (au moins 4,5:1 sur blanc)", () => {
    const channel = (hex: string, index: number) => {
      const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) =>
      0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
    const ratio = (a: string, b: string) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light + 0.05) / (dark + 0.05);
    };
    expect(ratio(EMAIL_COLORS.goldText, EMAIL_COLORS.white)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(EMAIL_COLORS.inkSoft, EMAIL_COLORS.white)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(EMAIL_COLORS.inkStrong, EMAIL_COLORS.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
