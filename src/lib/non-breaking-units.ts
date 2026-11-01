const NO_BREAK_SPACE = " ";

/**
 * Un nombre suivi de son unité : « 59 € TTC / mois », « 45 m² », « 3 200 €/m² », « 12 % ». Le
 * chiffre, l'espace et l'unité ne se séparent pas en fin de ligne. Les montants que fabrique
 * `formatPrice` (Intl) l'ont déjà ; ce sont les libellés écrits à la main et les titres qui en ont
 * besoin. L'unité ne doit pas être suivie d'une lettre (« 2 m²x » reste tel quel).
 */
const NUMBER_UNIT = /(\d) (€\/m²|€\/m2|€|m²|m2|%)(?![\p{L}\p{N}²])/gu;
/** « 59 € TTC » : le sigle des taxes reste collé au montant. */
const AMOUNT_TAX = /(€|%) (TTC|HT)(?![\p{L}\p{N}])/gu;

export function nonBreakingUnits(text: string): string {
  return text
    .replace(NUMBER_UNIT, `$1${NO_BREAK_SPACE}$2`)
    .replace(AMOUNT_TAX, `$1${NO_BREAK_SPACE}$2`);
}
