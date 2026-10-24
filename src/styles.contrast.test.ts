import { readdirSync, readFileSync } from "node:fs";
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
    papier: token("background"),
    crème: token("surface"),
    sable: token("secondary"),
  };

  it.each(Object.entries(backgrounds))("le texte doré tient 4,5:1 sur %s", (_name, background) => {
    expect(contrastRatio(token("gold-text"), background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["blanc", "#ffffff"],
    ["crème", token("surface")],
    ["gris clair", token("surface-muted")],
    ["teinte chaude", token("surface-tint")],
  ])("le texte secondaire (12 px) tient 4,5:1 sur %s", (_name, background) => {
    expect(contrastRatio(token("ink-soft"), background)).toBeGreaterThanOrEqual(4.5);
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
    expect(css).toMatch(/\.liquid-button \{[^}]*color: (#132238|var\(--brand-navy\))/);
    expect(css).toMatch(/\.ij-signup-button \{[^}]*color: (#132238|var\(--brand-navy\))/);
  });
});

describe("indicateur de focus", () => {
  it("le contour doré foncé tient 3:1 sur le blanc, le fond du site, la crème et le sable (WCAG 1.4.11)", () => {
    for (const background of [
      "#ffffff",
      token("background"),
      token("surface"),
      token("secondary"),
    ]) {
      expect(contrastRatio(token("gold-soft"), background), background).toBeGreaterThanOrEqual(3);
    }
  });

  it("l'or clair de l'anneau (ring-gold) ne tient pas 3:1 sur le blanc : il ne peut pas servir de focus", () => {
    expect(contrastRatio(token("gold"), "#ffffff")).toBeLessThan(3);
  });

  it("aucun composant ne marque le focus avec ring-gold (2,85:1) : outline-gold-soft à la place", () => {
    const forbidden =
      /(?<![\w-])(?:has-\[:focus-visible\]|focus|focus-visible|focus-within):ring-gold(?![-\w])/;
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          readFileSync(path, "utf8")
            .split("\n")
            .forEach((line, index) => {
              if (forbidden.test(line)) offenders.push(`${path}:${index + 1}`);
            });
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });

  it("le motif interdit attrape les formes connues et laisse ring-gold-soft", () => {
    const forbidden =
      /(?<![\w-])(?:has-\[:focus-visible\]|focus|focus-visible|focus-within):ring-gold(?![-\w])/;
    for (const bad of [
      "focus-visible:ring-gold",
      "focus-visible:ring-gold/40",
      "focus-within:ring-gold",
      "focus:ring-gold/20",
      'class="a focus-visible:ring-2 focus-visible:ring-gold"',
      "has-[:focus-visible]:ring-gold",
      "has-[:focus-visible]:ring-gold/60",
    ]) {
      expect(forbidden.test(bad), bad).toBe(true);
    }
    for (const good of [
      "focus:ring-gold-soft",
      "focus-visible:outline-gold-soft",
      "ring-gold",
      "hover:ring-gold",
    ]) {
      expect(forbidden.test(good), good).toBe(false);
    }
  });
});

/** Un `rgb(r g b / a%)` posé sur un fond opaque : la couleur rendue, en hexadécimal. */
function blend(rgba: [number, number, number, number], background: string): string {
  const channels = [1, 3, 5].map((index) => parseInt(background.slice(index, index + 2), 16));
  const [r, g, b] = rgba
    .slice(0, 3)
    .map((value, i) => Math.round(value * rgba[3] + channels[i] * (1 - rgba[3])));
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

describe("champs de formulaire (.form-input)", () => {
  const rule = (selector: string) => {
    const match = css.match(
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}[^{}]*\\{([^}]*)\\}`),
    );
    if (!match) throw new Error(`Règle ${selector} introuvable`);
    return match[1];
  };

  it("a une bordure d'au moins 3:1 sur le blanc, le fond du site et la crème (WCAG 1.4.11)", () => {
    const base = css.match(/\.form-input,\s*\.form-textarea \{([^}]*)\}/)![1];
    const border = /border: 1px solid rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)/.exec(base);
    expect(border, "bordure en rgb(r g b / a%)").not.toBeNull();
    const rgba: [number, number, number, number] = [
      Number(border![1]),
      Number(border![2]),
      Number(border![3]),
      Number(border![4]) / 100,
    ];
    for (const background of ["#ffffff", token("background"), token("surface")]) {
      expect(contrastRatio(blend(rgba, background), background), background).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("garde cette bordure au focus et ajoute un contour doré foncé de 2 px, décalé de 2 px", () => {
    const focus = rule(".form-input:focus");
    expect(focus).toMatch(/outline: 2px solid var\(--gold-soft\)/);
    expect(focus).toMatch(/outline-offset: 2px/);
    // Le contour ne repose pas sur le halo de 14 % (invisible) ni sur un changement de bordure.
    expect(focus).not.toMatch(/border-color/);
    expect(focus).not.toMatch(/0 0 0 3px/);
    expect(contrastRatio(token("gold-soft"), "#ffffff")).toBeGreaterThanOrEqual(3);
  });
});
