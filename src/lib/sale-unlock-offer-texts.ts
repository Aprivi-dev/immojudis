/**
 * Textes de l'achat à l'unité que /offres affiche (achat ouvert), à part du reste des textes de
 * l'achat (`sale-unlock-purchase-texts.ts`, bloc d'achat de la fiche) : /offres ne charge que ceux-ci.
 */

/** Un montant en centimes, écrit comme un prix : « 19 € », « 40,50 € ». */
export function formatEuroCents(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Le plus petit nombre de ventes à l'unité dont le total dépasse strictement le prix d'un mois
 * d'abonnement : à partir de là, l'abonnement revient moins cher (19 € et 59 € : 4, car 3 × 19 € =
 * 57 €). `null` quand un montant manque ou n'est pas un prix positif : aucune comparaison n'est dite.
 */
export function subscriptionCheaperFrom({
  unitCents,
  subscriptionCents,
}: {
  unitCents: number;
  subscriptionCents: number | null;
}): number | null {
  if (!Number.isFinite(unitCents) || unitCents <= 0) return null;
  if (subscriptionCents == null || !Number.isFinite(subscriptionCents) || subscriptionCents <= 0) {
    return null;
  }
  return Math.floor(subscriptionCents / unitCents) + 1;
}

const NUMBER_WORDS = ["deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"];

/** « À partir de quatre ventes » : de deux à dix en lettres, au-delà en chiffres. */
function fromSalesText(count: number): string {
  if (count === 1) return "À partir d’une vente";
  return `À partir de ${NUMBER_WORDS[count - 2] ?? String(count)} ventes`;
}

/** La phrase de comparaison, ou `null` quand le seuil ne se calcule pas. */
export function cheaperFromSentence(
  prices: { unitCents: number; subscriptionCents: number | null },
  unitWording: string,
): string | null {
  const count = subscriptionCheaperFrom(prices);
  return count == null
    ? null
    : `${fromSalesText(count)}${unitWording}, l’abonnement revient moins cher.`;
}

/**
 * Sous la carte Découverte de /offres et dans le comparatif, seulement quand l'achat est ouvert.
 */
export function salePurchaseOfferLine(label: string): string {
  return `Vente supplémentaire à l’unité : ${label}`;
}

/**
 * Sous les cartes de /offres, achat ouvert. La seconde phrase suit le même calcul que la fiche
 * (`subscriptionCheaperFrom`).
 */
export function salePurchaseOffersNote({
  unitCents,
  subscriptionCents,
}: {
  unitCents: number;
  subscriptionCents: number | null;
}): string {
  const first = "Vous n’avez besoin que d’une vente de plus ? Elle s’achète à l’unité.";
  const comparison = cheaperFromSentence({ unitCents, subscriptionCents }, "");
  return comparison ? `${first} ${comparison}` : first;
}
