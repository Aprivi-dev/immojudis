import { describe, expect, it } from "vitest";
import {
  EXISTING_GUIDE,
  RESOURCE_ARTICLES,
  getResourceArticle,
  resourceLastModified,
  type ResourceArticle,
} from "./resource-articles";
import { GUIDE_READING_MINUTES } from "./guide-dates";

/** Suffixe ajouté au `<title>` par `app/layout.tsx` et longueur maximale d'un titre de résultat. */
const TITLE_SUFFIX = " - Immojudis";
const MAX_TITLE_LENGTH = 60;

const NEW_SLUGS = [
  "droit-de-preemption-encheres-commune-acheteur",
  "garantie-10-pourcent-cheque-banque-caution-encheres",
  "copropriete-encheres-charges-assemblees",
] as const;

/** Tout le texte lu par un visiteur (hors adresses des sources). */
function visibleText(article: ResourceArticle): string {
  return [
    article.title,
    article.seoTitle ?? "",
    article.description,
    ...article.intro,
    ...article.takeaways,
    ...article.sections.flatMap((section) => [
      section.title,
      ...section.paragraphs,
      ...(section.bullets ?? []),
      ...(section.table?.headers ?? []),
      ...(section.table?.rows.flat() ?? []),
      section.callout?.title ?? "",
      section.callout?.text ?? "",
    ]),
    ...article.sources.map((source) => source.label),
  ].join(" ");
}

