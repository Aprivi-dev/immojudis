import { z } from "zod";
import {
  SALE_WORKSPACE_STATUSES,
  SALE_WORKSPACE_STATUS_LABELS,
  type SaleWorkspaceStatus,
} from "@/lib/sale-workspace-shared";
import { MAX_SIMULATOR_AMOUNT_EUR } from "@/lib/simulator-limits";

/**
 * « Mon dossier » gratuit (point 68) : le statut personnel et l'enchère plafond d'une vente suivie.
 *
 * Les statuts sont ceux de l'espace de travail (`sale_workspaces.tracking_status`), repris tels
 * quels : même liste, mêmes libellés. Le stockage est gratuit (colonnes de `user_favorites`) ; le
 * calculateur de l'enchère plafond et les outils d'analyse restent soumis à leurs droits.
 */
export const FAVORITE_DOSSIER_STATUSES = SALE_WORKSPACE_STATUSES;
export type FavoriteDossierStatus = SaleWorkspaceStatus;

export function favoriteDossierStatusLabel(status: FavoriteDossierStatus): string {
  return SALE_WORKSPACE_STATUS_LABELS[status];
}

/** Une valeur inconnue en base s'affiche comme absente : on ne la remplace par aucun statut. */
export function normalizeFavoriteDossierStatus(value: unknown): FavoriteDossierStatus | null {
  return typeof value === "string" &&
    (FAVORITE_DOSSIER_STATUSES as readonly string[]).includes(value)
    ? (value as FavoriteDossierStatus)
    : null;
}

export const favoriteDossierInputSchema = z
  .object({
    saleId: z.string().guid(),
    /** `null` efface le statut ; absent : le statut n'est pas modifié. */
    personalStatus: z.enum(FAVORITE_DOSSIER_STATUSES).nullable().optional(),
    /**
     * `null` efface le plafond ; absent : le plafond n'est pas modifié. En euros entiers, au moins
     * 1 € : un plafond de 0 € n'est pas une enchère (on efface le plafond avec `null`).
     */
    bidCeilingEur: z
      .number()
      .finite()
      .min(1, { message: "L’enchère plafond doit être supérieure à 0 €." })
      .max(MAX_SIMULATOR_AMOUNT_EUR)
      .transform((value) => Math.round(value))
      .nullable()
      .optional(),
  })
  .refine((value) => value.personalStatus !== undefined || value.bidCeilingEur !== undefined, {
    message: "Aucune modification demandée.",
  });

export type FavoriteDossierInput = z.input<typeof favoriteDossierInputSchema>;
export type FavoriteDossierPayload = z.output<typeof favoriteDossierInputSchema>;

export const favoriteDossierQuerySchema = z.object({ saleId: z.string().guid() });

export type FavoriteDossier = {
  saleId: string;
  /** La vente est dans les favoris du compte : sans cela, aucun dossier à lire ni à écrire. */
  followed: boolean;
  personalStatus: FavoriteDossierStatus | null;
  personalStatusUpdatedAt: string | null;
  bidCeilingEur: number | null;
  bidCeilingSavedAt: string | null;
};

export type FavoriteDossierResponse = { dossier: FavoriteDossier };

export type FavoriteDossierRow = {
  sale_id: string;
  personal_status: string | null;
  personal_status_updated_at: string | null;
  bid_ceiling_eur: number | null;
  bid_ceiling_saved_at: string | null;
};

export function toFavoriteDossier(row: FavoriteDossierRow): FavoriteDossier {
  return {
    saleId: row.sale_id,
    followed: true,
    personalStatus: normalizeFavoriteDossierStatus(row.personal_status),
    personalStatusUpdatedAt: row.personal_status_updated_at,
    bidCeilingEur: typeof row.bid_ceiling_eur === "number" ? row.bid_ceiling_eur : null,
    bidCeilingSavedAt: row.bid_ceiling_saved_at,
  };
}

const BID_CEILING_FORMAT = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

/** Un montant à l'écran, séparateurs français (« 185 000 »), sans symbole : le « € » est à côté. */
export function formatBidCeilingInput(amount: number): string {
  return BID_CEILING_FORMAT.format(amount);
}

export type BidCeilingInputResult = { ok: true; value: number } | { ok: false; message: string };

/**
 * Lit le montant saisi dans le champ « Mon enchère plafond » : espaces (dont insécables) et « € »
 * ignorés, virgule ou point décimal. Un point suivi de trois chiffres (« 185.000 ») est refusé plutôt
 * que lu 185 € : mieux vaut une erreur qu'un plafond divisé par mille. Mêmes bornes que le schéma
 * du serveur (au moins 1 €, au plus `MAX_SIMULATOR_AMOUNT_EUR`).
 */
export function parseBidCeilingInput(raw: string): BidCeilingInputResult {
  const cleaned = raw.replace(/[\s\u00a0\u202f€]/g, "").replace(",", ".");
  if (cleaned === "") {
    return { ok: false, message: "Saisissez un montant en euros, par exemple 185 000." };
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    return {
      ok: false,
      message: "Saisissez un montant en euros, en chiffres seulement, par exemple 185 000.",
    };
  }
  const value = Math.round(Number(cleaned));
  if (value < 1) {
    return { ok: false, message: "L’enchère plafond doit être supérieure à 0 €." };
  }
  if (value > MAX_SIMULATOR_AMOUNT_EUR) {
    return {
      ok: false,
      message: `Le montant ne peut pas dépasser ${formatBidCeilingInput(MAX_SIMULATOR_AMOUNT_EUR)} €.`,
    };
  }
  return { ok: true, value };
}

export function emptyFavoriteDossier(saleId: string): FavoriteDossier {
  return {
    saleId,
    followed: false,
    personalStatus: null,
    personalStatusUpdatedAt: null,
    bidCeilingEur: null,
    bidCeilingSavedAt: null,
  };
}
