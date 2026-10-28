import {
  TRIBUNAL_STATISTICS_MEDIAN_MIN_SAMPLE,
  TRIBUNAL_STATISTICS_RANGE_MIN_SAMPLE,
} from "@/lib/tribunal-publication-thresholds";

/**
 * Public activity of each court (signed-out « Statistiques Tribunaux » page):
 * what the public catalogue already lists, aggregated per court. Adjudication
 * prices and results are never part of it; they stay in the Analyse barometer.
 */
export type PublicTribunalActivity = {
  code: string;
  name: string;
  /** Name as stored: the catalogue's tribunal filter matches it exactly. */
  searchName: string;
  city: string | null;
  department: string | null;
  upcomingCount: number;
  nextSaleDate: string | null;
  medianStartingPriceEur: number | null;
  /**
   * Ventes à venir dont la mise à prix est connue : le « n » des chiffres de prix. Absent quand la
   * fonction `get_public_tribunal_price_figures` (migration `20261108160000`) n'est pas là : aucun chiffre de prix
   * n'est alors publié (« — »), `upcomingCount` ne tient pas lieu de « n » (il surestimerait l'échantillon).
   */
  pricedCount?: number | null;
  /** Plus petite et plus grande mise à prix, publiées de 5 à 9 ventes chiffrées seulement. */
  minStartingPriceEur?: number | null;
  maxStartingPriceEur?: number | null;
  houseCount: number;
  apartmentCount: number;
  otherCount: number;
};

export type PublicTribunalActivityRow = {
  tribunal_code: string;
  tribunal_name: string | null;
  tribunal_city: string | null;
  department: string | null;
  upcoming_count: number | null;
  next_sale_date: string | null;
  median_starting_price_eur: number | string | null;
  house_count: number | null;
  apartment_count: number | null;
  other_count: number | null;
};

/** Ligne de `get_public_tribunal_price_figures` : le « n » des mises à prix et ce que les seuils publient. */
export type PublicTribunalPriceFigureRow = {
  tribunal_code: string;
  priced_count: number | null;
  min_starting_price_eur: number | string | null;
  max_starting_price_eur: number | string | null;
  median_starting_price_eur: number | string | null;
};

/** Nom donné à un tribunal que le référentiel ne nomme pas : jamais son code brut. */
export const UNKNOWN_TRIBUNAL_NAME = "Tribunal à confirmer";

/**
 * Vrai pour un « nom » qui est en réalité un code (« justice_tj_1_210 ») : un nom de tribunal ne
 * contient ni underscore ni mot collé. Le référentiel rend le code à la place d'un nom manquant
 * (`canonical_name` nul) ; les pages ne l'affichent jamais comme un nom.
 */
export function isRawTribunalCode(name: string | null | undefined): boolean {
  return /^\S*_\S*$/.test((name ?? "").trim());
}

/**
 * "TJ Bobigny" → "Bobigny", "TJ Tribunal judiciaire du Mans" → "Le Mans". Un code brut à la place
 * d'un nom donne `UNKNOWN_TRIBUNAL_NAME`.
 */
export function courtShortName(name: string): string {
  if (isRawTribunalCode(name)) return UNKNOWN_TRIBUNAL_NAME;
  let text = name.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(/^(?:tribunal judiciaire|tribunal de grande instance|tj|tgi)\b\s*/i, "");
  }
  const article = /^(du|des)\s+/i.exec(text);
  if (article)
    return `${article[1].toLowerCase() === "du" ? "Le" : "Les"} ${text.slice(article[0].length)}`;
  return text.replace(/^(?:de la|de l['’]|de|d['’])\s*/i, "").trim() || name.trim();
}

