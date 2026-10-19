import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { propertyTypeLabel } from "@/lib/format";
import { saleDisplayTitle } from "@/lib/sale-title";
import { saleIsTribunalVenue } from "@/lib/sale-procedure";
import { FREE_ACCESS_LINE, freeAccessLine } from "@/lib/sale-unlocks";
import type { AuctionSale } from "@/lib/types";

/**
 * Textes d'une annonce partagés par la carte et la ligne du tableau : les deux vues doivent dire
 * la même chose, au même visiteur, avec les mêmes règles d'accès.
 */

/** Titre de carte : « Appartement », « Maison »… ; « Bien » quand le type n'est pas qualifié. */
export function cardTypeLabel(propertyType: string | null | undefined): string {
  const label = propertyTypeLabel(propertyType);
  return label === "Bien à qualifier" ? "Bien" : label;
}

/** « Département 33 » pour un code, le nom tel quel sinon (« Gironde »). */
export function departmentLabel(department: string | null | undefined): string | null {
  const value = department?.trim();
  if (!value) return null;
  return /^(\d{2,3}|2[AB])$/i.test(value) ? `Département ${value}` : value;
}

/**
 * Nom accessible de l'annonce (« Appartement à Bordeaux »). Un champ bloqué par la relecture IA
 * n'est jamais repris : « À confirmer » le remplace.
 */
export function listingTitle(
  sale: AuctionSale,
  options: {
    locked: boolean;
    aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
    aiReviewStatus: AiReviewRequestStatus;
  },
): string {
  const { locked, aiReviewProjections, aiReviewStatus } = options;
  const propertyTypeReview = getAiReviewFieldResult(
    aiReviewProjections,
    "property.property_type",
    aiReviewStatus,
  );
  const cityReview = getAiReviewFieldResult(aiReviewProjections, "property.city", aiReviewStatus);
  const guardedPropertyType = propertyTypeReview.blocked
    ? "À confirmer"
    : propertyTypeLabel(sale.property_type);
  const guardedCity = cityReview.blocked ? null : sale.city;
  return locked || propertyTypeReview.blocked || cityReview.blocked
    ? `${guardedPropertyType}${guardedCity ? ` à ${guardedCity}` : ""}`
    : saleDisplayTitle(sale);
}

/** Ligne d'accès par défaut d'une annonce que le visiteur peut ouvrir. */
export const LISTING_DETAIL_LINE = "Voir le détail";

/**
 * Ce que la fiche coûte au visiteur : un compte gratuit, un déblocage mensuel (ventes au tribunal
 * seulement) ou rien (« Voir le détail »). Offre de lancement active (`launchOffer`) : le visiteur
 * lit la mention de l'offre (compte gratuit = avantages Analyse, retirables sans préavis) à la place
 * de « 3 fiches détaillées par mois », pour toutes les ventes.
 */
export function listingAccessLine(
  sale: AuctionSale,
  access: { locked: boolean; analysisLocked: boolean; unlocked: boolean; launchOffer?: boolean },
): string {
  if (access.locked) {
    if (access.launchOffer) return freeAccessLine({ launchOffer: true });
    return saleIsTribunalVenue(sale) ? FREE_ACCESS_LINE : "Fiche complète avec un compte gratuit";
  }
  // Le déblocage n'est proposé que pour les ventes tenues au tribunal.
  if (access.analysisLocked && !access.unlocked && saleIsTribunalVenue(sale)) {
    return FREE_ACCESS_LINE;
  }
  return LISTING_DETAIL_LINE;
}
