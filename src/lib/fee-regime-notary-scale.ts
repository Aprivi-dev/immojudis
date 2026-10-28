// Barèmes et taux des régimes notariaux, SANS textes : module minuscule que le rendement brut (`sale-yield-fees.ts`,
// importé par les filtres de recherche du navigateur) lit sans embarquer le vocabulaire des régimes
// (`fee-regime-labels.ts`). `fee-regime-notary.ts` les réexporte : rien ne change pour ses lecteurs.
import type { EmolumentBracket } from "@/lib/profitability";

// ─── Barèmes des émoluments du notaire ───────────────────────────────────
// Tarif des notaires : taux HT appliqués tranche par tranche au prix, mêmes seuils de tranches que
// le barème de l'avocat poursuivant du tribunal (6 500 €, 17 000 €, 60 000 €). Valeurs relevées sur
// des sources secondaires concordantes (copies du tarif, arrêtés du 25/02/2026 applicables du
// 01/03/2026 au 29/02/2028) dans le rapport de recherche du 26/10/2026 ; À CONFIRMER SUR LÉGIFRANCE
// avant toute évolution. Après le 29/02/2028, le barème est à revérifier.
export const NOTARY_EMOLUMENT_SCALE_REFERENCE =
  "tarif des notaires (arrêtés du 25/02/2026, applicables du 01/03/2026 au 29/02/2028)";
export const NOTARY_EMOLUMENT_SCALE_DATE = "26/10/2026";

/** Barème « adjudication volontaire » : vente à la bougie. 7,74 / 3,192 / 2,129 / 1,597 % HT. */
export const NOTARY_AUCTION_EMOLUMENT_BRACKETS: readonly EmolumentBracket[] = [
  { upTo: 6_500, rate: 0.0774 },
  { upTo: 17_000, rate: 0.03192 },
  { upTo: 60_000, rate: 0.02129 },
  { upTo: Infinity, rate: 0.01597 },
];

/** Barème de gré à gré : vente interactive. 3,870 / 1,596 / 1,064 / 0,799 % HT. */
export const NOTARY_ONLINE_EMOLUMENT_BRACKETS: readonly EmolumentBracket[] = [
  { upTo: 6_500, rate: 0.0387 },
  { upTo: 17_000, rate: 0.01596 },
  { upTo: 60_000, rate: 0.01064 },
  { upTo: Infinity, rate: 0.00799 },
];

/**
 * Frais d'organisation et de publicité d'une vente à la bougie : 2 % HT du prix (TVA en sus). Ils
 * entrent dans la base des droits de mutation (BOFiP).
 */
export const NOTARY_AUCTION_ORGANIZATION_FEE_RATE = 0.02;