function finite(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Courts with upcoming sales, busiest first, then alphabetically. */
export function mapPublicTribunalActivity(
  rows: PublicTribunalActivityRow[],
  /**
   * Chiffres de prix soumis aux seuils de publication (`get_public_tribunal_price_figures`). Fournis,
   * ils remplacent la médiane de `get_public_tribunal_activity` (qui n'a aucun minimum) : un tribunal
   * sans ligne n'a aucune vente chiffrée. Absents (fonction pas encore déployée) : aucun chiffre de prix
   * n'est publié (voir `PublicTribunalActivity.pricedCount` et `tribunalPriceFigure`).
   */
  priceFigures?: PublicTribunalPriceFigureRow[] | null,
): PublicTribunalActivity[] {
  const figuresByCode = priceFigures
    ? new Map(priceFigures.map((figure) => [figure.tribunal_code, figure]))
    : null;
  return rows
    .map((row) => {
      const figure = figuresByCode?.get(row.tribunal_code);
      return {
        ...mapActivityRow(row),
        ...(figuresByCode
          ? {
              medianStartingPriceEur: finite(figure?.median_starting_price_eur),
              pricedCount: finite(figure?.priced_count) ?? 0,
              minStartingPriceEur: finite(figure?.min_starting_price_eur),
              maxStartingPriceEur: finite(figure?.max_starting_price_eur),
            }
          : {}),
      };
    })
    .filter((item) => item.upcomingCount > 0)
    .sort((a, b) => b.upcomingCount - a.upcomingCount || a.name.localeCompare(b.name, "fr"));
}

function mapActivityRow(row: PublicTribunalActivityRow): PublicTribunalActivity {
  return {
    code: row.tribunal_code,
    name: courtShortName(row.tribunal_name?.trim() || row.tribunal_code),
    searchName: row.tribunal_name?.trim() || row.tribunal_code,
    city: row.tribunal_city,
    department: row.department,
    upcomingCount: finite(row.upcoming_count) ?? 0,
    nextSaleDate: row.next_sale_date,
    medianStartingPriceEur: finite(row.median_starting_price_eur),
    houseCount: finite(row.house_count) ?? 0,
    apartmentCount: finite(row.apartment_count) ?? 0,
    otherCount: finite(row.other_count) ?? 0,
  };
}

export function publicTribunalTotals(items: PublicTribunalActivity[]) {
  return {
    tribunals: items.length,
    upcoming: items.reduce((sum, item) => sum + item.upcomingCount, 0),
  };
}

/**
 * Ce que la liste `/tribunaux` et la page d'un tribunal disent des mises à prix, avec les seuils de
 * publication des autres statistiques de tribunal (`tribunal-publication-thresholds.ts`) :
 * sous 5 ventes chiffrées, aucun chiffre ; de 5 à 9, la fourchette observée ; dès 10, la médiane.
 */
export type TribunalPriceFigure =
  | { kind: "none"; sampleSize: number }
  | { kind: "range"; sampleSize: number; min: number; max: number }
  | { kind: "median"; sampleSize: number; median: number };

export function tribunalPriceFigure(
  item: Pick<
    PublicTribunalActivity,
    | "upcomingCount"
    | "pricedCount"
    | "medianStartingPriceEur"
    | "minStartingPriceEur"
    | "maxStartingPriceEur"
  >,
): TribunalPriceFigure {
  // Sans les chiffres de prix soumis aux seuils (fonction pas encore déployée), on ne publie rien : ni médiane ni
  // fourchette, et `upcomingCount` ne tient pas lieu de « n ».
  if (item.pricedCount == null) return { kind: "none", sampleSize: 0 };
  const sampleSize = Math.max(0, item.pricedCount);
  if (sampleSize >= TRIBUNAL_STATISTICS_MEDIAN_MIN_SAMPLE && item.medianStartingPriceEur != null) {
    return { kind: "median", sampleSize, median: item.medianStartingPriceEur };
  }
  if (
    sampleSize >= TRIBUNAL_STATISTICS_RANGE_MIN_SAMPLE &&
    sampleSize < TRIBUNAL_STATISTICS_MEDIAN_MIN_SAMPLE &&
    item.minStartingPriceEur != null &&
    item.maxStartingPriceEur != null
  ) {
    return {
      kind: "range",
      sampleSize,
      min: item.minStartingPriceEur,
      max: item.maxStartingPriceEur,
    };
  }
  return { kind: "none", sampleSize };
}

/** « 3 ventes chiffrées », « 1 vente chiffrée ». */
export function tribunalSampleLabel(sampleSize: number): string {
  return `${sampleSize} vente${sampleSize > 1 ? "s" : ""} chiffrée${sampleSize > 1 ? "s" : ""}`;
}
