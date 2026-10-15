import { MARKET_GAP_METHOD_PATH } from "@/lib/market-gap";
import { EXISTING_GUIDE, RESOURCE_ARTICLES } from "@/lib/resource-articles";

/**
 * Contenu de `/llms.txt` : un résumé d'Immojudis et la liste des seules pages éditoriales.
 * Aucune fiche de vente ni aucune page produite à partir du catalogue n'y figure : ce fichier
 * décrit le site, il n'invite personne à moissonner les annonces.
 */
export type LlmsTxtPage = { title: string; path: string; description: string };

const LLMS_TXT_SUMMARY =
  "Immojudis est une plateforme française d’exploration des ventes immobilières aux enchères : ventes au tribunal, chez un notaire ou domaniales. Elle référence des annonces publiées par des tiers, explique les procédures et propose des outils d’aide à la décision. Les informations sont indicatives ; elles ne constituent ni un conseil juridique ni un conseil financier, et seuls les documents officiels de chaque vente font foi.";

const LLMS_TXT_SCOPE_NOTE =
  "Ce fichier ne liste que les pages éditoriales du site. Les annonces de vente ne sont pas décrites ici.";

/** Pages éditoriales hors articles, dans l'ordre du fichier. Chaque chemin est une page existante. */
const LLMS_TXT_MAIN_PAGES: readonly LlmsTxtPage[] = [
  {
    title: "Accueil",
    path: "/",
    description: "Présentation d’Immojudis et accès aux ventes immobilières aux enchères.",
  },
  {
    title: EXISTING_GUIDE.title,
    path: EXISTING_GUIDE.href,
    description: EXISTING_GUIDE.description,
  },
  {
    title: "Ressources",
    path: "/ressources",
    description: "Les articles d’Immojudis sur les ventes aux enchères immobilières.",
  },
];

const LLMS_TXT_METHOD_PAGES: readonly LlmsTxtPage[] = [
  {
    title: "Comment est calculé l’écart avec le marché",
    path: MARKET_GAP_METHOD_PATH,
    description:
      "Source DVF, ventes comparables, périmètre, période, repli et limites de l’écart entre la mise à prix et la valeur de marché estimée.",
  },
  {
    title: "Classement des annonces",
    path: "/classement-des-annonces",
    description:
      "Comment les annonces sont classées, ce que signifie le repère « Annonce bien renseignée », la publicité des avocats et le retrait des ventes.",
  },
];

// `/tribunaux` est listé sans condition, alors que le sitemap le retire quand aucun tribunal n'a de
// vente à venir (`src/app/sitemap.ts`). Le choix est voulu : savoir si un tribunal est listé exige
// une lecture en base (`loadPublicTribunalActivity`), et cette route doit rester légère, sans
// dépendre de la base. Conséquence connue : pendant un catalogue sans aucun tribunal,
// ce fichier peut mentionner une page qui répond 200 mais n'est pas indexée (elle porte alors
// `noindex`) ; elle n'en reste pas moins une page éditoriale valide, avec ses explications.
const LLMS_TXT_TOOL_PAGES: readonly LlmsTxtPage[] = [
  {
    title: "Tribunaux",
    path: "/tribunaux",
    description:
      "Ventes judiciaires à venir, prochaine audience et mise à prix médiane par tribunal.",
  },
  {
    title: "Simulateur de frais d’enchères",
    path: "/simulateur-frais-encheres",
    description:
      "Coût total d’un bien adjugé (émoluments, droits de mutation, frais), budget maximal d’enchère et surenchère du dixième.",
  },
  {
    title: "Offres",
    path: "/offres",
    description: "Les offres d’accès à Immojudis et ce que chacune comprend.",
  },
];

function llmsTxtArticles(): LlmsTxtPage[] {
  return RESOURCE_ARTICLES.map((article) => ({
    title: article.title,
    path: article.href,
    description: article.description,
  }));
}

/** Les pages listées, dans l'ordre du fichier (utile aux tests). */
export function llmsTxtPages(): LlmsTxtPage[] {
  return [
    ...LLMS_TXT_MAIN_PAGES,
    ...llmsTxtArticles(),
    ...LLMS_TXT_METHOD_PAGES,
    ...LLMS_TXT_TOOL_PAGES,
  ];
}

function line(origin: string, page: LlmsTxtPage): string {
  const url = page.path === "/" ? origin : `${origin}${page.path}`;
  return `- [${page.title}](${url}): ${page.description}`;
}

function section(origin: string, title: string, pages: readonly LlmsTxtPage[]): string {
  return [`## ${title}`, "", ...pages.map((page) => line(origin, page))].join("\n");
}

/** Texte de `/llms.txt` (format llmstxt.org) pour une origine absolue sans barre finale. */
export function buildLlmsTxt(origin: string): string {
  return (
    [
      "# Immojudis",
      `> ${LLMS_TXT_SUMMARY}`,
      LLMS_TXT_SCOPE_NOTE,
      section(origin, "Pages principales", LLMS_TXT_MAIN_PAGES),
      section(origin, "Articles", llmsTxtArticles()),
      section(origin, "Méthodes et transparence", LLMS_TXT_METHOD_PAGES),
      section(origin, "Outils, tribunaux et offres", LLMS_TXT_TOOL_PAGES),
    ].join("\n\n") + "\n"
  );
}
