/**
 * Types de voie reconnus dans une adresse française : la seule liste côté application. Les sources
 * d'adresse (nettoyage d'affichage, identité d'actif, vue aérienne) s'y appuient au lieu de recopier
 * chacune la leur. Les morceaux sont des fragments d'expression régulière (accents facultatifs :
 * « allée » et « allee »), à utiliser avec le drapeau `i`.
 *
 * Le pipeline Python a ses propres copies (`normalize.py`, `listing_location.py`, `sources/*.py`…) :
 * elles ne sont pas reliées à cette liste.
 */
const STREET_TYPE_WORDS = [
  "rue",
  "avenue",
  "boulevard",
  "chemin",
  "route",
  "impasse",
  "all[ée]e",
  "place",
  "quai",
  "cours",
  "faubourg",
  "passage",
  "square",
  "voie",
  "sentier",
  "rond-point",
  "r[ée]sidence",
  "hameau",
  "lotissement",
  "cit[ée]",
  "villa",
  "mail",
  "esplanade",
  "promenade",
  "parvis",
  "mont[ée]e",
  "traverse",
  "clos",
  "lieu-dit",
  "chauss[ée]e",
  "ruelle",
  "venelle",
] as const;

/** Abréviations usuelles (« 12 av. Foch », « 5 rte de Lyon », « 3 bd Gambetta »). */
const STREET_TYPE_ABBREVIATIONS = [
  "av\\.?",
  "bd\\.?",
  "bld\\.?",
  "bvd\\.?",
  "rte\\.?",
  "imp\\.?",
  "pl\\.?",
  "fg\\.?",
  "ch\\.",
] as const;

/**
 * Alternance des types de voie, sans groupe capturant autour (à entourer par l'appelant). Sans les
 * abréviations, elle ne contient que des mots entiers : à préférer pour recoller du texte (« rueFoo »),
 * où « av » ou « pl » couperaient « avoir » ou « plage ».
 */
export function streetTypePattern({ abbreviations = true }: { abbreviations?: boolean } = {}) {
  return [...STREET_TYPE_WORDS, ...(abbreviations ? STREET_TYPE_ABBREVIATIONS : [])].join("|");
}

/**
 * Fin d'un type de voie : un pluriel éventuel, puis pas de lettre. `\b` ne convient pas, car il ne
 * voit pas les lettres accentuées comme des lettres (« cité » n'y finit jamais un mot).
 */
export const STREET_TYPE_END = "s?(?![A-Za-zÀ-ÿ])";