describe("registre des articles de /ressources", () => {
  it("a des slugs uniques et des identifiants de section uniques dans chaque article", () => {
    const slugs = RESOURCE_ARTICLES.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const article of RESOURCE_ARTICLES) {
      const ids = article.sections.map((section) => section.id);
      expect(new Set(ids).size, article.slug).toBe(ids.length);
      for (const id of ids) expect(id, article.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("date chaque article (AAAA-MM-JJ) et ne date jamais la mise à jour avant la publication", () => {
    for (const article of RESOURCE_ARTICLES) {
      expect(article.publishedAt, article.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (article.updatedAt) {
        expect(article.updatedAt, article.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(article.updatedAt >= article.publishedAt, article.slug).toBe(true);
      }
      expect(resourceLastModified(article)).toBe(article.updatedAt || article.publishedAt);
    }
  });

  it("renseigne des sources (adresse https ou page du site) pour chaque article", () => {
    for (const article of RESOURCE_ARTICLES) {
      expect(article.sources.length, article.slug).toBeGreaterThanOrEqual(3);
      for (const source of article.sources) {
        expect(source.label.trim(), article.slug).not.toBe("");
        expect(source.url, article.slug).toMatch(/^(https:\/\/|\/)/);
      }
      const urls = article.sources.map((source) => source.url);
      expect(new Set(urls).size, `${article.slug} : source en double`).toBe(urls.length);
    }
  });

  it("garde le titre de l'onglet sous 60 caractères avec le suffixe du site", () => {
    for (const article of RESOURCE_ARTICLES) {
      const documentTitle = article.seoTitle?.trim() || article.title;
      expect(documentTitle.length + TITLE_SUFFIX.length, article.slug).toBeLessThanOrEqual(
        MAX_TITLE_LENGTH,
      );
    }
  });

  it("annonce pour le guide le même temps de lecture que sa page", () => {
    expect(EXISTING_GUIDE.readingMinutes).toBe(GUIDE_READING_MINUTES);
  });

  it("ne cite aucun concurrent ou service tiers par son nom dans le texte lu", () => {
    for (const article of RESOURCE_ARTICLES) {
      expect(visibleText(article), article.slug).not.toMatch(
        /36\s?heures|licitor|vench|paris[- ]?auction|avoventes|immo-?interactif/i,
      );
    }
  });
});

describe("trois nouveaux articles du 19/10/2026", () => {
  it.each(NEW_SLUGS)("%s : publié le 19/10/2026, titre de 49 caractères au plus", (slug) => {
    const article = getResourceArticle(slug);
    expect(article).toBeDefined();
    expect(article!.publishedAt).toBe("2026-10-19");
    expect(article!.title.length).toBeLessThanOrEqual(49);
    expect(article!.seoTitle).toBeUndefined();
  });

  it("garde une promesse neutre : ni rendement, ni gain garanti", () => {
    for (const slug of NEW_SLUGS) {
      expect(visibleText(getResourceArticle(slug)!), slug).not.toMatch(
        /garanti[es]? de gagner|rendement garanti|sans risque|bonne affaire assurée/i,
      );
    }
  });

  it("cite le Code de l'urbanisme pour la préemption (calendrier de 30 jours et prix)", () => {
    const text = visibleText(getResourceArticle(NEW_SLUGS[0])!);
    expect(text).toContain("L. 213-1");
    expect(text).toContain("R. 213-15");
    expect(text).toContain("trente jours");
    expect(text).toContain("dernière enchère");
  });

  it("cite R. 322-41 (10 %, 3 000 €) et ne renvoie pas le défaut de paiement à R. 322-46", () => {
    const article = getResourceArticle(NEW_SLUGS[1])!;
    const text = visibleText(article);
    expect(text).toContain("R. 322-41");
    expect(text).toContain("3 000 €");
    expect(text).toContain("10 %");
    // R. 322-46 est cité seulement pour la déclaration d'identité du mandant.
    const defaultSection = article.sections.find((section) => section.id === "apres-audience")!;
    expect(defaultSection.paragraphs.join(" ")).not.toContain("R. 322-46");
  });

  it("cite la loi du 10 juillet 1965 et l'hypothèque légale, pas l'ancien privilège de l'article 2374", () => {
    const text = visibleText(getResourceArticle(NEW_SLUGS[2])!);
    expect(text).toContain("19-1");
    expect(text).toContain("art. 20");
    expect(text).toContain("art. 2402");
    expect(text).not.toContain("2374");
    expect(text).not.toMatch(/privilège immobilier spécial/i);
  });
});

describe("article sur les ventes notariales", () => {
  const article = getResourceArticle("ventes-notariales-domaniales-differences-tribunal")!;

  it("est daté de sa mise à jour du 19/10/2026", () => {
    expect(article.updatedAt).toBe("2026-10-19");
  });

  it("distingue la vente à la bougie (enchères) de la vente interactive (offres, avant-contrat)", () => {
    const bougie = article.sections.find((section) => section.id === "notaire")!;
    const interactive = article.sections.find((section) => section.id === "vente-interactive")!;
    expect(bougie.title).toMatch(/bougie/i);
    expect(bougie.paragraphs.join(" ")).toMatch(/adjudication/);
    const text = interactive.paragraphs.join(" ");
    expect(text).toContain("avant-contrat");
    expect(text).toContain(
      "les CGU de 36h immo prévoient que le vendeur peut refuser l’offre la plus élevée",
    );
    expect(text).toMatch(/pas une adjudication|n’est pas une séance d’enchères/);
    expect(interactive.table).toBeDefined();
    expect(visibleText(article)).toContain("conditions suspensives");
  });

  it("attribue à 36h immo les clauses de ses CGU et ne reprend pas sa page commerciale", () => {
    const interactive = article.sections.find((section) => section.id === "vente-interactive")!;
    const text = interactive.paragraphs.join(" ");
    expect(text).toContain("À titre d’exemple");
    expect(text).toContain("36h immo");
    expect(visibleText(article)).not.toMatch(/présentation commerciale|honoraires de négociation/);
    expect(article.sources.some((source) => /36h immo/.test(source.label))).toBe(true);
  });
});

describe("article sur l'enchère plafond", () => {
  it("précise où s'affiche l'enchère plafond, sans date ni promesse de gratuité durable", () => {
    const article = getResourceArticle("prix-plafond-encheres-immobilieres")!;
    expect(article.updatedAt).toBe("2026-10-19");
    const text = article.sections
      .find((section) => section.id === "assistant-immojudis")!
      .paragraphs.join(" ");
    expect(text).toContain("s’affiche pour les ventes au tribunal");
    expect(text).toContain("3 ventes par mois");
    expect(text).toContain("offre Analyse");
    expect(text).toContain("Pendant la période de lancement");
    expect(text).not.toMatch(
      /\d{1,2} (janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)/,
    );
    expect(text).not.toMatch(/gratuit(ement)? pour toujours|à vie/i);
  });
});

describe("relecture juridique du 19/10/2026", () => {
  it("ne décrit plus la surenchère en licitation devant notaire comme une requête au greffe (art. 1280)", () => {
    for (const article of RESOURCE_ARTICLES) {
      expect(visibleText(article), article.slug).not.toMatch(/requête au greffe|art\. 1280/);
      expect(
        article.sources.some((source) => /article 1280/.test(source.label)),
        article.slug,
      ).toBe(false);
    }
  });

  it("date de la relecture les articles dont le texte a été corrigé", () => {
    for (const slug of [
      "apres-adjudication-surenchere-paiement-titre-vente",
      "licitation-vente-bien-indivis-encheres-acheteur",
    ]) {
      expect(getResourceArticle(slug)!.updatedAt, slug).toBe("2026-10-19");
    }
  });

  it("garde les prudences de la préemption (affichage d'un mois, indivision volontaire dans le texte)", () => {
    const text = visibleText(getResourceArticle("droit-de-preemption-encheres-commune-acheteur")!);
    expect(text).toContain("R. 211-2");
    expect(text).toContain("pendant un mois");
    expect(text).not.toMatch(/pendant deux mois/);
    expect(text).toContain("créée volontairement");
  });
});
