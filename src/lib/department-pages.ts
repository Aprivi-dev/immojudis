import { FEES_SIMULATOR_DEPARTMENTS } from "@/components/fees-simulator/departments";
import { departmentCode } from "@/lib/department-code";
import { propertyTypeLabel } from "@/lib/format/property-labels";
import { normalizeFrenchSearchText } from "@/lib/search/french-geo-search";
import type { SaleVenueType } from "@/lib/types";

/**
 * Pages « Ventes aux enchères immobilières par département » : une page par département, qui
 * s'appuie sur les ventes à venir du catalogue public. Ce module ne contient que du calcul pur
 * (adresses, comptes, médiane, seuil d'indexation, données structurées) ; la lecture de la base
 * est dans `department-pages.server.ts`.
 */
export const DEPARTMENT_PAGES_PATH = "/ventes-encheres-immobilieres";

/**
 * Durée maximale (secondes) des rendus qui peuvent déclencher la lecture complète : pages de
 * département, index et sitemap. Next.js exige un littéral dans chaque fichier ; les tests
 * vérifient qu'ils valent tous cette constante.
 */
export const DEPARTMENT_PAGES_MAX_DURATION_SECONDS = 60;

/**
 * Nombre minimal de ventes à venir distinctes pour qu'une page soit indexable et listée dans le
 * sitemap. En dessous, la page reste consultable mais en `noindex` : trois ventes font une page qui
 * a quelque chose à dire (comptes, prochaine audience, médiane, répartition) ; une ou deux, une
 * page mince.
 */
export const DEPARTMENT_PAGE_MIN_SALES = 3;

/** Ventes détaillées sur la page ; au-delà, le lien vers la recherche prend le relais. */
export const DEPARTMENT_PAGE_LISTED_SALES = 30;

export type DepartmentRef = { code: string; name: string; slug: string; path: string };

/** « Côte-d'Or » devient `cote-d-or`, « La Réunion » `la-reunion`. */
export function departmentSlug(name: string): string {
  return normalizeFrenchSearchText(name).replaceAll(" ", "-");
}

export const DEPARTMENTS: readonly DepartmentRef[] = FEES_SIMULATOR_DEPARTMENTS.map(
  ({ code, name }) => {
    const slug = departmentSlug(name);
    return { code, name, slug, path: `${DEPARTMENT_PAGES_PATH}/${slug}` };
  },
);

const BY_SLUG = new Map(DEPARTMENTS.map((department) => [department.slug, department]));
const BY_CODE = new Map(DEPARTMENTS.map((department) => [department.code, department]));

/** Le département d'une adresse, ou `null` : seule l'adresse exacte (en minuscules) existe. */
export function departmentFromSlug(slug: string): DepartmentRef | null {
  return BY_SLUG.get(slug) ?? null;
}

export function departmentFromCode(code: string | null | undefined): DepartmentRef | null {
  return BY_CODE.get(departmentCode(code) ?? "") ?? null;
}

/** Lien vers la recherche des ventes du département (`/sales?department=33`). */
export function departmentSearchPath(department: Pick<DepartmentRef, "code">): string {
  return `/sales?department=${encodeURIComponent(department.code)}`;
}

/**
 * Statut d'une vente à venir. La fonction publique de recherche ne renvoie pas la colonne
 * `status` : le lecteur (`department-pages.server.ts`) repère les ventes reportées avec un second
 * appel filtré sur ce statut. Toute autre vente à venir (« upcoming » ou statut inconnu) est
 * `scheduled`.
 */
export type DepartmentSaleStatus = "scheduled" | "postponed";

/** Une vente à venir du catalogue public, réduite à ce que la page affiche. */
export type DepartmentSale = {
  id: string;
  city: string | null;
  propertyType: string | null;
  saleDate: string | null;
  startingPriceEur: number | null;
  surfaceM2: number | null;
  /** Type de vente (tribunal, notaire, État…) : il décide des mots et des prix affichés. */
  venueType: SaleVenueType | null;
  status: DepartmentSaleStatus;
};

export type DepartmentSaleInput = DepartmentSale & { department: string | null };

type DepartmentTypeCount = { label: string; count: number };

