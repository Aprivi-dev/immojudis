/**
 * Surenchère du dixième : montant minimal d'une surenchère à partir d'un prix d'adjudication.
 *
 * Seul le calcul vit ici. La règle (qui peut surenchérir, dans quel délai, dans quels types de
 * vente) est celle de l'article `apres-adjudication-surenchere-paiement-titre-vente` : voir
 * `surenchere-reminder.ts`, qui la lit sans la réécrire.
 */
const SURENCHERE_RATE_DIVISOR = 10;

export type SurenchereAmounts = {
  /** Prix principal de la vente, en euros. */
  principalPrice: number;
  /** Un dixième du prix principal, arrondi au centime supérieur. */
  tenth: number;
  /** Prix minimal d'une surenchère : prix principal + 10 %. */
  minimumBid: number;
};

/**
 * Calcul en centimes entiers : `100 000 × 1,1` vaut `110 000,00000000001` en virgule flottante,
 * ce qui ferait arrondir le dixième à l'euro supérieur sans raison.
 */
export function minimumSurenchere(price: number): SurenchereAmounts | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const principalCents = Math.round(price * 100);
  const tenthCents = Math.ceil(principalCents / SURENCHERE_RATE_DIVISOR);
  return {
    principalPrice: principalCents / 100,
    tenth: tenthCents / 100,
    minimumBid: (principalCents + tenthCents) / 100,
  };
}
