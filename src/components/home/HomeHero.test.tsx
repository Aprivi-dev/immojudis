import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/hooks/use-launch-offer", () => ({
  useLaunchOffer: () => ({ active: false, pending: false }),
}));

import { HomeHero, catalogueSummaryLine } from "./HomeHero";
import { HomeClosing, HomeStats, homeFaqItems } from "./HomeSections";

// Text outside the tags, read character by character (no tag-stripping regex).
function visibleText(markup: string): string {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += /\s/.test(char) ? " " : char;
  }
  return text.replace(/\s+/g, " ").replace(/&nbsp;| /g, " ");
}

describe("home hero", () => {
  it("keeps the brand line, the sign-up action and the real figures with a link to /sales", () => {
    const markup = renderToStaticMarkup(
      <HomeHero
        summary={{ count: 1753, verifiedAt: "2026-10-15T07:30:00.000Z" }}
        departments={88}
      />,
    );
    const text = visibleText(markup);

    expect(text).toContain("Les enchères immobilières, en toute clarté.");
    expect(text).toMatch(
      /1.753 ventes à venir · 88 départements · données vérifiées le 15\/10\/2026/,
    );
    expect(text).not.toContain("mises à jour le");
    expect(markup).toMatch(/<a[^>]*href="\/sales"[^>]*>.*1.753/);
    // Rendu serveur : celui du visiteur, l'essai pas encore lu (ligne du compte gratuit).
    expect(markup).toMatch(/<a[^>]*href="\/login\?mode=investor"[^>]*>Créer mon compte gratuit/);
    expect(text).toContain("Gratuit, sans carte bancaire");
    // À côté du bouton, le catalogue sans compte.
    expect(markup).toMatch(/<a[^>]*href="\/sales"[^>]*>Explorer les ventes sans compte/);
    // Pas d'italique : l'accent du titre est une couleur.
    expect(markup).not.toContain("<em");
  });

  it("says nothing about the catalogue without figures, but keeps the sign-up action", () => {
    for (const markup of [
      renderToStaticMarkup(<HomeHero />),
      renderToStaticMarkup(<HomeHero summary={null} />),
    ]) {
      expect(markup).not.toContain("ventes à venir");
      expect(markup).not.toContain("vérifiées");
      expect(markup).toContain("Créer mon compte gratuit");
    }
  });

  it("keeps the total alone, singular for one sale, when the date is unknown", () => {
    expect(catalogueSummaryLine({ count: 1, verifiedAt: null })).toBe("1 vente à venir");
    expect(catalogueSummaryLine({ count: 12, verifiedAt: "pas une date" })).toBe(
      "12 ventes à venir",
    );
  });

  it("shows the example photo, its analysis and a verdict from the bid ceiling engine", () => {
    const markup = renderToStaticMarkup(<HomeHero />);
    const text = visibleText(markup);
    expect(text).toContain("Exemple fictif");
    expect(text).toContain("T3 de 68 m², balcon · Bordeaux");
    expect(text).toContain("Analyse du bien");
    expect(text).toMatch(/Mise à prix 95.000.€/);
    // L'estimation et sa fourchette, à côté de l'enchère à ne pas dépasser.
    expect(text).toMatch(/Estimation 230.000.€ ?Fourchette : 215.000 – 247.000.€/);
    expect(text).toMatch(/Enchère à ne pas dépasser 135.000.€/);
    expect(text).toMatch(/Même immeuble, 2024 226.000.€/);
    expect(text).toContain("Occupation À confirmer");
    // Premier rendu : la situation de /annonce-exemple, et son verdict.
    expect(text).toContain("Pour y habiter, occupé, rafraîchissement");
    expect(text).toMatch(/135.000.€/);
    expect(text).toContain("On enchérit");
    expect(markup).toContain("dossier-apartment.webp");
    // Les trois situations, dont celle qui fait passer son tour.
    for (const label of ["Y habiter", "Revendre, loué", "Louer après rénovation"]) {
      expect(markup).toMatch(new RegExp(`<button[^>]*>${label}</button>`));
    }
  });
});

describe("home figures band", () => {
  it("shows the real figures it knows, and nothing without them", () => {
    expect(renderToStaticMarkup(<HomeStats summary={null} departments={null} />)).toBe("");
    const markup = renderToStaticMarkup(
      <HomeStats summary={{ count: 1548, verifiedAt: null }} departments={94} />,
    );
    // Libellé (dt) puis valeur (dd) ; la valeur s'affiche au-dessus en CSS.
    expect(markup).toMatch(
      /<dt>ventes à venir en France<\/dt><dd[^>]*data-count-to="1548"[^>]*>1.548<\/dd>/,
    );
    expect(markup).toMatch(
      /<dt>départements où une vente est annoncée<\/dt><dd[^>]*data-count-to="94"[^>]*>94<\/dd>/,
    );
    expect(markup).toMatch(
      /<dt>lieux de vente réunis : tribunal, notaire, État<\/dt><dd[^>]*>3<\/dd>/,
    );
    expect(markup).toMatch(/<dt>fiches détaillées gratuites chaque mois<\/dt><dd[^>]*>3<\/dd>/);
  });

  it("leaves out the departments when that figure is unknown", () => {
    const markup = renderToStaticMarkup(
      <HomeStats summary={{ count: 10, verifiedAt: null }} departments={null} />,
    );
    expect(markup).not.toContain("départements");
    expect(markup).toContain("ventes à venir en France");
  });
});

describe("home closing and questions", () => {
  it("repeats the top action and the real figures only", () => {
    const withFigures = visibleText(
      renderToStaticMarkup(
        <HomeClosing summary={{ count: 1512, verifiedAt: null }} departments={88} />,
      ),
    );
    expect(withFigures).toMatch(/1.512 ventes à venir dans 88 départements, sur une seule carte/);
    expect(withFigures).toContain("Créer mon compte gratuit");
    expect(withFigures).toContain("Ou explorez les ventes sans compte");
    const without = visibleText(
      renderToStaticMarkup(<HomeClosing summary={null} departments={null} />),
    );
    expect(without).not.toContain("ventes à venir");
  });

  it("answers the trial questions without a price, and never with a hyphenated phrase", () => {
    const items = homeFaqItems();
    expect(items.length).toBeGreaterThanOrEqual(6);
    const all = items.map((item) => `${item.question} ${item.answer}`).join(" ");
    expect(all).toContain("Rien n’est prélevé");
    expect(all).not.toMatch(/€|59/);
  });
});