export type DepartmentStats = {
  code: string;
  /** Ventes à venir distinctes (un identifiant compte une fois). */
  upcomingCount: number;
  /**
   * Prochaine date de vente à venir : une date future, hors vente reportée (sa date n'est plus
   * valable). `null` sans date de ce genre.
   */
  nextSaleDate: string | null;
  /** Type de la vente qui porte `nextSaleDate` : il décide du mot (audience, échéance…). */
  nextSaleVenueType: SaleVenueType | null;
  /**
   * Médiane des mises à prix des seules ventes au tribunal. Une « mise à prix » est le prix de
   * départ d'une vente judiciaire ; chez un notaire le prix publié n'a pas le même statut et, pour
   * l'État, ce peut être un prix de cession : les mélanger donnerait un chiffre qui ne désigne
   * rien. `null` sans vente au tribunal chiffrée.
   */
  medianStartingPriceEur: number | null;
  /** Nombre de ventes au tribunal chiffrées sur lesquelles repose la médiane. */
  medianSampleSize: number;
  /** Répartition par type de bien, la plus nombreuse d'abord. */
  types: DepartmentTypeCount[];
  /** Les prochaines ventes, par date d'audience croissante. */
  sales: DepartmentSale[];
};

export type DepartmentCatalogue = {
  /** Date de lecture (ISO), pour dire « mis à jour le … ». */
  generatedAt: string;
  departments: Record<string, DepartmentStats>;
};

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function isTribunalSale(sale: Pick<DepartmentSale, "venueType">): boolean {
  return sale.venueType === "tribunal";
}

/** « Prochaine audience » seulement pour une vente au tribunal ; le mot suit `sale-key-facts.ts`. */
export function departmentNextDateLabel(venueType: SaleVenueType | null): string {
  if (venueType === "tribunal") return "Prochaine audience";
  if (venueType === "state") return "Prochaine échéance";
  return "Prochaine date de vente";
}

/** Libellé du prix d'une vente : « Mise à prix » seulement au tribunal, « Prix publié » sinon. */
export function departmentPriceLabel(sale: Pick<DepartmentSale, "venueType">): string {
  return isTribunalSale(sale) ? "Mise à prix" : "Prix publié";
}

/** Le mot de la date d'une vente, comme `sale-key-facts.ts` (audience, séance, échéance). */
function saleDateWord(venueType: SaleVenueType | null): string {
  if (venueType === "tribunal") return "audience";
  if (venueType === "notary") return "séance";
  if (venueType === "state") return "échéance";
  return "vente";
}

/**
 * Date d'une vente pour une ligne de liste, ou `null` sans date. « audience le … » seulement au
 * tribunal ; une vente reportée n'a plus de date valable, une date passée n'est pas annoncée
 * comme à venir (mêmes mots que `listingSaleStatus`).
 */
export function departmentSaleDateText(
  sale: Pick<DepartmentSale, "venueType" | "status" | "saleDate">,
  formatted: { date: string | null; time: string | null },
  now: Date = new Date(),
): string | null {
  if (sale.status === "postponed") return "Vente reportée · nouvelle date à confirmer";
  if (!formatted.date) return null;
  const time = timestamp(sale.saleDate);
  if (time != null && time < now.getTime()) return "Date de vente passée";
  return `${saleDateWord(sale.venueType)} le ${formatted.date}${formatted.time ? ` à ${formatted.time}` : ""}`;
}

function positivePrice(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/**
 * Regroupe les ventes publiques par département. Un identifiant de vente est compté une seule
 * fois (la pagination de la recherche ne peut donc pas gonfler un compte) ; une vente dont le
 * département n'est pas reconnu n'est dans aucune page, comme elle n'est dans aucun filtre
 * `?department=` de la recherche.
 */
export function aggregateDepartments(
  rows: readonly DepartmentSaleInput[],
  now: Date = new Date(),
): DepartmentCatalogue {
  const seen = new Set<string>();
  const byDepartment = new Map<string, DepartmentSale[]>();
  for (const { department, ...sale } of rows) {
    if (seen.has(sale.id)) continue;
    seen.add(sale.id);
    const code = departmentFromCode(department)?.code;
    if (!code) continue;
    byDepartment.set(code, [...(byDepartment.get(code) ?? []), sale]);
  }

  const departments: Record<string, DepartmentStats> = {};
  for (const [code, sales] of byDepartment) {
    const sorted = [...sales].sort((a, b) => {
      const left = timestamp(a.saleDate);
      const right = timestamp(b.saleDate);
      if (left == null && right == null) return a.id.localeCompare(b.id);
      if (left == null) return 1;
      if (right == null) return -1;
      return left - right || a.id.localeCompare(b.id);
    });
    const typeCounts = new Map<string, number>();
    for (const sale of sorted) {
      const label = propertyTypeLabel(sale.propertyType);
      typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1);
    }
    const nextSale = sorted.find((sale) => {
      const time = timestamp(sale.saleDate);
      return sale.status !== "postponed" && time != null && time > now.getTime();
    });
    const tribunalPrices = sorted
      .filter(isTribunalSale)
      .map((sale) => sale.startingPriceEur)
      .filter(positivePrice);
    departments[code] = {
      code,
      upcomingCount: sorted.length,
      nextSaleDate: nextSale?.saleDate ?? null,
      nextSaleVenueType: nextSale?.venueType ?? null,
      medianStartingPriceEur: medianOf(tribunalPrices),
      medianSampleSize: tribunalPrices.length,
      types: [...typeCounts]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "fr")),
      sales: sorted.slice(0, DEPARTMENT_PAGE_LISTED_SALES),
    };
  }
  return { generatedAt: now.toISOString(), departments };
}

