// Vocabulaire du régime de frais : le terme du montant maximal (« enchère plafond », « offre
// plafond »), le prix de référence et les ventes qu'il concerne, qui changent d'un type de vente à
// l'autre. Module sans autre import que `fee-regime-open.ts`, pour que les pages d'offres, les
// cartes de résultats et les textes de déblocage l'emploient sans embarquer les barèmes ni les
// textes du calcul (`fee-regime-definitions.ts`) ni le lien avec une vente (`fee-regime.ts`). Qui est
// ouvert se décide dans `fee-regime-open.ts`.

import { isFeeRegimeOpen, type FeeRegimeKey } from "@/lib/fee-regime-open";

/** Les termes d'un régime, tels que les offres et les cartes de résultats les citent. */
export type FeeRegimeTerms = {
  /** Terme du montant maximal, en minuscules : « enchère plafond », « offre plafond ». */
  ceilingTerm: string;
  /** Le même terme avec son article : « l’enchère plafond ». */
  ceilingTermWithArticle: string;
  /** Intitulé du montant dans les aperçus de la fiche : « Enchère plafond (simulation) ». */
  ceilingSimulationLabel: string;
  /** Les ventes concernées, pour les phrases d'offre : « ventes au tribunal ». */
  venueScope: string;
};

/**
 * Les termes d'un régime à partir du terme du montant : les deux termes (« enchère plafond »,
 * « offre plafond ») sont féminins et commencent par une voyelle. Le prix de référence et le verbe
 * (« mise à prix », « première offre possible »), qui ne servent qu'à la fiche, sont dans
 * `FeeRegimeLabels` (`fee-regime-definitions.ts`) : ce module reste léger.
 */
function termsFor(ceilingTerm: string, venueScope: string): FeeRegimeTerms {
  return {
    ceilingTerm,
    ceilingTermWithArticle: `l’${ceilingTerm}`,
    ceilingSimulationLabel: `${ceilingTerm.charAt(0).toUpperCase()}${ceilingTerm.slice(1)} (simulation)`,
    venueScope,
  };
}

// `@__PURE__` : un terme qu'aucune page n'importe est retiré du lot (les pages d'offres et les cartes
// de résultats n'embarquent que ce qu'elles citent).
export const TRIBUNAL_FEE_REGIME_TERMS = /* @__PURE__ */ termsFor(
  "enchère plafond",
  "ventes au tribunal",
);

/** Vente notariale à la bougie (vente aux enchères volontaire) : de vraies enchères. */
export const NOTARY_AUCTION_FEE_REGIME_TERMS = /* @__PURE__ */ termsFor(
  "enchère plafond",
  "ventes notariales à la bougie",
);

/** Vente notariale interactive : des offres, que le vendeur n'est pas tenu de retenir. */
export const NOTARY_ONLINE_FEE_REGIME_TERMS = /* @__PURE__ */ termsFor(
  "offre plafond",
  "ventes notariales interactives",
);

/** Les termes des régimes définis : une clé absente n'a pas encore de règles et ne s'ouvre jamais. */
export const FEE_REGIME_TERMS: Readonly<Partial<Record<FeeRegimeKey, FeeRegimeTerms>>> = {
  tribunal: TRIBUNAL_FEE_REGIME_TERMS,
  notary_auction: NOTARY_AUCTION_FEE_REGIME_TERMS,
  notary_online: NOTARY_ONLINE_FEE_REGIME_TERMS,
};

/** Les termes des régimes donnés (ceux dont le calcul est ouvert quand `keys` est absent). */
function termsOf(keys?: readonly FeeRegimeKey[], open?: readonly FeeRegimeKey[]): FeeRegimeTerms[] {
  const selected =
    keys ??
    (Object.keys(FEE_REGIME_TERMS) as FeeRegimeKey[]).filter((key) => isFeeRegimeOpen(key, open));
  return selected.flatMap((key) => (FEE_REGIME_TERMS[key] ? [FEE_REGIME_TERMS[key]] : []));
}

function joinWith(values: string[], last: string): string {
  const distinct = [...new Set(values)];
  return distinct.length > 1
    ? `${distinct.slice(0, -1).join(", ")} ${last} ${distinct.at(-1)}`
    : (distinct[0] ?? "");
}

/**
 * « enchère plafond » (ou « enchère plafond ou offre plafond » quand plusieurs termes coexistent).
 * `open` : les régimes ouverts (tous ceux qui sont définis par défaut).
 */
