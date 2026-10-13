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
    expect(html).toMatch(/href="\/offres"[^>]*>\s*Fixer son enchère plafond/);
  });

  it("déclare des métadonnées dans les limites SEO, avec canonical", () => {
    expect(String(metadata.title).length + SITE_SUFFIX.length).toBeLessThanOrEqual(60);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(140);
    expect(description.length).toBeLessThanOrEqual(155);
    expect(metadata.alternates?.canonical).toBe("/simulateur-frais-encheres");
  });
});
