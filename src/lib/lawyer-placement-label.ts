/**
 * Vocabulaire unique des mises en avant d'avocats (encart de /sales, cartes de /avocats, page
 * « Comment sont classées les annonces ? »). Une mise en avant est une publicité payée par le
 * cabinet pour une zone géographique ; elle ne modifie jamais l'ordre des annonces.
 */
export type LawyerPlacementKind = "active" | "trial" | null | undefined;

export const SPONSORED_LABEL = "Publicité · Sponsorisé";
export const SPONSORED_TRIAL_LABEL = "Publicité · Sponsorisé (période d’essai gratuite)";

export function sponsoredPlacementLabel(placement: LawyerPlacementKind): string {
  return placement === "trial" ? SPONSORED_TRIAL_LABEL : SPONSORED_LABEL;
}

/** Mention affichée dans l'encart : qui paie, et ce que l'encart n'est pas. */
export function sponsoredPlacementDisclosure(placement: LawyerPlacementKind): string {
  const payer =
    placement === "trial"
      ? "Ce cabinet bénéficie actuellement d’une période d’essai gratuite de cette offre payante."
      : "Ce cabinet rémunère Immojudis pour apparaître ici.";
  return `${payer} Il ne s’agit ni d’une recommandation, ni d’une notation, ni d’une garantie de résultat, et l’ordre des annonces n’en est pas modifié.`;
}

export const LAWYER_RANKING_LINK_LABEL = "Comment sont classés les avocats ?";
/** Ancre de la section « Comment sont classés les avocats ? » de /avocats (`id` de son titre). */
export const LAWYER_RANKING_HREF = "/avocats#lawyer-ranking-title";
