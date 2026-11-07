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

/**
 * Le département d'une adresse écrite avec son numéro (`/ventes-encheres-immobilieres/13`, `2a`,
 * `971`), ou `null`. Une telle adresse n'est jamais servie : elle se redirige définitivement vers
 * l'adresse par nom. Seul un numéro est reconnu, pas un nom approchant.
 */
export function departmentFromNumberSlug(slug: string): DepartmentRef | null {
  return /^(?:\d{2,3}|2[ab])$/i.test(slug) ? departmentFromCode(slug) : null;
}

/** Lien vers la recherche des ventes du département (`/sales?department=33`). */
export function departmentSearchPath(department: Pick<DepartmentRef, "code">): string {
  return `/sales?department=${encodeURIComponent(department.code)}`;
}

/**
 * Statut d'une vente à venir. La fonction publique de recherche ne renvoie pas la colonne
 * `status` : le lecteur (`department-pages.server.ts`) repère les ventes reportées avec un second
 * appel filtré sur ce statut. Toute autre vente à venir est `scheduled`. La page d'un tribunal
 * (`get_public_tribunal_sales`) lit le statut : `unknown` y marque une vente dont la base ne connaît
 * pas le statut, qui n'est pas présentée comme « à venir » mais « à confirmer ».
 */
export type DepartmentSaleStatus = "scheduled" | "postponed" | "unknown";

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

/** Une commune et le nombre de ventes à venir qui s'y trouvent. */
export type DepartmentCityCount = { city: string; count: number };

/** Nombre de communes présentées dans « Communes les plus présentes ». */
const DEPARTMENT_TOP_CITIES = 5;

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
  /**
   * Les communes qui comptent le plus de ventes à venir (toutes les ventes du département, pas
   * seulement celles listées), la plus présente d'abord. Absent d'un catalogue mis en cache avant
   * l'ajout de ce champ : la page s'en passe.
   */
  cities?: DepartmentCityCount[];
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

/**
 * Les communes les plus présentes parmi des ventes : une commune se reconnaît à son nom sans tenir
 * compte de la casse ni des espaces en trop ; le nom affiché est celui de la première vente
 * rencontrée. Une vente sans commune n'est comptée nulle part. Égalité : ordre alphabétique.
 */
export function topCities(
  sales: ReadonlyArray<Pick<DepartmentSale, "city">>,
  limit: number = DEPARTMENT_TOP_CITIES,
): DepartmentCityCount[] {
  const byKey = new Map<string, DepartmentCityCount>();
  for (const { city } of sales) {
    const label = city?.trim().replace(/\s+/g, " ");
    if (!label) continue;
    const key = label.toLocaleLowerCase("fr");
    const entry = byKey.get(key);
    if (entry) entry.count += 1;
    else byKey.set(key, { city: label, count: 1 });
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, "fr"))
    .slice(0, limit);
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

/**
 * Annonces dont la ligne de liste est identique (même commune, type, surface, date, prix et type de
 * vente) : plusieurs lots d'une même vente, ou des annonces distinctes. La liste publique n'expose ni
 * numéro de lot ni adresse (fonction `search_auction_sales_preview_v3`) : la page ne dédoublonne rien et
 * dit seulement « annonce 2 sur 4 de même description », pour que la répétition ne passe pas pour une
 * erreur. Renvoie, par identifiant, le rang et le nombre d'annonces du groupe (groupes d'au moins 2).
 */
export function identicalSaleRanks(
  sales: ReadonlyArray<
    Pick<
      DepartmentSale,
      "id" | "city" | "propertyType" | "surfaceM2" | "saleDate" | "startingPriceEur" | "venueType"
    >
  >,
): Map<string, { rank: number; of: number }> {
  const groups = new Map<string, string[]>();
  for (const sale of sales) {
    const key = JSON.stringify([
      sale.city?.trim().toLowerCase() ?? null,
      sale.propertyType,
      sale.surfaceM2,
      sale.saleDate,
      sale.startingPriceEur,
      sale.venueType,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), sale.id]);
  }
  const ranks = new Map<string, { rank: number; of: number }>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.forEach((id, index) => ranks.set(id, { rank: index + 1, of: ids.length }));
  }
  return ranks;
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

/**
 * Heure d'une vente pour une ligne de liste dont la date est déjà affichée à part (pavé de date) :
 * « audience à 14 h 00 », « séance, heure à confirmer »… Mêmes mots et mêmes cas que
 * `departmentSaleDateText` : une vente reportée n'a plus de date valable, une date passée n'est pas
 * annoncée comme à venir. `null` sans date.
 */
export function departmentSaleTimeText(
  sale: Pick<DepartmentSale, "venueType" | "status" | "saleDate">,
  time: string | null,
  now: Date = new Date(),
): string | null {
  if (sale.status === "postponed") return "Vente reportée · nouvelle date à confirmer";
  const at = timestamp(sale.saleDate);
  if (at == null) return null;
  if (at < now.getTime()) return "Date de vente passée";
  const word = saleDateWord(sale.venueType);
  return time ? `${word} à ${time}` : `${word}, heure à confirmer`;
}

/**
 * Libellé de la pastille du type de vente d'une ligne de liste ; `null` quand le type n'est pas
 * établi (aucune pastille plutôt qu'une supposition).
 */
export function departmentVenueLabel(venueType: SaleVenueType | null): string | null {
  if (venueType === "tribunal") return "Au tribunal";
  if (venueType === "notary") return "Chez le notaire";
  if (venueType === "state") return "Vente de l’État";
  return null;
}

// ── Communes à arrondissements ────────────────────────────────────────────

const ARRONDISSEMENT_CITIES: Readonly<Record<string, readonly [name: string, count: number]>> = {
  paris: ["Paris", 20],
  lyon: ["Lyon", 9],
  marseille: ["Marseille", 16],
};

