import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Le visuel de tête de fiche (photo, vue 360°, image satellite) garde une hauteur propre sur
 * ordinateur : s'il reprenait celle de la colonne de droite (`height: 100%` dans une ligne étirée),
 * il se redimensionnait à chaque chargement ou repli d'un bloc, et la carte Mapbox avec lui.
 * La mise en page se vérifie en navigateur (e2e/sale-photo-block.spec.ts) ; ce test garde la règle
 * dans la feuille de style, sans navigateur.
 */
const css = readFileSync(
  join(process.cwd(), "src/components/sale-detail/SaleListing.module.css"),
  "utf8",
);

/** Déclarations d'une règle `selecteurs { ... }` dont la liste de sélecteurs contient `selector`. */
function declarations(selector: string): string[] {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules
    .filter(([, selectors]) =>
      selectors.split(",").some((candidate) => candidate.trim() === selector),
    )
    .map(([, , body]) => body.replace(/\s+/g, " ").trim());
}

describe("visuel de tête de fiche : hauteur propre", () => {
  it.each([".galleryMain", ".orbitMain", ".visualMain"])(
    "%s ne prend jamais la hauteur de la colonne de droite",
    (selector) => {
      const rules = declarations(selector);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(rule).not.toMatch(/height:\s*100%/);
    },
  );

  it("borne la hauteur du visuel entre 490 et 560 px sur ordinateur", () => {
    for (const selector of [".galleryMain", ".orbitMain", ".visualMain"]) {
      expect(declarations(selector)).toContain("height: clamp(490px, 38vw, 560px);");
    }
  });

  it("n'étire plus la galerie à la hauteur de la ligne", () => {
    expect(declarations(".heroGallery").join(" ")).not.toMatch(/height:\s*100%|display:\s*flex/);
    expect(declarations(".upper").join(" ")).not.toMatch(/align-items:\s*stretch/);
    expect(declarations(".heroGallery > .photo")).toEqual([]);
  });
});