/** Nombre de ventes à venir d'un département dans le catalogue (0 s'il n'en a aucune). */
export function departmentSaleCount(catalogue: DepartmentCatalogue, code: string): number {
  return catalogue.departments[code]?.upcomingCount ?? 0;
}

/** Vrai quand la page du département peut être indexée et figurer au sitemap. */
export function isDepartmentPageIndexable(upcomingCount: number): boolean {
  return upcomingCount >= DEPARTMENT_PAGE_MIN_SALES;
}

/** Les départements dont la page est indexable, dans l'ordre des codes. */
export function indexableDepartments(catalogue: DepartmentCatalogue): DepartmentRef[] {
  return DEPARTMENTS.filter((department) =>
    isDepartmentPageIndexable(departmentSaleCount(catalogue, department.code)),
  );
}

/**
 * `ItemList` schema.org des ventes listées sur une page de département. Absolue, dans l'ordre
 * de la page ; `null` sans vente.
 */
export function departmentItemListStructuredData(
  origin: string,
  sales: readonly Pick<DepartmentSale, "id">[],
): Record<string, unknown> | null {
  if (!sales.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    numberOfItems: sales.length,
    itemListElement: sales.map((sale, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: `${origin}/sales/${sale.id.toLowerCase()}`,
    })),
  };
}

const DESCRIPTION_MAX_LENGTH = 158;

/** Titre de l'index des départements (le gabarit du site ajoute « - Immojudis »). */
export const DEPARTMENT_INDEX_TITLE = "Ventes aux enchères immobilières par département";

/** Titre d'une page de département : 48 caractères au plus, comme les autres titres du site. */
export function departmentPageTitle(department: Pick<DepartmentRef, "name">): string {
  return `Enchères immobilières : ${department.name}`;
}

function longDate(value: string | null): string | null {
  const time = timestamp(value);
  if (time == null) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
  }).format(new Date(time));
}

function priceLabel(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} €`;
}

/**
 * Description d'une page de département, calculée sur les chiffres de la page. Elle tient en 158
 * caractères : si tout n'y rentre pas, la mention des types de vente, puis la médiane, puis la date
 * sont retirées plutôt que de couper la phrase.
 */
export function departmentPageDescription(
  department: Pick<DepartmentRef, "code" | "name">,
  stats: Pick<
    DepartmentStats,
    "upcomingCount" | "nextSaleDate" | "nextSaleVenueType" | "medianStartingPriceEur"
  > | null,
): string {
  const place = `${department.name}, ${department.code}`;
  const count = stats?.upcomingCount ?? 0;
  if (!stats || count === 0) {
    return `Aucune vente aux enchères immobilière à venir référencée pour le moment (${place}). Consultez les ventes des autres départements.`;
  }
  const head = `${count} ${count > 1 ? "ventes aux enchères immobilières" : "vente aux enchères immobilière"} à venir (${place})`;
  const next = longDate(stats.nextSaleDate);
  const nextWord =
    stats.nextSaleVenueType === "tribunal"
      ? "prochaine audience"
      : stats.nextSaleVenueType === "state"
        ? "prochaine échéance"
        : "prochaine vente";
  const nextText = next ? `${nextWord} le ${next}` : null;
  const median =
    stats.medianStartingPriceEur != null
      ? `mise à prix médiane au tribunal ${priceLabel(stats.medianStartingPriceEur)}`
      : null;
  // Les chiffres passent avant la mention générique des types de vente.
  for (const details of [[nextText, median], [nextText], []]) {
    const text = [head, details.filter(Boolean).join(", ")].filter(Boolean).join(" : ");
    for (const tail of [" Tribunal, notaire ou État.", ""]) {
      const sentence = `${text}.${tail}`;
      if (sentence.length <= DESCRIPTION_MAX_LENGTH) return sentence;
    }
  }
  return `${head}.`;
}