export function ceilingTermText(open?: readonly FeeRegimeKey[]): string {
  return joinWith(
    termsOf(undefined, open).map((terms) => terms.ceilingTerm),
    "ou",
  );
}

/**
 * « enchère ou offre plafond » : les termes ouverts sous leur mot commun, pour les textes courts
 * (description d'une page, à 160 caractères). Un seul terme : « enchère plafond ».
 */
export function ceilingTermShortText(open?: readonly FeeRegimeKey[]): string {
  const suffix = " plafond";
  const terms = [...new Set(termsOf(undefined, open).map((item) => item.ceilingTerm))];
  if (terms.length === 0 || !terms.every((term) => term.endsWith(suffix))) {
    return ceilingTermText(open);
  }
  return `${joinWith(
    terms.map((term) => term.slice(0, -suffix.length)),
    "ou",
  )}${suffix}`;
}

/** « l’enchère plafond », en tête d'une énumération de ce qu'ouvre un déblocage. */
export function ceilingTermWithArticleText(open?: readonly FeeRegimeKey[]): string {
  return joinWith(
    termsOf(undefined, open).map((terms) => terms.ceilingTermWithArticle),
    "ou",
  );
}

/**
 * Les termes d'un ensemble de régimes possibles pour une vente (voir `feeRegimeKeysForVenue`) :
 * « l’offre plafond » quand un seul terme s'applique, « l’enchère plafond ou l’offre plafond » tant
 * que les conditions d'une vente notariale, qui départagent la bougie de la vente interactive, sont
 * inconnues (compte Découverte qui n'a pas débloqué la vente). Vide : `null`, la vente n'a pas de
 * plafond.
 */
export function ceilingTermsFor(
  keys: readonly FeeRegimeKey[],
): Pick<
  FeeRegimeTerms,
  "ceilingTerm" | "ceilingTermWithArticle" | "ceilingSimulationLabel"
> | null {
  const terms = termsOf(keys);
  if (terms.length === 0) return null;
  const ceilingTerm = joinWith(
    terms.map((item) => item.ceilingTerm),
    "ou",
  );
  return {
    ceilingTerm,
    ceilingTermWithArticle: joinWith(
      terms.map((item) => item.ceilingTermWithArticle),
      "ou",
    ),
    ceilingSimulationLabel: `${ceilingTerm.charAt(0).toUpperCase()}${ceilingTerm.slice(1)} (simulation)`,
  };
}

/** « une enchère plafond ou une offre plafond » : le terme avec l'article indéfini, pour un titre. */
export function ceilingTermIndefiniteText(open?: readonly FeeRegimeKey[]): string {
  return joinWith(
    termsOf(undefined, open).map((terms) => `une ${terms.ceilingTerm}`),
    "ou",
  );
}

/** « ventes au tribunal » : les ventes dont le calcul est ouvert, pour les phrases d'offre. */
export function ceilingVenueScopeText(open?: readonly FeeRegimeKey[]): string {
  return joinWith(
    termsOf(undefined, open).map((terms) => terms.venueScope),
    "et",
  );
}

/**
 * Chaque terme avec ses ventes : « enchère plafond (ventes au tribunal et ventes notariales à la
 * bougie) ou offre plafond (ventes notariales interactives) ». Les régimes qui partagent un terme
 * sont regroupés sous lui, dans l'ordre des clés.
 */
export function ceilingTermWithScopeText(open?: readonly FeeRegimeKey[]): string {
  const scopesByTerm = new Map<string, string[]>();
  for (const terms of termsOf(undefined, open)) {
    scopesByTerm.set(terms.ceilingTerm, [
      ...(scopesByTerm.get(terms.ceilingTerm) ?? []),
      terms.venueScope,
    ]);
  }
  return joinWith(
    [...scopesByTerm].map(([term, scopes]) => `${term} (${joinWith(scopes, "et")})`),
    "ou",
  );
}

/**
 * La note qui dit où le plafond existe (accueil du compte, « Mon dossier ») : les termes et les
 * ventes des régimes ouverts. `MonDemarrage` en garde une copie écrite en toutes lettres pour les
 * régimes ouverts par défaut (la page des favoris n'embarque pas ce vocabulaire) ; la page serveur
 * qui lit l'interrupteur passe ce texte à la place (`FeeRegimesProvider`).
 */
export function ceilingScopeNoteText(open?: readonly FeeRegimeKey[]): string {
  return `Le plafond (${ceilingTermText(open)}) n’existe que pour les ${ceilingVenueScopeText(open)} ; le statut vaut pour toute vente suivie.`;
}
