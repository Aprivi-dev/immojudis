import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`Jeton --${name} introuvable`);
  return match[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe("contraste des jetons dorés (WCAG AA)", () => {
  const backgrounds = {
    blanc: "#ffffff",
    ciel: token("background"),
    crème: token("surface"),
    sable: token("secondary"),
  };

  it.each(Object.entries(backgrounds))("le texte doré tient 4,5:1 sur %s", (_name, background) => {
    expect(contrastRatio(token("gold-text"), background)).toBeGreaterThanOrEqual(4.5);
  });

  it("le texte marine sur l'or des boutons tient 4,5:1", () => {
    expect(contrastRatio(token("brand-navy"), token("gold"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token("brand-navy"), "#d9a35f")).toBeGreaterThanOrEqual(4.5);
  });

  it("le texte blanc sur l'or foncé tient 4,5:1", () => {
    expect(contrastRatio("#ffffff", token("gold-soft"))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", "#a96126")).toBeGreaterThanOrEqual(4.5);
  });

  it("le bouton inactif gris reste lisible", () => {
    expect(contrastRatio("#4a5565", "#e6e9ee")).toBeGreaterThanOrEqual(4.5);
  });

  it("les boutons dorés n'utilisent plus un texte blanc ou ciel sur l'or clair", () => {
    expect(css).toMatch(/\.liquid-button \{[^}]*color: #132238/);
    expect(css).toMatch(/\.ij-signup-button \{[^}]*color: #132238/);
  });
});
