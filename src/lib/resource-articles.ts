import budgetArticle from "@/content/resources/prix-plafond-encheres-immobilieres.json";
import selectionArticle from "@/content/resources/analyser-opportunite-encheres.json";
import occupationArticle from "@/content/resources/acheter-bien-occupe-encheres.json";
import buildingArticle from "@/content/resources/immeuble-rapport-encheres.json";

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
  title: string;
  category: string;
  description: string;
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
  defineArticle(budgetArticle, "/media/landing/auction-bordeaux.webp"),
  defineArticle(occupationArticle, "/media/landing/dossier-apartment.webp"),
  defineArticle(buildingArticle, "/media/landing/auction-lyon.webp"),
  defineArticle(selectionArticle, "/media/landing/auction-nantes.webp"),
];

export const EXISTING_GUIDE: ResourceSummary = {
  slug: "ventes-immobilieres-judiciaires",
  title: "Ventes immobilières judiciaires : trouvez, analysez et décidez avant d’enchérir",
  category: "Les fondamentaux",
  description:
    "De la première annonce à l’audience : les procédures, les documents à lire, les frais et les risques à comprendre pour préparer votre achat.",
  href: "/ventes-immobilieres-judiciaires",
  image: "/media/landing/judicial-candle.webp",
  readingMinutes: 18,
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
