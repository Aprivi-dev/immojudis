import {
  DEPARTMENT_PAGE_LISTED_SALES,
  departmentFromCode,
  isDepartmentPageIndexable,
  type DepartmentRef,
  type DepartmentSale,
} from "@/lib/department-pages";
import { courtShortName, type PublicTribunalActivity } from "@/lib/public-tribunal-activity";
import { normalizeFrenchSearchText } from "@/lib/search/french-geo-search";

/**
 * Pages « Ventes judiciaires au tribunal de X » (`/tribunaux/[slug]`), sur le modèle des pages
 * département. Module de calcul pur : adresses, seuil d'indexation, textes. Les chiffres viennent
 * de l'activité publique des tribunaux (`get_public_tribunal_activity`, le catalogue seulement) et
 * les ventes de `get_public_tribunal_sales` ; la lecture de la base est dans
 * `tribunal-pages.server.ts`.
 */
export const TRIBUNAL_PAGES_PATH = "/tribunaux";

/** Ventes détaillées sur la page d'un tribunal : comme celle d'un département. */
export const TRIBUNAL_PAGE_LISTED_SALES = DEPARTMENT_PAGE_LISTED_SALES;

/**
 * Une page de tribunal est indexable (et listée au sitemap) à partir du même nombre de ventes à
 * venir qu'une page de département ; en dessous elle reste consultable, en `noindex, follow`.
 */
export function isTribunalPageIndexable(upcomingCount: number): boolean {
  return isDepartmentPageIndexable(upcomingCount);
}

/**
 * Le lieu seul d'un tribunal, sans l'étiquette ni l'article : « TJ Bobigny » donne « Bobigny »,
 * « TJ Tribunal judiciaire du Puy-en-Velay » donne « Le Puy-en-Velay », « Tribunal de première
 * instance de Papeete » donne « Papeete ». Le nom du référentiel est parfois doublé (« TJ Tribunal
 * judiciaire du … ») : `courtShortName` retire les deux préfixes.
 */
export function tribunalPlaceName(name: string): string {
  const short = courtShortName(name);
  return (
    short
      .replace(/^tribunal de premi[èe]re instance\s+(?:de la |de l['’]|du |des |de |d['’])?/i, "")
      .trim() || short
  );
}

/** « bobigny », « le-puy-en-velay », « les-sables-d-olonne » : sans accent, en minuscules. */
export function tribunalSlugBase(name: string): string {
  return normalizeFrenchSearchText(tribunalPlaceName(name)).replaceAll(" ", "-");
}

export type TribunalPage = {
  activity: PublicTribunalActivity;
  slug: string;
  path: string;
};

function departmentSuffix(activity: PublicTribunalActivity): string {
  return normalizeFrenchSearchText(activity.department ?? "").replaceAll(" ", "-");
}

/**
 * Une adresse par tribunal, stable : elle ne vient que du nom du tribunal du référentiel. Deux
 * tribunaux qui donneraient la même adresse la complètent par le département, puis par leur code
 * (un cas qui n'existe pas dans le référentiel actuel, prévu pour qu'une adresse ne désigne jamais
 * deux tribunaux).
 */
export function tribunalPages(items: readonly PublicTribunalActivity[]): TribunalPage[] {
  const bases = items.map(
    (item) => tribunalSlugBase(item.searchName || item.name || "") || item.code,
  );
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);

  const used = new Set<string>();
  return items.map((activity, index) => {
    let slug = bases[index];
    if ((counts.get(slug) ?? 0) > 1) {
      slug = [slug, departmentSuffix(activity)].filter(Boolean).join("-");
    }
    if (used.has(slug))
      slug = `${slug}-${normalizeFrenchSearchText(activity.code).replaceAll(" ", "-")}`;
    used.add(slug);
    return { activity, slug, path: `${TRIBUNAL_PAGES_PATH}/${slug}` };
  });
}

/** La page du tribunal désigné par l'adresse, ou `null` : seule l'adresse exacte existe. */
export function tribunalPageFromSlug(
  items: readonly PublicTribunalActivity[],
  slug: string,
): TribunalPage | null {
  return tribunalPages(items).find((page) => page.slug === slug) ?? null;
}

