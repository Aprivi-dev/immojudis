import { calendarDaysBetween, parisDateKey } from "@/lib/sale-countdown";
import { saleHearingTime } from "@/lib/seo";
import { tribunalLongNameFromRaw } from "@/lib/tribunal-pages";

/**
 * Page « Audiences à venir » : les ventes au tribunal dont la date est sourcée, des 7 puis des 30
 * prochains jours, groupées par jour puis par tribunal. Module de calcul pur ; la lecture de la
 * base (`get_public_upcoming_hearings`) est dans `upcoming-hearings.server.ts`.
 *
 * « Date sourcée » a le sens de l'export agenda (`get_public_sale_calendar_event`) : la base ne
 * rend que les audiences que l'export accepte, jamais une vente reportée, en conflit entre sources
 * ou à la date rejetée. Aucune adresse exacte n'y figure : commune, type de bien, tribunal, date,
 * mise à prix, comme les cartes publiques.
 */
export const HEARINGS_PATH = "/audiences-a-venir";

/** Première fenêtre : aujourd'hui et les six jours suivants. */
export const HEARINGS_WEEK_DAYS = 7;
/** Seconde fenêtre : jusqu'au 30e jour compris (aujourd'hui est le premier). */
export const HEARINGS_WINDOW_DAYS = 30;
/** `p_days` de la base compte à partir d'aujourd'hui : « aujourd'hui + 29 jours ». */
export const HEARINGS_RPC_DAYS = HEARINGS_WINDOW_DAYS - 1;

/**
 * Nombre minimal d'audiences distinctes pour que la page soit indexable et listée au sitemap. En
 * dessous elle reste consultable, en `noindex, follow` : trois audiences font une page qui a
 * quelque chose à montrer, une ou deux, une page mince (même raisonnement que les départements).
 */
export const HEARINGS_PAGE_MIN_HEARINGS = 3;

/** Ligne de `get_public_upcoming_hearings`. Les nombres arrivent parfois en chaîne de PostgREST. */
export type UpcomingHearingRow = {
  id: string;
  sale_date: string | null;
  date_only: boolean | null;
  property_type: string | null;
  city: string | null;
  department: string | null;
  tribunal_code: string | null;
  tribunal_name: string | null;
  tribunal_city: string | null;
  starting_price_eur: number | string | null;
  /**
   * Clés opaques des adresses sources de l'annonce (SHA-256 de l'adresse normalisée, en hexadécimal) :
   * elles servent à reconnaître la même vente publiée deux fois, sans exposer d'adresse (les vues
   * publiques masquent `source_url`). Absentes d'une base qui n'a pas la migration 20261029100100 : la
   * page fonctionne alors sans fusion.
   */
  source_keys?: unknown;
  total_count: number | string | null;
};

export type PublicHearing = {
  id: string;
  /** Instant de l'audience (ISO). */
  saleDate: string;
  /** Jour à Paris (`AAAA-MM-JJ`) : le jour de l'audience pour un visiteur en France. */
  dayKey: string;
  /** Heure à Paris (« 14 h 00 »), ou `null` quand l'heure n'est pas connue. */
  time: string | null;
  propertyType: string | null;
  city: string | null;
  department: string | null;
  tribunalCode: string | null;
  /** Clé de regroupement : le code du tribunal, à défaut son nom. */
  tribunalKey: string;
  tribunalLabel: string;
  startingPriceEur: number | null;
  /** Clés opaques des adresses sources de l'annonce : servent seulement à reconnaître un doublon. */
  sourceKeys: string[];
};

function finite(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Clés des adresses sources d'une ligne. La base les rend déjà normalisées (sans protocole, `www.`,
 * paramètres, ancre ni barre finale, en minuscules : `app_private.normalize_source_url`) puis condensées
 * en SHA-256 : deux écritures d'une même annonce ont la même clé. Une valeur qui n'est pas une chaîne
 * non vide est ignorée.
 */
function sourceKeysOf(row: Pick<UpcomingHearingRow, "source_keys">): string[] {
  if (!Array.isArray(row.source_keys)) return [];
  const keys = row.source_keys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  return [...new Set(keys)];
}

/** Les lignes de la base en audiences ; une ligne sans date lisible n'est pas une audience. */
export function mapHearingRows(rows: readonly UpcomingHearingRow[]): PublicHearing[] {
  const hearings: PublicHearing[] = [];
  for (const row of rows) {
    const date = row.sale_date ? new Date(row.sale_date) : null;
    if (!date || !Number.isFinite(date.getTime())) continue;
    const name = row.tribunal_name?.trim() || null;
    const tribunalKey = row.tribunal_code?.trim() || name;
    if (!tribunalKey) continue;
    hearings.push({
      id: row.id,
      saleDate: date.toISOString(),
      dayKey: parisDateKey(date),
      // Une audience sans heure connue est datée du jour seulement : aucune heure inventée.
      time: row.date_only === false ? saleHearingTime(row.sale_date) : null,
      propertyType: row.property_type,
      city: row.city?.trim() || null,
      department: row.department,
      tribunalCode: row.tribunal_code?.trim() || null,
      tribunalKey,
      tribunalLabel: name ? tribunalLongNameFromRaw(name) : "Tribunal à confirmer",
      startingPriceEur: finite(row.starting_price_eur),
      sourceKeys: sourceKeysOf(row),
    });
  }
  return hearings;
}

