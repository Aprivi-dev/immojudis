const PRICE_NOT_COMMUNICATED = "Prix non communiqué";

/**
 * Montant en euros. Une valeur absente ou non finie (NaN, Infinity) n'est jamais affichée comme un
 * montant. 0 reste « 0 € » : frais nuls, marge nulle ou mensualité nulle sont des montants réels.
 * Pour une mise à prix, où 0 signifie « non communiquée », utiliser `formatStartingPrice`.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return PRICE_NOT_COMMUNICATED;
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Mise à prix ou prix publié. La base autorise 0 (`starting_price_eur >= 0`) mais une vente à
 * 0 € n'est jamais annoncée : 0 est traité comme un prix non communiqué.
 */
export function formatStartingPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return PRICE_NOT_COMMUNICATED;
  return formatPrice(value);
}

export function formatCurrency(
  value: number | null | undefined,
  currency = "EUR",
  locale = "fr-FR",
): string {
  if (value == null || !Number.isFinite(value)) return "Prix non communiqué";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number | null | undefined, locale = "fr-FR"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

export function formatPropertyArea(sqft: number | null | undefined, locale = "fr-FR"): string {
  if (sqft == null || !Number.isFinite(sqft)) return "Surface non communiquée";
  return `${formatNumber(sqft, locale)} ft²`;
}

export function formatPricePerM2(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 0,
  }).format(value)} €/m²`;
}

export function formatSurface(m2: number | null | undefined): string {
  if (m2 == null) return "—";
  return `${Math.round(m2)} m²`;
}

/** Montant au centime : « 1 234,50 € » (frais détaillés, remboursements). */
export function formatPriceWithCents(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return PRICE_NOT_COMMUNICATED;
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

/** Loyer au mètre carré, à une décimale : « 12,5 €/m² ». */
export function formatRentPerM2(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)} €/m²`;
}

/**
 * Pourcentage déjà exprimé de 0 à 100 : 12.5 → « 12,5 % » avec une décimale. Au plus
 * `maximumFractionDigits` décimales ; `minimumFractionDigits` garde les zéros (« 5,0 % »).
 */
export function formatPercent(
  value: number | null | undefined,
  maximumFractionDigits = 0,
  minimumFractionDigits = 0,
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(value)} %`;
}

/** Part de 0 à 1 en pourcentage : 0.125 → « 13 % », ou « 12,5 % » avec une décimale. */
export function formatShareAsPercent(
  share: number | null | undefined,
  maximumFractionDigits = 0,
): string {
  return formatPercent(share == null ? share : share * 100, maximumFractionDigits);
}