/** Les tribunaux dont la page est indexable, par nombre de ventes décroissant. */
export function indexableTribunalPages(items: readonly PublicTribunalActivity[]): TribunalPage[] {
  return tribunalPages(items).filter((page) =>
    isTribunalPageIndexable(page.activity.upcomingCount),
  );
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** « de Bobigny », « du Puy-en-Velay », « d’Évry », « des Sables-d’Olonne ». */
function withArticle(place: string): string {
  if (/^Le\s/i.test(place)) return `du ${place.slice(3)}`;
  if (/^Les\s/i.test(place)) return `des ${place.slice(4)}`;
  if (/^La\s/i.test(place)) return `de ${place}`;
  if (/^[aeiouyàâäéèêëîïôöùûüh]/i.test(place)) return `d’${place}`;
  return `de ${place}`;
}

/**
 * « Tribunal judiciaire de Bobigny », « Tribunal judiciaire du Puy-en-Velay » à partir du nom du
 * référentiel (jamais le nom doublé « Tribunal judiciaire de Tribunal judiciaire du … »).
 */
export function tribunalLongNameFromRaw(raw: string): string {
  const name = raw.trim();
  const kind = /tribunal de premi[èe]re instance/i.test(name)
    ? "Tribunal de première instance"
    : "Tribunal judiciaire";
  return `${kind} ${withArticle(tribunalPlaceName(name))}`;
}

export function tribunalLongName(
  activity: Pick<PublicTribunalActivity, "name" | "searchName">,
): string {
  return tribunalLongNameFromRaw(activity.searchName || activity.name);
}

/** « au tribunal judiciaire de Bobigny » : le tribunal nommé dans une phrase. */
export function atTribunalPhrase(
  activity: Pick<PublicTribunalActivity, "name" | "searchName">,
): string {
  return `au ${lowerFirst(tribunalLongName(activity))}`;
}

/** Titre de l'onglet (le gabarit du site ajoute « - Immojudis ») : 48 caractères visés. */
export function tribunalPageTitle(
  activity: Pick<PublicTribunalActivity, "name" | "searchName">,
): string {
  return `Enchères judiciaires : ${tribunalPlaceName(activity.searchName || activity.name)}`;
}

const DESCRIPTION_MAX_LENGTH = 158;

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
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
 * Description d'une page de tribunal, calculée sur les chiffres de la page. Elle tient en 158
 * caractères : si tout n'y rentre pas, la mise à prix médiane, puis la date, sont retirées plutôt
 * que de couper la phrase. Elle ne dit que ce que la page chiffre.
 */
export function tribunalPageDescription(
  activity: Pick<
    PublicTribunalActivity,
    "name" | "searchName" | "upcomingCount" | "nextSaleDate" | "medianStartingPriceEur"
  >,
  now: Date = new Date(),
): string {
  const count = activity.upcomingCount;
  const head = `${count} ${count > 1 ? "ventes judiciaires" : "vente judiciaire"} à venir ${atTribunalPhrase(activity)}`;
  const nextTime = timestamp(activity.nextSaleDate);
  const next =
    nextTime != null && nextTime >= now.getTime() - 86_400_000
      ? longDate(activity.nextSaleDate)
      : null;
  const nextText = next ? `prochaine audience le ${next}` : null;
  const median =
    activity.medianStartingPriceEur != null
      ? `mise à prix médiane ${priceLabel(activity.medianStartingPriceEur)}`
      : null;
  for (const details of [[nextText, median], [nextText], []]) {
    const text = [head, details.filter(Boolean).join(", ")].filter(Boolean).join(" : ");
    const sentence = `${text}.`;
    if (sentence.length <= DESCRIPTION_MAX_LENGTH) return sentence;
  }
  return `${head}.`;
}

/** Le département du tribunal, quand son code est reconnu. */
export function tribunalDepartment(
  activity: Pick<PublicTribunalActivity, "department">,
): DepartmentRef | null {
  return departmentFromCode(activity.department);
}

/**
 * Prochaine audience du tribunal. La fonction d'activité publique prend la plus proche date de
 * toutes les ventes à venir, reportées comprises (une vente reportée garde son ancienne date). La
 * liste des ventes, elle, connaît le statut : quand elle est lue, la prochaine audience est la
 * première vente non reportée dont la date n'est pas passée, cherchée sur toutes les lignes reçues
 * (dans n'importe quel ordre). Sans liste, on garde la date de l'activité publique. `null` veut dire
 * « non connue » : la page l'écrit (« Non connue »), elle ne laisse pas la case vide. Cela arrive
 * quand aucune ligne reçue ne convient, par exemple quand toutes les premières lignes (la liste est
 * bornée) sont des ventes reportées : une audience plus lointaine peut exister sans qu'on la voie.
 */
export function nextAudienceDate(
  activity: Pick<PublicTribunalActivity, "nextSaleDate">,
  sales: readonly Pick<DepartmentSale, "saleDate" | "status">[] | null,
  now: Date = new Date(),
): string | null {
  if (!sales) return activity.nextSaleDate;
  const upcoming = sales
    .filter((sale) => sale.status !== "postponed")
    .map((sale) => ({ date: sale.saleDate, time: timestamp(sale.saleDate) }))
    .filter(
      (sale): sale is { date: string; time: number } =>
        sale.date != null && sale.time != null && sale.time > now.getTime(),
    )
    .sort((a, b) => a.time - b.time);
  return upcoming[0]?.date ?? null;
}
