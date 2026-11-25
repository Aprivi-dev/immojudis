import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./BrandMark";
import { HeaderLogo } from "./site-header-shared";

describe("BrandMark", () => {
  it("reprend la tuile et le corps du temple du favicon, avec le fronton en points", () => {
    const svg = readFileSync(
      join(process.cwd(), "public", "brand", "immojudis-justice-temple.svg"),
      "utf8",
    );
    const markup = renderToStaticMarkup(<BrandMark />);
    // Tuile et corps du temple : mêmes tracés que le favicon. Seul le fronton diffère : plein dans
    // le favicon (les points ne se lisent plus sous 24 px), en 25 points ici.
    const paths = [...svg.matchAll(/<path( data-fronton="plein")? d="([^"]+)"/g)];
    expect(paths).toHaveLength(3);
    for (const [, roof, d] of paths) {
      if (roof) expect(markup).not.toContain(`d="${d}"`);
      else expect(markup).toContain(`d="${d}"`);
    }
    expect(markup.match(/<circle /g)).toHaveLength(25);
    // Les couleurs du fichier sont celles des jetons que le composant emploie.
    const styles = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");
    for (const [color, token, utility] of [
      ["#56251e", "--brand-navy-soft", "fill-brand-navy-soft"],
      ["#f5f1e6", "--surface", "fill-surface"],
    ] as const) {
      expect(svg).toContain(color);
      expect(styles).toContain(`${token}: ${color}`);
      expect(markup).toContain(utility);
    }
    expect(markup).toContain('aria-label="Immojudis"');
  });

  it("se masque aux lecteurs d'écran quand il est décoratif", () => {
    const markup = renderToStaticMarkup(<BrandMark decorative />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("aria-label");
    expect(markup).not.toContain('role="img"');
  });

  it("sert à l'en-tête avec l'accroche unique, sans icône de bibliothèque", () => {
    const markup = renderToStaticMarkup(<HeaderLogo showTagline />);
    expect(markup).toContain("Les enchères immobilières, en toute clarté");
    expect(markup).toContain("fill-brand-navy-soft");
    expect(markup).not.toContain("lucide");
  });

  it("annonce la même accroche dans le manifeste et le logo des données structurées", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "public", "manifest.webmanifest"), "utf8"),
    ) as { description: string; background_color: string };
    expect(manifest.description.startsWith("Les enchères immobilières, en toute clarté")).toBe(
      true,
    );
    expect(manifest.background_color).toBe("#ece6d3");
  });
});
