import {
  DEPARTMENT_PAGE_LISTED_SALES,
  departmentFromCode,
  isDepartmentPageIndexable,
  type DepartmentRef,
  type DepartmentSale,
} from "@/lib/department-pages";
import {
  courtShortName,
  isRawTribunalCode,
  type PublicTribunalActivity,
} from "@/lib/public-tribunal-activity";
import type { PublicTribunalDirectoryEntry } from "@/lib/public-tribunal-directory";
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

/**
 * Ancienne forme des adresses : « bobigny », « le-puy-en-velay », « les-sables-d-olonne », sans
 * accent, en minuscules. Elle ne sert plus qu'à rediriger les anciennes adresses (voir
 * `legacyTribunalRedirectPath`).
 */
export function tribunalSlugBase(name: string): string {
  return normalizeFrenchSearchText(tribunalPlaceName(name)).replaceAll(" ", "-");
}

export type TribunalPage = {
  activity: PublicTribunalActivity;
  slug: string;
  path: string;
};

/**
 * Adresse stable d'un tribunal : son code, ramené à des minuscules, chiffres et tirets
 * (« justice_tj_1_93 » donne « justice-tj-1-93 »). Elle ne dépend ni du nom (qui peut être
 * corrigé), ni des autres tribunaux, ni de la présence de ventes à venir : une adresse publiée ne
 * change plus et ne désigne jamais deux tribunaux.
 */
export function tribunalCodeSlug(code: string): string {
  return normalizeFrenchSearchText(code).replaceAll(" ", "-");
}

/**
 * L'adresse reçue ramenée à la forme des adresses publiées : « JUSTICE-TJ-1-210 » et
 * « justice_tj_1_210 » donnent « justice-tj-1-210 », « Bobigny » donne « bobigny ». Sert à
 * rediriger (308) une adresse mal écrite vers la bonne, jamais à la servir telle quelle.
 */
export function normalizeTribunalSlug(raw: string): string {
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // Une séquence % invalide : on normalise le texte tel qu'il est reçu.
  }
  return tribunalCodeSlug(text);
}

export function tribunalPagePath(code: string): string {
  return `${TRIBUNAL_PAGES_PATH}/${tribunalCodeSlug(code)}`;
}

function departmentSuffix(activity: PublicTribunalActivity): string {
  return normalizeFrenchSearchText(activity.department ?? "").replaceAll(" ", "-");
}

/** Une page par tribunal, à l'adresse stable tirée de son code (voir `tribunalCodeSlug`). */
export function tribunalPages(items: readonly PublicTribunalActivity[]): TribunalPage[] {
  return items.map((activity) => ({
    activity,
    slug: tribunalCodeSlug(activity.code),
    path: tribunalPagePath(activity.code),
  }));
}

/**
 * Les adresses telles qu'elles étaient publiées avant les adresses par code : le nom du tribunal,
 * complété par le département puis par le code quand deux tribunaux à ventes à venir avaient le
 * même nom. Sert uniquement à retrouver où rediriger une ancienne adresse.
 */
