// @vitest-environment jsdom
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatScaleDate } from "@/components/fees-simulator/scale-date";
import { EMOLUMENT_SCALE_DATE } from "@/lib/profitability";
import Page, { metadata } from "./page";

const SITE_SUFFIX = " - Immojudis";

describe("page /simulateur-frais-encheres", () => {
  it("rend côté serveur un seul h1 et la mention de barème datée", () => {
    const html = renderToString(<Page />);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Combien coûte vraiment un bien adjugé ?");
    expect(html).toContain(`Barème au ${formatScaleDate(EMOLUMENT_SCALE_DATE)}`);
    expect(html).toContain("Estimation indicative");
    expect(html).toContain("cahier des conditions de vente");
  });

  it("propose le simulateur et les deux appels à l'action", () => {
    const html = renderToString(<Page />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/href="\/sales"[^>]*>\s*Trouver une vente/);
    // « Fixer son enchère plafond » ne mène plus à la page des offres : il essaie l'exemple.
    expect(html).not.toMatch(/href="\/offres"[^>]*>\s*Fixer son enchère plafond/);
    expect(html).toMatch(
      /href="\/annonce-exemple"[^>]*>\s*Essayer l’enchère plafond sur un exemple/,
    );
    expect(html).toMatch(/href="\/offres"[^>]*>\s*Voir les offres/);
  });

  it("dit ce que le compte gratuit et Analyse ouvrent, sans réserver l'enchère plafond à Analyse", () => {
    const html = renderToString(<Page />).replaceAll("<!-- -->", "");
    expect(html).toContain("sur 3 ventes au tribunal par mois avec le compte gratuit");
    expect(html).toContain("toutes les ventes au tribunal avec l’offre Analyse");
    expect(html).not.toContain("se fixe avec l’offre Analyse");
  });

  it("propose les trois calculs, le calcul direct étant celui du rendu serveur", () => {
    const html = renderToString(<Page />);
    expect(html).toContain("Que voulez-vous calculer ?");
    expect(html).toContain("Budget vers prix maximal");
    expect(html).toContain("Surenchère du dixième");
    expect(html).toMatch(/<input(?=[^>]*value="cost")(?=[^>]*checked)[^>]*>/);
    expect(html).not.toMatch(/<input(?=[^>]*value="budget")(?=[^>]*checked)[^>]*>/);
    expect(html).toContain("Détail du coût");
  });

  it("déclare des métadonnées dans les limites SEO, avec canonical", () => {
    expect(String(metadata.title).length + SITE_SUFFIX.length).toBeLessThanOrEqual(60);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(140);
    expect(description.length).toBeLessThanOrEqual(155);
    expect(metadata.alternates?.canonical).toBe("/simulateur-frais-encheres");
  });
});
