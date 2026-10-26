import { FLOOD_EXPOSED_SHORT } from "@/lib/pepite-flood-copy";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { formatDate, formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { parisDateKey } from "@/lib/sale-countdown";
import { saleDisplayTitle } from "@/lib/sale-title";
import { feeRegimeKeysForVenue, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { getSaleProcedure } from "@/lib/sale-procedure";
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
 * Ligne courte de chaque carte pendant l'essai à l'inscription (cartes d'un visiteur sans compte).
 * Les règles de l'essai ne sont écrites qu'une fois, dans la bannière repliable au-dessus de la liste
 * (`LaunchOfferListBanner`) : répétées sur 24 cartes, elles noyaient la liste.
 */
export const LISTING_LAUNCH_OFFER_LINE = "Inscription gratuite : 7 jours d’offre Analyse";

/** Mention d'une cession domaniale dont la source ne publie aucun prix. */
export const STATE_PRICE_NOT_PUBLISHED = "Prix non publié";

/** Cession domaniale (`venueType` « state ») sans prix publié : `starting_price_eur` absent ou nul. */
export function stateSaleWithoutPrice(sale: AuctionSale): boolean {
  // Le prix d'abord : une vente qui en publie un n'a pas besoin du type de vente.
  return (
    !(sale.starting_price_eur != null && sale.starting_price_eur > 0) &&
    getSaleProcedure(sale).venueType === "state"
  );
}

/**
 * Le prix d'une carte de résultat : « Prix non publié » pour une cession domaniale sans prix, sinon
 * la mise à prix (ou « Prix non communiqué » quand elle manque).
 */
export function listingPriceText(sale: AuctionSale): string {
  return stateSaleWithoutPrice(sale)
    ? STATE_PRICE_NOT_PUBLISHED
    : formatStartingPrice(sale.starting_price_eur);
}

/**
 * Un régime de frais est ouvert pour ce type de vente (le tribunal, la bougie et la vente
 * interactive d'une vente notariale) : le déblocage ouvre son plafond. Les cartes ignorent le
 * mode d'une vente notariale, que seules les conditions de la vente donnent.
 */
function ceilingOpenFor(sale: AuctionSale, open?: readonly FeeRegimeKey[]): boolean {
  return feeRegimeKeysForVenue(getSaleProcedure(sale).venueType, open).length > 0;
}

/**
 * Ce que la fiche coûte au visiteur : un compte gratuit, un déblocage mensuel (ventes dont le
 * plafond est ouvert, le tribunal aujourd'hui) ou rien (« Voir le détail »). Offre de lancement active (`launchOffer`) : la ligne
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
    /** Régimes de frais ouverts (`openFeeRegimesFromEnv`) ; absent : tous ceux qui sont définis. */
    openFeeRegimes?: readonly FeeRegimeKey[];
  },
): string {
  if (access.verifying || access.launchPending) return LISTING_DETAIL_LINE;
  if (access.locked) {
    if (access.launchOffer) return LISTING_LAUNCH_OFFER_LINE;
    return ceilingOpenFor(sale, access.openFeeRegimes)
      ? FREE_ACCESS_LINE
      : "Fiche complète avec un compte gratuit";
  }
  // Le déblocage n'est proposé que pour les ventes dont le plafond est ouvert (régime de frais).
  if (access.analysisLocked && !access.unlocked && ceilingOpenFor(sale, access.openFeeRegimes)) {
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

/**
 * Nom accessible du lien qui couvre une carte (ou une ligne de tableau) : « Voir <titre> » ne
 * distingue pas deux annonces de la même ville, la liste de liens du lecteur d'écran en serait
 * pleine d'homonymes. Le prix, ou à défaut la date, les sépare. Une valeur masquée par la relecture
 * (`blocked`) n'entre jamais dans le nom : il ne dit que ce que la carte montre.
 */
export function listingLinkLabel(
  sale: AuctionSale,
  title: string,
  blocked: { price?: boolean; date?: boolean; pepite?: boolean; floodExposed?: boolean } = {},
): string {
  const label = baseListingLinkLabel(sale, title, blocked);
  // Le repère « Pépite » entre dans le nom du lien : un lecteur d'écran l'annonce sans ouvrir la carte. Un bien
  // dans le périmètre d'un PPRi le dit aussi (mention courte, sans montant).
  if (!blocked.pepite) return label;
  return blocked.floodExposed ? `${label}, pépite. ${FLOOD_EXPOSED_SHORT}` : `${label}, pépite`;
}

function baseListingLinkLabel(
  sale: AuctionSale,
  title: string,
  blocked: { price?: boolean; date?: boolean },
): string {
  if (!blocked.price && sale.starting_price_eur != null && sale.starting_price_eur > 0) {
    // Prix positif : le texte est celui de la mise à prix, jamais « Prix non publié ».
    return `Voir ${title}, ${formatStartingPrice(sale.starting_price_eur)}`;
  }
  if (!blocked.date && sale.sale_date) {
    const date = listingDateLabel(sale);
    return `Voir ${title}, ${date === PAST_SALE_LABEL ? "vente passée" : `vente le ${date}`}`;
  }
  return `Voir ${title}`;
}
