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
): PublicTribunalActivity[] {
  return rows
    .map((row) => ({
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
    }))
    .filter((item) => item.upcomingCount > 0)
    .sort((a, b) => b.upcomingCount - a.upcomingCount || a.name.localeCompare(b.name, "fr"));
}

export function publicTribunalTotals(items: PublicTribunalActivity[]) {
  return {
    tribunals: items.length,
    upcoming: items.reduce((sum, item) => sum + item.upcomingCount, 0),
  };
}
