import { z } from "zod";
import {
  FAVORITE_DOSSIER_STATUSES,
  normalizeFavoriteDossierStatus,
  type FavoriteDossierStatus,
} from "@/lib/favorite-dossier-shared";
import { MAX_SIMULATOR_AMOUNT_EUR } from "@/lib/simulator-limits";
import { redactPersonalText } from "@/lib/personal-data-filter";
import { surenchereWindow, type SurenchereWindow } from "@/lib/surenchere-window";

/**
 * Instantané d'une vente suivie dont l'audience est passée (point 70). La base le garde à la purge
 * de la vente (`user_followed_sale_snapshots`, migration 20261028190100), 6 mois au plus.
 *
 * Une valeur absente reste absente : un prix d'adjudication non publié (ou non copié, voir
 * `result.priceWithheld`) n'est jamais remplacé par une estimation.
 */
export type FollowedSaleSnapshotResult = {
  /** « adjudicated » : la vente est connue comme adjugée ; « unknown » : le résultat n'est pas connu. */
  status: "adjudicated" | "unknown";
  priceEur: number | null;
  /** Source de la fiche qui publiait le prix, présente avec le prix seulement. */
  priceSource: string | null;
  /** Un prix était publié mais il est réservé à l'offre Analyse : il n'a pas été copié pour ce compte. */
  priceWithheld: boolean;
};

export type FollowedSaleSnapshot = {
  id: string;
  saleId: string;
  capturedAt: string;
  expiresAt: string;
  title: string | null;
  city: string | null;
  department: string | null;
  propertyType: string | null;
  tribunalName: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  lawyerName: string | null;
  /** Source de la fiche (nom de la source principale), pas celle du résultat. */
  sourceName: string | null;
  result: FollowedSaleSnapshotResult;
  personalStatus: FavoriteDossierStatus | null;
  bidCeilingEur: number | null;
  /**
   * Prix final de l'adjudication noté par la personne (bilan, n° 94), facultatif, seulement pour une
   * vente « Remporté » ou « Non remporté ». Distinct de `result.priceEur`, le prix publié sur la fiche.
   */
  finalPriceEur: number | null;
  /** Type et cadre juridique de la vente : de quoi savoir si l'échéancier indicatif s'applique. */
  saleVenueType: string | null;
  saleLegalFramework: string | null;
  /** Fenêtre de surenchère, calculée à la lecture à partir de la date d'audience. */
  surenchere: SurenchereWindow;
};

export type FollowedSaleSnapshotsResponse = { snapshots: FollowedSaleSnapshot[] };
export type FollowedSaleSnapshotResponse = { snapshot: FollowedSaleSnapshot };
export type FollowedSaleSnapshotDeleteResponse = { ok: true; removed: boolean };

export const followedSaleSnapshotDeleteSchema = z.object({ id: z.string().guid() });

/**
 * Ce que la personne peut modifier sur un instantané (bilan, n° 94) : son statut et le prix final de
 * l'adjudication. `null` efface ; un champ absent n'est pas touché. Le prix final, en euros entiers
 * (au moins 1 €, mêmes bornes que le plafond), n'a de sens que pour « Remporté » ou « Non remporté ».
 */
export const followedSaleSnapshotUpdateSchema = z
  .object({
    id: z.string().guid(),
    personalStatus: z.enum(FAVORITE_DOSSIER_STATUSES).nullable().optional(),
    finalPriceEur: z
      .number()
      .finite()
      .min(1, { message: "Le prix final doit être supérieur à 0 €." })
      .max(MAX_SIMULATOR_AMOUNT_EUR)
      .transform((value) => Math.round(value))
      .nullable()
      .optional(),
  })
  .refine((value) => value.personalStatus !== undefined || value.finalPriceEur !== undefined, {
    message: "Aucune modification demandée.",
  });

export type FollowedSaleSnapshotUpdate = z.input<typeof followedSaleSnapshotUpdateSchema>;
export type FollowedSaleSnapshotUpdatePayload = z.output<typeof followedSaleSnapshotUpdateSchema>;

export type FollowedSaleSnapshotRow = {
  id: string;
  sale_id: string;
  captured_at: string;
  expires_at: string;
  title: string | null;
  city: string | null;
  department: string | null;
  property_type: string | null;
  tribunal_name: string | null;
  sale_venue_type: string | null;
  sale_legal_framework: string | null;
  starting_price_eur: number | null;
  sale_date: string | null;
  lawyer_name: string | null;
  source_name: string | null;
  result_status: string;
  adjudication_price_eur: number | null;
  adjudication_price_source: string | null;
  adjudication_price_withheld: boolean;
  personal_status: string | null;
  bid_ceiling_eur: number | null;
  final_price_eur: number | null;
};

export function toFollowedSaleSnapshot(
  row: FollowedSaleSnapshotRow,
  now = new Date(),
): FollowedSaleSnapshot {
  const adjudicated = row.result_status === "adjudicated";
  const priceEur =
    typeof row.adjudication_price_eur === "number" && row.adjudication_price_eur > 0
      ? row.adjudication_price_eur
      : null;
  return {
    id: row.id,
    saleId: row.sale_id,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    // Le titre vient de la fiche : un nom de particulier qui y figurerait n'a rien à faire dans l'espace du compte.
    title: redactPersonalText(row.title) ?? null,
    city: row.city,
    department: row.department,
    propertyType: row.property_type,
    tribunalName: row.tribunal_name,
    startingPriceEur: row.starting_price_eur,
    saleDate: row.sale_date,
    lawyerName: row.lawyer_name,
    sourceName: row.source_name,
    result: {
      status: adjudicated ? "adjudicated" : "unknown",
      priceEur,
      // Pas de source sans prix : une valeur absente reste absente.
      priceSource: priceEur !== null ? row.adjudication_price_source : null,
      priceWithheld: priceEur === null && row.adjudication_price_withheld === true,
    },
    personalStatus: normalizeFavoriteDossierStatus(row.personal_status),
    bidCeilingEur: typeof row.bid_ceiling_eur === "number" ? row.bid_ceiling_eur : null,
    finalPriceEur:
      typeof row.final_price_eur === "number" && row.final_price_eur > 0
        ? row.final_price_eur
        : null,
    saleVenueType: row.sale_venue_type,
    saleLegalFramework: row.sale_legal_framework,
    surenchere: surenchereWindow({
      saleDate: row.sale_date,
      venueType: row.sale_venue_type,
      adjudicationConfirmed: adjudicated,
      now,
    }),
  };
}
