import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("@/hooks/use-launch-offer", () => ({
  useLaunchOffer: () => ({ active: false, pending: false }),
}));

import { HomeHero, catalogueSummaryLine } from "./HomeHero";
import {
  HomeBenefits,
  HomeClosing,
  HomeFaq,
  HomeGuides,
  HomeStats,
  homeFaqItems,
} from "./HomeSections";

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
    expect(text).toMatch(/Enchère à ne pas dépasser 136.000.€/);
    expect(text).toMatch(/Même immeuble, 2024 226.000.€/);
    expect(text).toContain("Occupation À confirmer");
    // Premier rendu : la situation de /annonce-exemple, et son verdict.
    expect(text).toContain("Pour y habiter, occupé, rafraîchissement");
    expect(text).toMatch(/136.000.€/);
    expect(text).toContain("On enchérit");
    expect(markup).toContain("dossier-apartment.webp");
    // Les trois situations, dont celle qui fait passer son tour.
    for (const label of ["Y habiter", "Revendre, loué", "Louer après rénovation"]) {
      expect(markup).toMatch(new RegExp(`<button[^>]*>${label}</button>`));
    }
  });
});

describe("home texts", () => {
  it("annonce le plafond pour le tribunal et le notaire, sans promettre l'État", () => {
    const text = visibleText(renderToStaticMarkup(<HomeHero />));
    expect(text).toContain(
      "Pour les ventes au tribunal et chez le notaire : les points clés des pièces, selon la vente, et un plafond estimé à ne pas dépasser.",
    );
    expect(text).toContain("réunies sur une carte");
    // Régimes notariaux fermés : le tribunal seul.
    const tribunalOnly = visibleText(
      renderToStaticMarkup(<HomeHero openFeeRegimes={["tribunal"]} />),
    );
    expect(tribunalOnly).toContain("Pour les ventes au tribunal : les points clés des pièces");
    expect(tribunalOnly).not.toContain("chez le notaire");
  });

  it("compte les points confirmés de l'analyse, sans afficher un « 6 sur 6 » faux", () => {
    const text = visibleText(renderToStaticMarkup(<HomeHero />));
    expect(text).toContain("5 sur 6 confirmés");
    expect(text).not.toContain("6 sur 6");
  });

  it("mène à l'analyse complète depuis la carte du premier écran", () => {
    const markup = renderToStaticMarkup(<HomeHero />);
    expect(markup).toMatch(/<a[^>]*href="\/annonce-exemple"[^>]*>Voir l’analyse complète/);
  });

  it("prépare l'annonce de la valeur finale, sans la lire pendant la démonstration, et masque le montant animé", () => {
    const markup = renderToStaticMarkup(<HomeHero />);
    expect(markup).toMatch(/<p class="sr-only">Enchère à ne pas dépasser : 136.000.€/);
    expect(markup).not.toContain('role="status"');
    expect(markup).toMatch(/<p[^>]*aria-hidden="true"[^>]*>136.000.€<\/p>/);
    expect(markup).not.toContain("aria-live");
  });

  it("propose le bouton de pause de l'animation", () => {
    const markup = renderToStaticMarkup(<HomeHero />);
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Mettre en pause l’animation/);
  });

  it("renvoie vers les pages piliers et vers le repère Pépite, sans chiffre", () => {
    const markup = renderToStaticMarkup(<HomeGuides />);
    for (const href of [
      "/ventes-immobilieres-judiciaires",
      "/simulateur-frais-encheres",
      "/tribunaux",
      "/ventes-encheres-immobilieres",
      "/ressources",
      "/methode-ecart-marche",
      "/methode-pepites",
      "/sales?pepite=true",
    ]) {
      expect(markup).toContain(`href="${href}"`);
    }
    const text = visibleText(markup);
    expect(text).toContain("Voir les pépites");
    expect(text).not.toMatch(/\d/);
  });

  it("nomme le tribunal et le notaire dans la FAQ du plafond, et définit la mise à prix", () => {
    const find = (items: ReturnType<typeof homeFaqItems>, start: string) =>
      items.find((item) => item.question.startsWith(start));
    const all = find(homeFaqItems(), "Comment est calculée");
    expect(all?.question).toBe("Comment est calculée l’enchère plafond ou l’offre plafond ?");
    expect(all?.answer).toContain(
      "Elle est proposée pour les ventes au tribunal et les ventes notariales ; pour une vente notariale par offres, on parle d’offre plafond.",
    );
    const bougieOnly = find(
      homeFaqItems({ openFeeRegimes: ["tribunal", "notary_auction"] }),
      "Comment est calculée",
    );
    expect(bougieOnly?.answer).toContain("tribunal et les ventes notariales.");
    const tribunal = find(homeFaqItems({ openFeeRegimes: ["tribunal"] }), "Comment est calculée");
    expect(tribunal?.question).toBe("Comment est calculée l’enchère plafond ?");
    expect(tribunal?.answer).toContain("Elle est proposée pour les ventes au tribunal.");
    expect(tribunal?.answer).not.toContain("notarial");
    expect(find(homeFaqItems(), "Qu’est-ce que la mise à prix")?.answer).toContain(
      "Ce n’est pas le prix final",
    );
  });

  it("suit les nouvelles ventes sans promesse d’exhaustivité", () => {
    const text = visibleText(renderToStaticMarkup(<HomeBenefits />));
    expect(text).toContain("Suivez les nouvelles ventes de votre secteur");
    expect(text).not.toContain("Ne ratez plus");
    expect(text).toContain("(illustration)");
  });

  it("promet 7 jours d'accès à l'offre Analyse, sans « complet »", async () => {
    const { HOME_TRIAL_NOTE } = await import("./HomePrimaryAction");
    expect(HOME_TRIAL_NOTE).toBe("7 jours d’accès à l’offre Analyse, sans carte bancaire.");
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
    expect(markup).toMatch(/<dt>déblocages par mois<\/dt><dd[^>]*>3<\/dd>/);
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
    // Aucun prix d'offre : les montants de la garantie (3 000 €) et des frais sont des règles de vente.
    expect(all).not.toMatch(/\b59\b|\b249\b|TTC|€ ?\/ ?mois/);
  });

  it("répond à quatre questions de débutant : garantie, frais, prêt, surenchère, chacune avec son guide", () => {
    const items = homeFaqItems();
    const expected = [
      ["Faut-il verser une garantie", "10 % de la mise à prix", "3 000 €", "garantie-10-pourcent"],
      ["Les frais s’ajoutent-ils", "en plus du prix", "droits de mutation", "frais-vente-encheres"],
      ["Y a-t-il une condition suspensive de prêt", "refus de prêt", "deux mois", "financer-achat"],
      ["Qu’est-ce que la surenchère du dixième", "dix jours", "un dixième", "apres-adjudication"],
    ] as const;
    for (const [question, ...fragments] of expected) {
      const item = items.find((entry) => entry.question.startsWith(question));
      expect(item, question).toBeDefined();
      const guide = fragments.pop()!;
      for (const fragment of fragments) expect(item!.answer, question).toContain(fragment);
      expect(item!.guide?.href, question).toContain(`/ressources/`);
      expect(item!.guide?.href, question).toContain(guide);
      // Réponse de 2 à 3 phrases (« art. R. » ne termine pas une phrase).
      const sentences = item!.answer.replace(/\bart\.\s/g, "art ").replace(/\b[A-Z]\.\s/g, "X ");
      expect(
        sentences.split(/(?<=[.!?])\s+(?=[A-ZÀÂÉÈÊÎÔÛÇ])/).length,
        question,
      ).toBeGreaterThanOrEqual(2);
      expect(
        sentences.split(/(?<=[.!?])\s+(?=[A-ZÀÂÉÈÊÎÔÛÇ])/).length,
        question,
      ).toBeLessThanOrEqual(3);
    }
  });

  it("affiche le lien vers le guide sous la réponse, hors balisage de réponse", () => {
    const markup = renderToStaticMarkup(<HomeFaq />);
    expect(markup).toContain(
      'href="/ressources/garantie-10-pourcent-cheque-banque-caution-encheres"',
    );
    expect(markup).toContain("Lire le guide des frais");
  });
});
