import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMAIL_BRAND_NAME,
  EMAIL_COLORS,
  EMAIL_COLOR_TOKENS,
  EMAIL_DARK_COLORS,
  EMAIL_FONT_STACK,
  emailBrandHeaderHtml,
} from "./email-brand";

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

  it("écrit en Manrope puis en sans empattement, jamais en Georgia", () => {
    expect(EMAIL_FONT_STACK).toBe("Manrope, 'Helvetica Neue', Helvetica, Arial, sans-serif");
    // Apostrophes simples : la pile se glisse dans des attributs style="…".
    expect(EMAIL_FONT_STACK).not.toContain('"');
    expect(EMAIL_FONT_STACK).not.toMatch(/georgia|serif'|times/i);
  });

  it("ouvre les gabarits HTML par une barre or de 6 px et le nom « Immojudis »", () => {
    const header = emailBrandHeaderHtml();
    expect(header).toContain(`border-top:6px solid ${EMAIL_COLORS.gold}`);
    expect(header).toContain(`>${EMAIL_BRAND_NAME}</span>`);
    expect(header).not.toMatch(/IMMOJUDIS|text-transform/);
  });

  it("reprend le fond de page du site (#fbf9f5) et le filet de carte, pas l'ancien #fffaf2", () => {
    expect(EMAIL_COLORS.background).toBe("#fbf9f5");
    expect(EMAIL_COLORS.line).toBe("#d8cfc1");
  });

  it("fixe la palette du mode sombre validée", () => {
    expect(EMAIL_DARK_COLORS).toEqual({
      page: "#07111f",
      card: "#132238",
      text: "#f5efe4",
      muted: "#bdb4a4",
      line: "#263c58",
      link: "#e8c98e",
      button: "#e8c98e",
    });
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
