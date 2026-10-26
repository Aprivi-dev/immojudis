// Conditions d'une vente notariale lues par le pipeline dans l'annonce des Notaires de France
// (`sale_conditions`, `services/data-pipeline/src/sources/notaires_extraction.py`) : ce dont le
// plafond a besoin pour distinguer une vente à la bougie d'une vente interactive et pour chiffrer
// ses frais. Module pur et léger, sans accès aux données ni import serveur.
//
// Où les lire (dans l'ordre) :
//  1. `sale.sale_conditions` : projection de la base (`app_private.public_sale_conditions`,
//     migration 20261103110000) servie au compte Analyse (`v_auction_sales_app`) et au compte qui a
//     débloqué la vente (`v_auction_sales_unlocked`), jamais au compte Découverte. Une liste
//     blanche de champs : ni prix d'adjudication, ni prix plancher, ni contact.
//  2. `raw_payload.source_property_features.sale_conditions` : la forme brute, présente seulement
//     là où `raw_payload` est lisible (traitements serveur).
//  3. le bloc projeté `source_blocks.listing_completeness` (forme non vérifiée, voir
//     `auction-cost-analysis.ts`).
import { asRecordOrNull } from "@/lib/guards";
import type { AuctionSale } from "@/lib/types";

/** Procédure notariale écrite par le pipeline : à la bougie (VAE) ou interactive (VNI). */
export type NotaryProcedure = "notarial_auction" | "online_tender";
/** Le mode de la vente : « auction » (à la bougie) ou « online » (interactive, par offres). */
export type NotarySaleMode = "auction" | "online";

/** Nature du prix publié comme prix de départ (`notaires_price_nature.py`). */
export type NotaryPriceNature = "mise_a_prix" | "displayed_price" | "first_offer_possible";

export type NotarySaleConditions = {
  procedure: NotaryProcedure | null;
  /** Type d'adjudication de la source (« VOLONTAIRE »…), en majuscules ; `null` : non lu. */
  adjudicationType: string | null;
  /**
   * Origine de la vente à la bougie (« ADJUDICATION », « LICITATION », « SAISIE »), en majuscules ;
   * `null` : non lue. Une licitation ou une saisie est une vente judiciaire.
   */
  origin: string | null;
  priceNature: NotaryPriceNature | null;
  /** « Première offre possible » d'une vente interactive. */
  firstOfferEur: number | null;
  /** Garantie à déposer lue dans l'annonce d'une vente à la bougie. */
  depositEur: number | null;
  /** Frais de publicité de l'acquéreur ; `null` : non indiqués (ou nuls). */
  advertisingFeesEur: number | null;
  /** Taux des honoraires de négociation, en part du prix (0,045 = 4,5 %) ; `null` : non lu. */
  negotiationFeeRate: number | null;
  /** Qui paie les honoraires de négociation ; `null` : non lu. */
  negotiationFeePayer: "ACQUEREUR" | "VENDEUR" | null;
  /** `true` : la surenchère est prévue ; `null` : non lu. */
  overbidAllowed: boolean | null;
};

const PRICE_NATURES: readonly NotaryPriceNature[] = [
  "mise_a_prix",
  "displayed_price",
  "first_offer_possible",
];

/**
 * Les seules origines qui ne signalent pas une vente judiciaire. Toute autre valeur lue (licitation,
 * saisie immobilière, ou un marqueur que le pipeline n'écrit pas encore) écarte le barème de
 * l'adjudication volontaire des notaires.
 */
const VOLUNTARY_ORIGINS: readonly string[] = ["ADJUDICATION"];

/** Taux de négociation plausibles (le pipeline écarte déjà ce qui sort de 1 % à 20 %). */
const NEGOTIATION_RATE_MIN = 0.01;
const NEGOTIATION_RATE_MAX = 0.2;

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** L'enregistrement `sale_conditions` de la vente, et la nature du prix, selon la source lue. */
function rawConditions(sale: AuctionSale): {
  record: Record<string, unknown>;
  priceNature: unknown;
} | null {
  const projected = asRecordOrNull(sale.sale_conditions);
  if (projected) return { record: projected, priceNature: projected.price_nature };
  const payload = asRecordOrNull(sale.raw_payload);
  const fromPayload = asRecordOrNull(
    asRecordOrNull(payload?.source_property_features)?.sale_conditions,
  );
  if (fromPayload) return { record: fromPayload, priceNature: payload?.starting_price_nature };
  const block = asRecordOrNull(
    asRecordOrNull(
      asRecordOrNull(sale.source_blocks?.listing_completeness)?.source_property_features,
    )?.sale_conditions,
  );
  if (!block) return null;
  if (block.state === undefined) return { record: block, priceNature: undefined };
  const claim = block.state === "observed" ? asRecordOrNull(block.value) : null;
  return claim ? { record: claim, priceNature: undefined } : null;
}

