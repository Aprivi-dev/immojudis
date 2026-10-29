// Marché local de la règle pepite-v1.2 et suivantes : correspondance entre une vente et la ligne de l'agrégat
// `app_private.commune_market_trends` (commune, type de logement). Fonctions PURES ; la lecture est faite par
// `pepite-context.server.ts`. Les seuils et l'évaluation des critères sont dans `pepite-policy.ts`.
import {
  PEPITE_MARKET_PROPERTY_TYPES,
  type PepiteMarketAggregate,
  type PepiteMarketPropertyType,
} from "@/lib/pepite-policy";

/**
 * Type de logement DVF d'une vente : « Maison » pour `house`, « Appartement » pour `apartment`. Tout autre type
 * (immeuble, local, terrain, inconnu) n'a pas d'agrégat : les critères de marché sont alors réussis, faute de donnée.
 */
export function marketPropertyType(
  saleType: string | null | undefined,
): PepiteMarketPropertyType | null {
  const type = (saleType ?? "").trim().toLowerCase();
  if (type === "house" || type === "maison") return "Maison";
  if (type === "apartment" || type === "appartement") return "Appartement";
  return null;
}

/**
 * Code INSEE tel que DVF l'écrit : l'arrondissement pour Paris, Lyon et Marseille (751xx, 693xx, 132xx), la commune
 * ailleurs. `auction_sale_communes.commune_insee` ramène les arrondissements à la commune (75056, 69123, 13055), qui
 * n'existe pas dans DVF : on préfère l'arrondissement quand il est connu. Sans arrondissement connu pour ces trois
 * communes, le code de la commune est rendu tel quel (il n'a pas de ligne : critères réussis, faute de donnée).
 */
export function dvfInseeCode(
  commune: { communeInsee: string; arrondissementInsee: string | null } | null | undefined,
): string | null {
  if (!commune) return null;
  return commune.arrondissementInsee || commune.communeInsee || null;
}

export function marketTrendKey(inseeCode: string, propertyType: string): string {
  return `${inseeCode}|${propertyType}`;
}

/** Ce que la fonction `get_commune_market_trends` rend, une ligne par commune et type. */
export type MarketTrendRow = {
  insee_code?: unknown;
  property_type?: unknown;
  reference_year?: unknown;
  sales_12_months?: unknown;
  median_recent_eur_m2?: unknown;
  median_baseline_eur_m2?: unknown;
  sales_recent_year?: unknown;
  sales_baseline_year?: unknown;
};

const count = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0
    ? Math.trunc(number)
    : null;
};
const price = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : null;
};

/** Une ligne de l'agrégat lue de la base ; `null` pour une ligne inexploitable (jamais une valeur inventée). */
export function parseMarketTrendRow(
  row: MarketTrendRow | null | undefined,
): { key: string; aggregate: PepiteMarketAggregate } | null {
  if (!row) return null;
  const insee = typeof row.insee_code === "string" ? row.insee_code : null;
  const type = PEPITE_MARKET_PROPERTY_TYPES.find((item) => item === row.property_type);
  const referenceYear = count(row.reference_year);
  const sales12Months = count(row.sales_12_months);
  const salesRecentYear = count(row.sales_recent_year);
  const salesBaselineYear = count(row.sales_baseline_year);
  if (
    !insee ||
    !type ||
    referenceYear == null ||
    sales12Months == null ||
    salesRecentYear == null ||
    salesBaselineYear == null
  ) {
    return null;
  }
  return {
    key: marketTrendKey(insee, type),
    aggregate: {
      referenceYear,
      sales12Months,
      medianRecentEurM2: price(row.median_recent_eur_m2),
      medianBaselineEurM2: price(row.median_baseline_eur_m2),
      salesRecentYear,
      salesBaselineYear,
    },
  };
}
