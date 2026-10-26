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

/**
 * Indépendance du repère « Pépite » (proposition n° 21) : aucune rémunération ne peut obtenir ni améliorer une
 * pépite. La même phrase ferme les deux variantes de la mention (encart actif et période d'essai), mais
 * seulement quand le repère est ouvert au public (`pepites`) : tant qu'il ne l'est pas, l'encart ne parle pas
 * d'un repère que le visiteur ne voit pas.
 */
export const PEPITE_INDEPENDENCE_SENTENCE = "Cet encart est sans lien avec le repère Pépite.";

/** Mention affichée dans l'encart : qui paie, et ce que l'encart n'est pas. */
export function sponsoredPlacementDisclosure(
  placement: LawyerPlacementKind,
  options: { pepites?: boolean } = {},
): string {
  const payer =
    placement === "trial"
      ? "Ce cabinet bénéficie actuellement d’une période d’essai gratuite de cette offre payante."
      : "Ce cabinet rémunère Immojudis pour apparaître ici.";
  return `${payer} Il ne s’agit ni d’une recommandation, ni d’une notation, ni d’une garantie de résultat, et l’ordre des annonces n’en est pas modifié.${options.pepites ? ` ${PEPITE_INDEPENDENCE_SENTENCE}` : ""}`;
}

export const LAWYER_RANKING_LINK_LABEL = "Comment sont classés les avocats ?";
/** Ancre de la section « Comment sont classés les avocats ? » de /avocats (`id` de son titre). */
export const LAWYER_RANKING_HREF = "/avocats#lawyer-ranking-title";

/**
 * Parcours des cabinets qui veulent être mis en avant : le formulaire de contact, sujet « avocat »
 * déjà choisi (il n'existe pas d'autre inscription). Utilisé par l'encart de /sales et par /avocats.
 */
export const LAWYER_CONTACT_HREF = "/contact?sujet=avocat";

/** Libellé de l'encart de repli qui invite les avocats à présenter leur cabinet (aucune publicité). */
export const LAWYER_INVITATION_LABEL = "Pour les avocats · Immojudis";