export function legacyTribunalPages(items: readonly PublicTribunalActivity[]): TribunalPage[] {
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

/**
 * La nouvelle adresse d'un tribunal publié sous son ancienne adresse (nom), ou `null`. D'abord les
 * tribunaux à ventes à venir, avec l'algorithme d'origine (collisions comprises) ; ensuite le
 * référentiel complet pour un tribunal qui n'a plus de vente, seulement quand le nom désigne un
 * tribunal et un seul.
 */
export function legacyTribunalRedirectPath(
  items: readonly PublicTribunalActivity[],
  directory: readonly PublicTribunalDirectoryEntry[],
  slug: string,
): string | null {
  const active = legacyTribunalPages(items).find((page) => page.slug === slug);
  if (active) return tribunalPagePath(active.activity.code);
  const named = directory.filter(
    (entry) => (tribunalSlugBase(entry.searchName || entry.name) || entry.code) === slug,
  );
  return named.length === 1 ? tribunalPagePath(named[0].code) : null;
}

/** Le tribunal connu du référentiel qui porte cette adresse, ou `null`. */
export function knownTribunalFromSlug(
  directory: readonly PublicTribunalDirectoryEntry[],
  slug: string,
): PublicTribunalDirectoryEntry | null {
  return directory.find((entry) => tribunalCodeSlug(entry.code) === slug) ?? null;
}

/** Un tribunal du référentiel sans vente à venir, sous la forme des chiffres d'une page. */
export function emptyTribunalActivity(entry: PublicTribunalDirectoryEntry): PublicTribunalActivity {
  return {
    code: entry.code,
    name: entry.name,
    searchName: entry.searchName,
    city: entry.city,
    department: entry.department,
    upcomingCount: 0,
    nextSaleDate: null,
    medianStartingPriceEur: null,
    houseCount: 0,
    apartmentCount: 0,
    otherCount: 0,
  };
}

/** La page du tribunal désigné par l'adresse, ou `null` : seule l'adresse exacte existe. */
export function tribunalPageFromSlug(
  items: readonly PublicTribunalActivity[],
  slug: string,
): TribunalPage | null {
  return tribunalPages(items).find((page) => page.slug === slug) ?? null;
}

/**
 * Les tribunaux dont la page est indexable, par nombre de ventes décroissant. Un tribunal sans nom
 * lisible (code brut à la place du nom) n'y est pas : sa page est en `noindex`.
 */
export function indexableTribunalPages(items: readonly PublicTribunalActivity[]): TribunalPage[] {
  return tribunalPages(items).filter(
    (page) =>
      isTribunalPageIndexable(page.activity.upcomingCount) &&
      hasReadableTribunalName(page.activity),
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

/** Nom long d'un tribunal que le référentiel ne nomme pas. */
const UNKNOWN_TRIBUNAL_LONG_NAME = "Tribunal judiciaire (nom à confirmer)";

/**
 * Vrai quand la page peut nommer le tribunal : son nom enregistré est un vrai nom, et non son code
 * brut (un référentiel sans `canonical_name` rend le code à la place). Sans nom lisible, la page
 * reste servie, avec un libellé neutre, hors de l'index.
 */
export function hasReadableTribunalName(
  activity: Pick<PublicTribunalActivity, "code" | "name" | "searchName">,
): boolean {
  const name = (activity.searchName || activity.name || "").trim();
  return name !== "" && name !== activity.code && !isRawTribunalCode(name);
}

/**
 * « Tribunal judiciaire de Bobigny », « Tribunal judiciaire du Puy-en-Velay » à partir du nom du
 * référentiel (jamais le nom doublé « Tribunal judiciaire de Tribunal judiciaire du … »).
 */
export function tribunalLongNameFromRaw(raw: string): string {
  const name = raw.trim();
  // Un code brut à la place du nom (`canonical_name` nul) : jamais affiché comme un nom.
  if (isRawTribunalCode(name)) return UNKNOWN_TRIBUNAL_LONG_NAME;
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

const TITLE_MAX_LENGTH = 48;

/**
 * Titre de l'onglet (le gabarit du site ajoute « - Immojudis ») : « Ventes aux enchères au tribunal
 * de Bordeaux ». Il tient en 48 caractères : pour un nom trop long (« Saint-Denis-de-la-Réunion »),
 * il se réduit à « Ventes aux enchères : Saint-Denis-de-la-Réunion » plutôt que d'être coupé.
 */
export function tribunalPageTitle(
  activity: Pick<PublicTribunalActivity, "name" | "searchName">,
): string {
  const phrase = atTribunalPhrase(activity).replace(/^au tribunal judiciaire\b/, "au tribunal");
  const title = `Ventes aux enchères ${phrase}`;
  if (title.length <= TITLE_MAX_LENGTH) return title;
  return `Ventes aux enchères : ${tribunalPlaceName(activity.searchName || activity.name)}`;
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
  if (count === 0)
    return `Aucune vente judiciaire à venir ${atTribunalPhrase(activity)} pour le moment.`;
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

/** Les ventes lues d'un tribunal, vues par le calcul du nombre de ventes (voir ci-dessous). */
type TribunalSalesRead =
  | { status: "ok"; sales: readonly unknown[]; received: number }
  | { status: "error" }
  | null;

/**
 * Le tribunal avec son nombre de ventes à venir corrigé des doublons que la liste a écartés (une
 * vente publiée par deux sources, voir `dedupeTribunalSaleRows`), pour que le compteur et la liste
 * parlent des mêmes ventes. Deux cas :
 * - liste complète (moins de lignes reçues que la limite) : le compteur est la liste dédoublonnée ;
 * - liste tronquée : on retire les doublons vus, le reste du total est celui de l'activité, qui
 *   compte une même vente publiée par deux sources deux fois. `mayCountDuplicates` est alors vrai :
 *   la page le dit, car d'autres doublons peuvent se trouver au-delà de la liste.
 * Sans doublon vu, ou sans liste lue, le compteur est celui de l'activité, inchangé.
 */
export function tribunalActivityWithoutDuplicates<
  T extends Pick<PublicTribunalActivity, "upcomingCount">,
>(activity: T, read: TribunalSalesRead): T & { mayCountDuplicates: boolean } {
  if (!read || read.status !== "ok") return { ...activity, mayCountDuplicates: false };
  const listed = read.sales.length;
  const removed = read.received - listed;
  if (removed <= 0) return { ...activity, mayCountDuplicates: false };
  if (read.received < TRIBUNAL_PAGE_LISTED_SALES) {
    return { ...activity, upcomingCount: listed, mayCountDuplicates: false };
  }
  return {
    ...activity,
    upcomingCount: Math.max(activity.upcomingCount - removed, listed),
    mayCountDuplicates: true,
  };
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
