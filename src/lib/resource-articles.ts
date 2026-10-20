import budgetArticle from "@/content/resources/prix-plafond-encheres-immobilieres.json";
import selectionArticle from "@/content/resources/analyser-opportunite-encheres.json";
import occupationArticle from "@/content/resources/acheter-bien-occupe-encheres.json";
import buildingArticle from "@/content/resources/immeuble-rapport-encheres.json";
import hearingArticle from "@/content/resources/jour-audience-encheres-role-avocat.json";
import afterAwardArticle from "@/content/resources/apres-adjudication-surenchere-paiement-titre-vente.json";
import saleTypesArticle from "@/content/resources/ventes-notariales-domaniales-differences-tribunal.json";
import saleConditionsArticle from "@/content/resources/lire-cahier-conditions-vente-preparer-visite.json";
import costsArticle from "@/content/resources/frais-vente-encheres-judiciaire.json";
import financingArticle from "@/content/resources/financer-achat-encheres-pret-delais.json";
import licitationArticle from "@/content/resources/licitation-vente-bien-indivis-encheres-acheteur.json";
import seizureArticle from "@/content/resources/saisie-immobiliere-etapes-vente-forcee-acheteur.json";
import lawyerArticle from "@/content/resources/avocat-obligatoire-encherir-tribunal-choisir-mandat-cout.json";
import preemptionArticle from "@/content/resources/droit-de-preemption-encheres-commune-acheteur.json";
import guaranteeArticle from "@/content/resources/garantie-10-pourcent-cheque-banque-caution-encheres.json";
import condominiumArticle from "@/content/resources/copropriete-encheres-charges-assemblees.json";
import { GUIDE_READING_MINUTES } from "@/lib/guide-dates";

export interface ResourceSection {
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
  table?: { headers: string[]; rows: string[][] };
  callout?: { title: string; text: string };
}

interface ResourceContent {
  slug: string;
  publishedAt: string;
  /** Last substantial change (`AAAA-MM-JJ`): `dateModified` of the article and sitemap `lastmod`. */
  updatedAt?: string;
  title: string;
  /**
   * `<title>` and share title when the headline is too long for a search result (60 characters
   * with the " - Immojudis" suffix). The `h1` and the cards keep `title`.
   */
  seoTitle?: string;
  category: string;
  description: string;
  /**
   * Meta description and share description when `description` is too long for a search result
   * (158 characters at most). The page keeps `description` under its headline.
   */
  seoDescription?: string;
  intro: string[];
  takeaways: string[];
  sections: ResourceSection[];
  sources: { label: string; url: string }[];
}

export interface ResourceSummary {
  slug: string;
  title: string;
  category: string;
  description: string;
  href: string;
  image: string;
  readingMinutes: number;
  publishedAt?: string;
}

export type ResourceArticle = ResourceContent & ResourceSummary;

function defineArticle(content: ResourceContent, image: string): ResourceArticle {
  const text = [
    content.title,
    ...content.intro,
    ...content.takeaways,
    ...content.sections.flatMap((section) => [
      section.title,
      ...section.paragraphs,
      ...(section.bullets ?? []),
      ...(section.table?.headers ?? []),
      ...(section.table?.rows.flat() ?? []),
      section.callout?.title ?? "",
      section.callout?.text ?? "",
    ]),
  ].join(" ");

  return {
    ...content,
    href: `/ressources/${content.slug}`,
    image,
    readingMinutes: Math.max(1, Math.ceil(text.trim().split(/\s+/).length / 200)),
  };
}

export const RESOURCE_ARTICLES: ResourceArticle[] = [
  defineArticle(hearingArticle, "/media/landing/auction-toulouse.webp"),
  defineArticle(afterAwardArticle, "/media/landing/gallery-townhouse.webp"),
  defineArticle(saleTypesArticle, "/media/landing/judicial-candle.webp"),
  defineArticle(saleConditionsArticle, "/media/landing/home-bordeaux-twilight.webp"),
  defineArticle(costsArticle, "/media/landing/justice-goddess.webp"),
  defineArticle(financingArticle, "/media/landing/gallery-land.webp"),
  defineArticle(budgetArticle, "/media/landing/auction-bordeaux.webp"),
  defineArticle(occupationArticle, "/media/landing/dossier-apartment.webp"),
  defineArticle(buildingArticle, "/media/landing/auction-lyon.webp"),
  defineArticle(selectionArticle, "/media/landing/auction-nantes.webp"),
  defineArticle(seizureArticle, "/media/landing/justice-goddess.webp"),
  defineArticle(licitationArticle, "/media/landing/home-favorites.webp"),
  defineArticle(lawyerArticle, "/media/landing/auction-toulouse.webp"),
  defineArticle(preemptionArticle, "/media/landing/auction-nantes.webp"),
  defineArticle(guaranteeArticle, "/media/landing/dossier-apartment.webp"),
  defineArticle(condominiumArticle, "/media/landing/auction-lyon.webp"),
];

export const EXISTING_GUIDE: ResourceSummary = {
  slug: "ventes-immobilieres-judiciaires",
  title: "Ventes immobilières judiciaires : trouvez, analysez et décidez avant d’enchérir",
  category: "Les fondamentaux",
  description:
    "De la première annonce à l’audience : les procédures, les documents à lire, les frais et les risques à comprendre pour préparer votre achat.",
  href: "/ventes-immobilieres-judiciaires",
  image: "/media/landing/judicial-candle.webp",
  // Même valeur que la mention de la page du guide (source unique : `src/lib/guide-dates.ts`).
  readingMinutes: GUIDE_READING_MINUTES,
};

export const RESOURCE_SUMMARIES: ResourceSummary[] = [
  EXISTING_GUIDE,
  ...RESOURCE_ARTICLES.map(
    ({ slug, title, category, description, href, image, readingMinutes, publishedAt }) => ({
      slug,
      title,
      category,
      description,
      href,
      image,
      readingMinutes,
      publishedAt,
    }),
  ),
];

/** Title used for `<title>` and the share cards: `seoTitle` when set, the headline otherwise. */
export function resourceDocumentTitle(
  article: Pick<ResourceArticle, "title" | "seoTitle">,
): string {
  return article.seoTitle?.trim() || article.title;
}

/** Longest `seoDescription`: what a search result shows of a meta description. */
export const RESOURCE_SEO_DESCRIPTION_MAX_LENGTH = 158;

/** Meta description and share description: `seoDescription` when set, `description` otherwise. */
export function resourceDocumentDescription(
  article: Pick<ResourceArticle, "description" | "seoDescription">,
): string {
  return article.seoDescription?.trim() || article.description;
}

/** Last modification date of an article: `updatedAt`, or the publication date. */
export function resourceLastModified(
  article: Pick<ResourceArticle, "publishedAt" | "updatedAt">,
): string {
  return article.updatedAt || article.publishedAt;
}

export function getResourceArticle(slug: string): ResourceArticle | undefined {
  return RESOURCE_ARTICLES.find((article) => article.slug === slug);
}

export function formatResourceDate(date: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(new Date(`${date}T12:00:00Z`));
}
