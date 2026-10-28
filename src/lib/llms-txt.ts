import { COMPANY_DESCRIPTION } from "@/lib/company-description";
import { MARKET_GAP_METHOD_PATH } from "@/lib/market-gap";
import { EXISTING_GUIDE, RESOURCE_ARTICLES } from "@/lib/resource-articles";

/**
 * Contenu de `/llms.txt` : un résumé d'Immojudis et la liste des seules pages éditoriales.
 * Aucune fiche de vente ni aucune page produite à partir du catalogue n'y figure : ce fichier
 * décrit le site, il n'invite personne à moissonner les annonces.
 *
 * Règle de regroupement (le fichier grossit avec chaque article ; 22 articles font environ 70 % du
 * texte, et la limite de 10 000 caractères est un choix interne, pas celle d'un lecteur) :
 *  1. Les pages principales, les méthodes et les outils gardent leur description, plafonnée à
 *     `LLMS_TXT_DESCRIPTION_MAX` caractères (un test le vérifie).
 *  2. Les articles sont groupés sous `## Articles`. Au-delà de `LLMS_TXT_REGROUP_ABOVE_CHARS`
 *     caractères au total, ou de `LLMS_TXT_REGROUP_ABOVE_ARTICLES` articles, seuls les articles
 *     pivots (`LLMS_TXT_PIVOT_ARTICLES`) gardent leur description ; les autres passent en titre seul
 *     sous `## Optional`, la section que llmstxt.org réserve aux liens qu'un lecteur peut ignorer.
 *  3. Les tests mesurent le fichier en caractères (moins de 10 000) et en octets (moins de
 *     12 000 : chaque accent pèse 2 octets, chaque apostrophe typographique 3).
 * Un nouvel article n'a donc pas à faire relever la limite : il rejoint `## Optional`.
 */
export type LlmsTxtPage = { title: string; path: string; description: string };

// La description est celle du site entier (`company-description.ts`) ; la suite précise la portée.
const LLMS_TXT_SUMMARY = `${COMPANY_DESCRIPTION} Les ventes sont celles du tribunal, d’un notaire ou domaniales ; les annonces sont publiées par des tiers. Les informations sont indicatives ; elles ne constituent ni un conseil juridique ni un conseil financier, et seuls les documents officiels de chaque vente font foi.`;

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
    title: "Comment ça marche",
    path: "/comment-ca-marche",
    description:
      "Les étapes pour préparer une vente aux enchères : repérer une vente, comprendre le bien, fixer son enchère plafond, se faire accompagner.",
  },
  {
    title: "À propos",
    path: "/a-propos",
    description:
      "Ce qu’est Immojudis, d’où viennent les données, l’indépendance vis-à-vis des tribunaux et ce que le site ne fait pas.",
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
    title: "Comment repérons-nous les pépites ?",
    path: "/methode-pepites",
    description:
      "Le repère « Pépite » : calcul automatique sur critères publics, seuils, prix probable, limites et indépendance.",
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

/** Longueur maximale de la description d'une page listée (pages principales, méthodes, outils). */
export const LLMS_TXT_DESCRIPTION_MAX = 160;
/** Au-delà de cette longueur du fichier complet, les articles non pivots passent en titre seul. */
export const LLMS_TXT_REGROUP_ABOVE_CHARS = 9_500;
/** Au-delà de ce nombre d'articles, de même. */
const LLMS_TXT_REGROUP_ABOVE_ARTICLES = 25;

/** Les articles pivots, qui gardent leur description : audience, après-adjudication, frais, enchère plafond, cahier des conditions de vente, financement, avocat, types de vente. */
export const LLMS_TXT_PIVOT_ARTICLES: readonly string[] = [
  "/ressources/jour-audience-encheres-role-avocat",
  "/ressources/apres-adjudication-surenchere-paiement-titre-vente",
  "/ressources/frais-vente-encheres-judiciaire",
  "/ressources/prix-plafond-encheres-immobilieres",
  "/ressources/lire-cahier-conditions-vente-preparer-visite",
  "/ressources/financer-achat-encheres-pret-delais",
  "/ressources/avocat-obligatoire-encherir-tribunal-choisir-mandat-cout",
  "/ressources/ventes-notariales-domaniales-differences-tribunal",
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

function assemble(origin: string, articleSections: string[]): string {
  return (
    [
      "# Immojudis",
      `> ${LLMS_TXT_SUMMARY}`,
      LLMS_TXT_SCOPE_NOTE,
      section(origin, "Pages principales", LLMS_TXT_MAIN_PAGES),
      articleSections[0],
      section(origin, "Méthodes et transparence", LLMS_TXT_METHOD_PAGES),
      section(origin, "Outils, tribunaux et offres", LLMS_TXT_TOOL_PAGES),
      ...articleSections.slice(1),
    ].join("\n\n") + "\n"
  );
}

/**
 * Texte de `/llms.txt` (format llmstxt.org) pour une origine absolue sans barre finale. `articles` :
 * les articles listés (tous ceux du site ; un test y met plus d'articles que le site n'en a).
 */
export function buildLlmsTxt(origin: string, articles: readonly LlmsTxtPage[] = llmsTxtArticles()) {
  const full = assemble(origin, [section(origin, "Articles", articles)]);
  if (
    full.length <= LLMS_TXT_REGROUP_ABOVE_CHARS &&
    articles.length <= LLMS_TXT_REGROUP_ABOVE_ARTICLES
  ) {
    return full;
  }
  const pivots = articles.filter((article) => LLMS_TXT_PIVOT_ARTICLES.includes(article.path));
  const others = articles.filter((article) => !LLMS_TXT_PIVOT_ARTICLES.includes(article.path));
  const titleOnly = [
    "## Optional",
    "",
    ...others.map((page) => `- [${page.title}](${origin}${page.path})`),
  ].join("\n");
  return assemble(origin, [section(origin, "Articles", pivots), titleOnly]);
}
