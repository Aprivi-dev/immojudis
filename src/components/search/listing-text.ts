import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { formatDate, propertyTypeLabel } from "@/lib/format";
import { parisDateKey } from "@/lib/sale-countdown";
import { saleDisplayTitle } from "@/lib/sale-title";
import { saleIsTribunalVenue } from "@/lib/sale-procedure";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";
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
 * Ligne courte de chaque carte pendant l'offre de lancement. Le texte complet (avec la réserve
 * « retirables sans préavis ») n'est écrit qu'une fois, dans la bannière repliable au-dessus de la
 * liste (`LaunchOfferListBanner`) : répété sur 24 cartes, il noyait la liste.
 */
export const LISTING_LAUNCH_OFFER_LINE = "Compte gratuit : avantages Analyse (offre de lancement)";

/**
 * Ce que la fiche coûte au visiteur : un compte gratuit, un déblocage mensuel (ventes au tribunal
 * seulement) ou rien (« Voir le détail »). Offre de lancement active (`launchOffer`) : la ligne
 * courte de l'offre (`LISTING_LAUNCH_OFFER_LINE`) à la place de « 3 fiches détaillées par mois »,
 * pour toutes les ventes. Tant que l'état de l'offre est inconnu (`launchPending`, rendu serveur
 * compris), la ligne reste neutre : aucune promesse de quota qui serait remplacée à l'hydratation.
 */
export function listingAccessLine(
  sale: AuctionSale,
  access: {
    locked: boolean;
    analysisLocked: boolean;
    unlocked: boolean;
    launchOffer?: boolean;
    /** L'état de l'offre de lancement n'est pas encore lu (`useLaunchOffer().pending`). */
    launchPending?: boolean;
    /**
     * Compte reconnu dont les droits sont en cours de vérification (la liste publique reste
     * affichée, donc `locked`) : la ligne reste neutre. « Gratuit, sans carte bancaire » et
     * « Fiche complète avec un compte gratuit » s'adressent à un visiteur sans compte.
     */
    verifying?: boolean;
  },
): string {
  if (access.verifying || access.launchPending) return LISTING_DETAIL_LINE;
  if (access.locked) {
    if (access.launchOffer) return LISTING_LAUNCH_OFFER_LINE;
    return saleIsTribunalVenue(sale) ? FREE_ACCESS_LINE : "Fiche complète avec un compte gratuit";
  }
  // Le déblocage n'est proposé que pour les ventes tenues au tribunal.
  if (access.analysisLocked && !access.unlocked && saleIsTribunalVenue(sale)) {
    return FREE_ACCESS_LINE;
  }
  return LISTING_DETAIL_LINE;
}

/** Libellé d'une vente dont le jour est passé (heure de Paris) : jamais une date de 2020 en clair. */
export const PAST_SALE_LABEL = "Vente passée";

/**
 * Date affichée sur une carte : la date de la vente, ou « Vente passée » quand ce jour est derrière
 * nous. La comparaison se fait au jour près (Paris), comme le compte à rebours : une vente
 * d'aujourd'hui garde sa date jusqu'à minuit. `now` est injectable pour les tests.
 */
export function listingDateLabel(sale: AuctionSale, now: Date = new Date()): string {
  const date = sale.sale_date ? new Date(sale.sale_date) : null;
  if (date && Number.isFinite(date.getTime()) && parisDateKey(date) < parisDateKey(now)) {
    return PAST_SALE_LABEL;
  }
  return formatDate(sale.sale_date);
}