/**
 * Les conditions de la vente, ou `null` quand aucune n'est lisible (compte Découverte qui n'a pas
 * débloqué la vente, vente sans conditions écrites par le pipeline).
 */
export function readNotarySaleConditions(sale: AuctionSale): NotarySaleConditions | null {
  const found = rawConditions(sale);
  if (!found) return null;
  const { record, priceNature } = found;
  const procedure =
    record.procedure === "notarial_auction" || record.procedure === "online_tender"
      ? record.procedure
      : null;
  const adjudicationType =
    typeof record.adjudication_type === "string" && record.adjudication_type.trim()
      ? record.adjudication_type.trim().toUpperCase()
      : null;
  const origin =
    typeof record.origin === "string" && record.origin.trim()
      ? record.origin.trim().toUpperCase()
      : null;
  const payer =
    typeof record.negotiation_fee_payer === "string"
      ? record.negotiation_fee_payer.trim().toUpperCase()
      : "";
  const rate = positive(record.negotiation_fee_rate);
  return {
    procedure,
    adjudicationType,
    origin,
    priceNature: PRICE_NATURES.find((nature) => nature === priceNature) ?? null,
    firstOfferEur: positive(record.first_offer_eur),
    depositEur: positive(record.deposit_eur),
    advertisingFeesEur: positive(record.advertising_fees_eur),
    negotiationFeeRate:
      rate != null && rate >= NEGOTIATION_RATE_MIN && rate <= NEGOTIATION_RATE_MAX ? rate : null,
    negotiationFeePayer: payer === "ACQUEREUR" || payer === "VENDEUR" ? payer : null,
    overbidAllowed: typeof record.overbid_allowed === "boolean" ? record.overbid_allowed : null,
  };
}

/**
 * Le mode d'une vente notariale, d'après ce que le pipeline écrit ; `null` quand il est inconnu ou
 * contradictoire (pas de plafond dans ce cas) :
 *  - la procédure fait foi (`online_tender` : interactive ; `notarial_auction` : à la bougie) ;
 *  - à défaut, la nature du prix de départ : « première offre possible » désigne une vente
 *    interactive (elle ne publie pas de mise à prix), « mise à prix » une vente à la bougie ;
 *    « prix affiché » (liste, nature non précisée) n'en dit rien ;
 *  - une procédure et une nature qui se contredisent ne tranchent pas ;
 *  - une vente à la bougie dont le type d'adjudication est lu et n'est pas « volontaire » (par
 *    exemple judiciaire) n'a pas le barème de l'adjudication volontaire : mode inconnu ;
 *  - une vente dont l'origine est lue et n'est pas « adjudication » (licitation, saisie immobilière
 *    ou tout autre marqueur judiciaire) non plus : mode inconnu, quelle que soit la procédure.
 */
export function notarySaleMode(
  conditions: NotarySaleConditions | null | undefined,
): NotarySaleMode | null {
  if (!conditions) return null;
  const fromProcedure: NotarySaleMode | null =
    conditions.procedure === "online_tender"
      ? "online"
      : conditions.procedure === "notarial_auction"
        ? "auction"
        : null;
  const fromNature: NotarySaleMode | null =
    conditions.priceNature === "first_offer_possible"
      ? "online"
      : conditions.priceNature === "mise_a_prix"
        ? "auction"
        : null;
  if (conditions.origin && !VOLUNTARY_ORIGINS.includes(conditions.origin)) return null;
  if (fromProcedure && fromNature && fromProcedure !== fromNature) return null;
  const mode = fromProcedure ?? fromNature;
  if (
    mode === "auction" &&
    conditions.adjudicationType &&
    conditions.adjudicationType !== "VOLONTAIRE"
  ) {
    return null;
  }
  return mode;
}
