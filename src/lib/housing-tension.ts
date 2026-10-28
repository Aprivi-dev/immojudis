// Zonage « zone tendue » (TLV) d'une commune : type et textes, SANS accès aux données (module léger, que la fiche
// charge à la demande). La lecture de la table `commune_housing_tension` est dans `rent-reference.server.ts`
// (seul fichier autorisé à la nommer). C'est un fait de zonage : il n'entre dans aucun calcul de rendement.

/** Zonage après le décret n° 2025-1267 du 22 décembre 2025 (colonne `zoning_post_decree`). */
export type HousingZoning = "tendue" | "touristique_tendue" | "non_tendue";
export const HOUSING_ZONINGS: readonly HousingZoning[] = [
  "tendue",
  "touristique_tendue",
  "non_tendue",
];

export type HousingTension = {
  /** Code INSEE de la commune « parent » (75056, 69123, 13055 pour les arrondissements). */
  communeCode: string;
  zoning: HousingZoning;
  /** Texte du décret, tel que la source le donne. */
  decreeReference: string | null;
  /** Date de publication du fichier sur data.gouv.fr (ISO `AAAA-MM-JJ`). */
  sourceUpdatedOn: string | null;
  sourceUrl: string | null;
};

/**
 * Mention de source du zonage, telle que le dossier d'exploitation l'a rédigée pour l'affichage
 * (`docs/operations/donnees-de-reference-loyers-et-zonage.md`) ; `updatedOn` : la date de mise à jour du fichier
 * (« 30 décembre 2025 »), sinon la mention n'en porte pas. Licence Ouverte 2.0.
 */
export function tensionAttribution(updatedOn: string | null): string {
  return `Source : ministère de la Transition écologique, liste des communes selon le zonage TLV (article 232 du code général des impôts)${updatedOn ? `, mise à jour du ${updatedOn}` : ""} ; Licence Ouverte 2.0.`;
}

/** La ligne neutre de la fiche. */
export function housingTensionLine(zoning: HousingZoning): string {
  switch (zoning) {
    case "tendue":
      return "Commune en zone tendue (TLV).";
    case "touristique_tendue":
      return "Commune en zone touristique et tendue (TLV).";
    case "non_tendue":
      return "Commune hors zone tendue (TLV).";
  }
}

/** Précision qui accompagne la ligne : un fait de zonage, jamais un argument de rendement. */
export const HOUSING_TENSION_NOTE =
  "Information de zonage : elle n’entre pas dans le calcul du rendement et ne dit rien du loyer du bien.";