// « Paris 13ème », « Paris 13e Arrondissement », « PARIS 13E », « Marseille 1er Arr. », « Lyon - 3 ».
const ARRONDISSEMENT_PATTERN =
  /^(paris|lyon|marseille)(?:\s*-\s*|\s+)0?(\d{1,2})\s*(?:ième|ieme|ème|eme|er|re|e|è)?(?:\s+arr(?:ondissement|\.)?)?$/iu;

/**
 * Nom de commune tel que les pages par département l'affichent et le regroupent : les espaces sont
 * resserrés, et les arrondissements de Paris, Lyon et Marseille prennent une seule écriture
 * (« Paris 13ème » et « Paris 13e Arrondissement » deviennent « Paris 13e », « Marseille 1er
 * Arrondissement » « Marseille 1er », « MARSEILLE » « Marseille »), pour qu'un même arrondissement
 * ne soit pas compté deux fois dans « Communes les plus présentes ». Un numéro hors des
 * arrondissements de la ville est laissé tel quel. Les données en base ne changent pas.
 */
export function normalizeDepartmentCity(city: string | null | undefined): string | null {
  const label = city?.trim().replace(/\s+/g, " ");
  if (!label) return null;
  const match = ARRONDISSEMENT_PATTERN.exec(label);
  if (match) {
    const [name, count] = ARRONDISSEMENT_CITIES[match[1].toLowerCase()];
    const number = Number(match[2]);
    if (number >= 1 && number <= count) return `${name} ${number === 1 ? "1er" : `${number}e`}`;
    return label;
  }
  return ARRONDISSEMENT_CITIES[label.toLowerCase()]?.[0] ?? label;
}

// ── Dates d'une liste de ventes (heure de Paris) ─────────────────────────

const PARIS_TIME_ZONE = "Europe/Paris";

const PARIS_DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: PARIS_TIME_ZONE,
});

/** Jour calendaire à Paris, `AAAA-MM-JJ`. */
function parisDayKey(time: number): string {
  return PARIS_DAY_FORMAT.format(new Date(time));
}

/** Vrai quand la date tombe le même jour calendaire que `now`, à Paris. */
export function isParisToday(value: string | null, now: Date = new Date()): boolean {
  const time = timestamp(value);
  return time != null && parisDayKey(time) === parisDayKey(now.getTime());
}

/** Pavé de date d'une ligne de liste : « 6 » et « nov. », à Paris. `null` sans date. */
export function parisDateBlock(value: string | null): { day: string; month: string } | null {
  const time = timestamp(value);
  if (time == null) return null;
  const date = new Date(time);
  return {
    day: new Intl.DateTimeFormat("fr-FR", { day: "numeric", timeZone: PARIS_TIME_ZONE }).format(
      date,
    ),
    month: new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: PARIS_TIME_ZONE }).format(
      date,
    ),
  };
}

/** Jour de la semaine à Paris (« jeudi »). `null` sans date. */
export function parisWeekday(value: string | null): string | null {
  const time = timestamp(value);
  if (time == null) return null;
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", timeZone: PARIS_TIME_ZONE }).format(
    new Date(time),
  );
}

/** Lundi de la semaine (à Paris) d'un instant, en jour UTC à minuit. */
function parisWeekStart(time: number): Date {
  const [year, month, day] = parisDayKey(time).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const fromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - fromMonday);
  return date;
}

export type DepartmentSaleWeek = {
  /** Lundi de la semaine (`AAAA-MM-JJ`), ou `later` pour les ventes sans date valable. */
  key: string;
  label: string;
  sales: DepartmentSale[];
};

/**
 * Regroupe des ventes (déjà triées par date) par semaine du lundi au dimanche, à Paris : « Semaine
 * en cours », puis « Semaine du 9 novembre » (l'année n'est écrite que si elle diffère de celle de
 * `now`). Une vente reportée, sans date, ou d'une semaine déjà passée va dans un dernier groupe
 * « Date à confirmer ».
 */
export function groupDepartmentSalesByWeek(
  sales: readonly DepartmentSale[],
  now: Date = new Date(),
): DepartmentSaleWeek[] {
  const current = parisWeekStart(now.getTime());
  const currentKey = current.toISOString().slice(0, 10);
  const currentYear = Number(parisDayKey(now.getTime()).slice(0, 4));
  const weeks = new Map<string, DepartmentSaleWeek>();
  const later: DepartmentSale[] = [];
  for (const sale of sales) {
    const time = timestamp(sale.saleDate);
    if (sale.status === "postponed" || time == null) {
      later.push(sale);
      continue;
    }
    const start = parisWeekStart(time);
    const key = start.toISOString().slice(0, 10);
    if (key < currentKey) {
      later.push(sale);
      continue;
    }
    let week = weeks.get(key);
    if (!week) {
      const label =
        key === currentKey
          ? "Semaine en cours"
          : `Semaine du ${new Intl.DateTimeFormat("fr-FR", {
              day: "numeric",
              month: "long",
              ...(start.getUTCFullYear() !== currentYear ? { year: "numeric" } : {}),
              timeZone: "UTC",
            }).format(start)}`;
      week = { key, label, sales: [] };
      weeks.set(key, week);
    }
    week.sales.push(sale);
  }
  const ordered = [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key));
  return later.length
    ? [...ordered, { key: "later", label: "Date à confirmer", sales: later }]
    : ordered;
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
  for (const { department, ...row } of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const code = departmentFromCode(department)?.code;
    if (!code) continue;
    // Une seule écriture par arrondissement : la liste, les communes et les doublons s'y fient.
    const sale = { ...row, city: normalizeDepartmentCity(row.city) };
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
      cities: topCities(sorted),
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
