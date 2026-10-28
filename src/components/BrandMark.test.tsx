import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";
import { HeaderLogo } from "./site-header-shared";

describe("BrandMark", () => {
  it("reprend les tracés du temple du favicon, un seul pictogramme pour la marque", () => {
    const svg = readFileSync(
      join(process.cwd(), "public", "brand", "immojudis-justice-temple.svg"),
      "utf8",
    );
    const markup = renderToStaticMarkup(<BrandMark />);
    // Les attributs de tracé du favicon : même géométrie, mêmes couleurs.
    for (const path of svg.match(/d="[^"]+"/g) ?? []) expect(markup).toContain(path);
    // Les couleurs du fichier sont celles des jetons que le composant emploie.
    const styles = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    for (const [color, token, utility] of [
      ["#132238", "--brand-navy", "stroke-brand-navy"],
      ["#c98d45", "--gold", "stroke-gold"],
      ["#fffaf2", "--surface", "fill-surface"],
    ] as const) {
      expect(svg).toContain(color);
      expect(styles).toContain(`${token}: ${color}`);
      expect(markup).toContain(utility);
    }
    expect(markup).toContain('aria-label="Immojudis"');
  });

  it("sert à l'en-tête avec l'accroche unique, sans icône de bibliothèque", () => {
    const markup = renderToStaticMarkup(<HeaderLogo showTagline />);
    expect(markup).toContain("Les enchères immobilières, en toute clarté");
    expect(markup).toContain("stroke-gold");
    expect(markup).not.toContain("lucide");
  });

  it("annonce la même accroche dans le manifeste et le logo des données structurées", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "public", "manifest.webmanifest"), "utf8"),
    ) as { description: string; background_color: string };
    expect(manifest.description.startsWith("Les enchères immobilières, en toute clarté")).toBe(
      true,
    );
    expect(manifest.background_color).toBe("#fbf9f5");
  });
});