/**
 * Une vente publiée par deux sources n'est pas encore fusionnée dans toutes les fiches. Deux lignes
 * ne sont réunies que sur une identité certaine : le même identifiant d'annonce, ou une clé
 * d'adresse source en commun (`source_keys`). Seule la première est gardée (la
 * plus tôt dans la journée, puis la plus petite identité). Le tribunal, le jour et la mise à prix ne
 * suffisent jamais : deux lots distincts d'un même tribunal peuvent partir au même prix le même
 * jour, et les confondre ferait disparaître une audience. Mieux vaut une audience affichée deux
 * fois qu'une audience qui manque.
 *
 * Les clés d'une ligne écartée comptent aussi : A et B qui partagent une adresse, puis B et C, font
 * une seule vente.
 */
export function dedupeHearings(hearings: readonly PublicHearing[]): PublicHearing[] {
  const ordered = [...hearings].sort(
    (a, b) => a.saleDate.localeCompare(b.saleDate) || a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  const kept: PublicHearing[] = [];
  for (const hearing of ordered) {
    const keys = [`id:${hearing.id}`, ...hearing.sourceKeys.map((key) => `url:${key}`)];
    const duplicate = keys.some((key) => seen.has(key));
    for (const key of keys) seen.add(key);
    if (!duplicate) kept.push(hearing);
  }
  return kept;
}

export type HearingTribunalGroup = {
  key: string;
  label: string;
  tribunalCode: string | null;
  hearings: PublicHearing[];
};

export type HearingDay = {
  dayKey: string;
  tribunals: HearingTribunalGroup[];
  count: number;
};

export type HearingWindows = {
  /** Aujourd'hui et les six jours suivants. */
  week: HearingDay[];
  weekCount: number;
  /** Du 8e au 30e jour. */
  later: HearingDay[];
  laterCount: number;
};

function groupByDay(hearings: readonly PublicHearing[]): HearingDay[] {
  const days = new Map<string, Map<string, HearingTribunalGroup>>();
  for (const hearing of hearings) {
    const tribunals = days.get(hearing.dayKey) ?? new Map<string, HearingTribunalGroup>();
    const group = tribunals.get(hearing.tribunalKey) ?? {
      key: hearing.tribunalKey,
      label: hearing.tribunalLabel,
      tribunalCode: hearing.tribunalCode,
      hearings: [],
    };
    group.hearings.push(hearing);
    tribunals.set(hearing.tribunalKey, group);
    days.set(hearing.dayKey, tribunals);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dayKey, tribunals]) => {
      const groups = [...tribunals.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
      for (const group of groups) {
        group.hearings.sort(
          (a, b) =>
            a.saleDate.localeCompare(b.saleDate) ||
            (a.city ?? "").localeCompare(b.city ?? "", "fr") ||
            a.id.localeCompare(b.id),
        );
      }
      return {
        dayKey,
        tribunals: groups,
        count: groups.reduce((total, group) => total + group.hearings.length, 0),
      };
    });
}

/**
 * Les audiences réparties en deux fenêtres, jour par jour puis tribunal par tribunal. `now` donne
 * « aujourd'hui » à Paris ; une audience hors des 30 jours, ou d'hier, n'est dans aucune fenêtre.
 */
export function windowHearings(
  hearings: readonly PublicHearing[],
  now: Date = new Date(),
): HearingWindows {
  const today = parisDateKey(now);
  const week: PublicHearing[] = [];
  const later: PublicHearing[] = [];
  for (const hearing of hearings) {
    const offset = calendarDaysBetween(today, hearing.dayKey);
    if (offset == null || offset < 0 || offset >= HEARINGS_WINDOW_DAYS) continue;
    (offset < HEARINGS_WEEK_DAYS ? week : later).push(hearing);
  }
  return {
    week: groupByDay(week),
    weekCount: week.length,
    later: groupByDay(later),
    laterCount: later.length,
  };
}

/** Vrai quand la page peut être indexée et figurer au sitemap. */
export function isHearingsPageIndexable(hearingCount: number): boolean {
  return hearingCount >= HEARINGS_PAGE_MIN_HEARINGS;
}

/** Description de la page, calculée sur ses chiffres (158 caractères au plus). */
export function hearingsPageDescription(weekCount: number, laterCount: number): string {
  const total = weekCount + laterCount;
  if (total === 0) {
    return "Aucune audience de vente judiciaire à date sourcée dans les 30 prochains jours. Consultez les ventes à venir tribunal par tribunal.";
  }
  const noun = total > 1 ? "audiences de ventes judiciaires" : "audience de vente judiciaire";
  const week = weekCount > 0 ? ` (dont ${weekCount} dans les 7 prochains)` : "";
  return `${total} ${noun} dans les 30 prochains jours${week}, par jour et par tribunal. Dates issues des annonces.`;
}
