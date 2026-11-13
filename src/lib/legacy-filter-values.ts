/**
 * Anciennes valeurs des filtres « Occupation » (`free`) et « Type de bien » (`garage`), remplacées par
 * les codes de la base (`auction_sales.occupancy_status`, `auction_sales.property_type`). Des alertes
 * enregistrées et des adresses partagées les portent encore : elles sont lues à l'entrée, jamais
 * réécrites en base. Une recherche du catalogue (page `/sales`, routes `/api/sales/feed`, `export`,
 * `statistics` et `/api/catalogue/preview`) passe par `catalogueSearch` ; les critères d'une alerte
 * passent par `currentFilterValue` à leur lecture (`alerts.ts`, `alert-criteria-labels.ts`).
 */
const LEGACY_FILTER_VALUES: Readonly<Record<string, string>> = {
  free: "vacant",
  garage: "parking",
};

/** La valeur actuelle d'un filtre : son code de la base pour une ancienne valeur, sinon elle-même. */
export function currentFilterValue(value: string): string {
  return LEGACY_FILTER_VALUES[value.trim().toLowerCase()] ?? value;
}
