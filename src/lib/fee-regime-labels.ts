// Vocabulaire du régime de frais : le terme du montant maximal (« enchère plafond ») et les ventes
// qu'il concerne, qui changent d'un type de vente à l'autre. Module sans autre import que `fee-regime-open.ts`, pour que les
// pages d'offres, les cartes de résultats et les textes de déblocage l'emploient sans embarquer les
// barèmes ni les textes du calcul (`fee-regime-definitions.ts`) ni le lien avec une vente
// (`fee-regime.ts`). Qui est ouvert se décide dans `fee-regime-open.ts`.

import { isFeeRegimeOpen, type FeeRegimeKey } from "@/lib/fee-regime-open";

/** Les termes d'un régime, tels que les offres et les cartes de résultats les citent. */
export type FeeRegimeTerms = {
  /** Terme du montant maximal, en minuscules : « enchère plafond ». */
  ceilingTerm: string;
  /** Le même terme avec son article : « l’enchère plafond ». */
  ceilingTermWithArticle: string;
  /** Intitulé du montant dans les aperçus de la fiche : « Enchère plafond (simulation) ». */
  ceilingSimulationLabel: string;
  /** Les ventes concernées, pour les phrases d'offre : « ventes au tribunal ». */
  venueScope: string;
};

export const TRIBUNAL_FEE_REGIME_TERMS: FeeRegimeTerms = {
  ceilingTerm: "enchère plafond",
  ceilingTermWithArticle: "l’enchère plafond",
  ceilingSimulationLabel: "Enchère plafond (simulation)",
  venueScope: "ventes au tribunal",
};

/** Les termes des régimes définis : une clé absente n'a pas encore de règles et ne s'ouvre jamais. */
export const FEE_REGIME_TERMS: Readonly<Partial<Record<FeeRegimeKey, FeeRegimeTerms>>> = {
  tribunal: TRIBUNAL_FEE_REGIME_TERMS,
};

function openTerms(open?: readonly FeeRegimeKey[]): FeeRegimeTerms[] {
  return (Object.keys(FEE_REGIME_TERMS) as FeeRegimeKey[])
    .filter((key) => isFeeRegimeOpen(key, open))
    .map((key) => FEE_REGIME_TERMS[key]!);
}

function joinWith(values: string[], last: string): string {
  const distinct = [...new Set(values)];
  return distinct.length > 1
    ? `${distinct.slice(0, -1).join(", ")} ${last} ${distinct.at(-1)}`
    : (distinct[0] ?? "");
}

/** « enchère plafond » (ou « enchère plafond ou offre plafond » quand plusieurs termes coexistent). */
export function ceilingTermText(open?: readonly FeeRegimeKey[]): string {
  return joinWith(
    openTerms(open).map((terms) => terms.ceilingTerm),
    "ou",
  );
}

/** « l’enchère plafond », en tête d'une énumération de ce qu'ouvre un déblocage. */
export function ceilingTermWithArticleText(open?: readonly FeeRegimeKey[]): string {
  return joinWith(
    openTerms(open).map((terms) => terms.ceilingTermWithArticle),
    "ou",
  );
}

/** « ventes au tribunal » : les ventes dont le calcul est ouvert, pour les phrases d'offre. */
export function ceilingVenueScopeText(open?: readonly FeeRegimeKey[]): string {
  return joinWith(
    openTerms(open).map((terms) => terms.venueScope),
    "et",
  );
}
