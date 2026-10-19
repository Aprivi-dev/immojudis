import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { parisMonthWindow } from "@/lib/paris-month";
import { DETAIL_VIEW, UNLOCKED_VIEW } from "@/lib/sale-views";
import type { SaleUnlockResult, SaleUnlockStatus, UnlockedSaleSummary } from "@/lib/sale-unlocks";

/**
 * « 3 déblocages par mois » côté serveur. Tout passe par les RPC `unlock_sale` et
 * `get_sale_unlock_status` avec le client de l'utilisateur : la base identifie le compte par
 * `auth.uid()`, applique le quota du mois de Paris sous verrou et ne lit que ses propres lignes.
 * Aucun appel Stripe sur ce chemin.
 */

const instantSchema = z
  .string()
  .refine((value) => Number.isFinite(new Date(value).getTime()), "Date invalide.")
  .transform((value) => new Date(value).toISOString());

const rpcStatusSchema = z.object({
  sale_id: z.string().nullable().optional(),
  unlocked: z.boolean(),
  // Absent d'une base dont la migration `unlockable` n'est pas appliquée : comme avant, « oui ».
  unlockable: z.boolean().optional(),
  analysis_access: z.boolean(),
  limit: z.number().int().nullable(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative().nullable(),
  period_start: instantSchema,
  period_end: instantSchema,
});

const rpcResultSchema = rpcStatusSchema.extend({
  already_unlocked: z.boolean(),
  consumed: z.boolean(),
});

function toStatus(row: z.infer<typeof rpcStatusSchema>): SaleUnlockStatus {
  return {
    saleId: row.sale_id ?? null,
    unlocked: row.unlocked,
    unlockable: row.unlockable ?? true,
    analysisAccess: row.analysis_access,
    limit: row.limit,
    used: row.used,
    remaining: row.remaining,
    periodStart: row.period_start,
    resetsAt: row.period_end,
  };
}

/** Lit la réponse JSON de `get_sale_unlock_status`. */
export function parseSaleUnlockStatus(raw: unknown): SaleUnlockStatus {
  return toStatus(rpcStatusSchema.parse(raw));
}

/** Lit la réponse JSON de `unlock_sale`. */
export function parseSaleUnlockResult(raw: unknown): SaleUnlockResult {
  const row = rpcResultSchema.parse(raw);
  return { ...toStatus(row), alreadyUnlocked: row.already_unlocked, consumed: row.consumed };
}

/** Quota du mois atteint : porte l'état du compteur pour que la fiche l'explique. */
export class SaleUnlockQuotaError extends Error {
  readonly status: SaleUnlockStatus;

  constructor(status: SaleUnlockStatus) {
    super("Vous avez utilisé tous vos déblocages de ce mois-ci.");
    this.name = "SaleUnlockQuotaError";
    this.status = status;
  }
}

type RpcError = { code?: string; message?: string; details?: string | null } | null;

/** Fonction de base absente (migration pas encore appliquée) : le déblocage n'existe pas encore. */
function isMissingFunction(error: RpcError): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/**
 * Situation d'une base qui n'a pas encore le déblocage (déploiement échelonné) : rien n'est
 * débloqué ni débloquable, et aucun quota n'est annoncé. La fiche reste la fiche gratuite, sans
 * bandeau d'erreur : ce n'est pas une panne.
 */
function unavailableSaleUnlockStatus(saleId: string | null): SaleUnlockStatus {
  const { periodStart, periodEnd } = parisMonthWindow();
  return {
    saleId,
    unlocked: false,
    unlockable: false,
    analysisAccess: false,
    limit: null,
    used: 0,
    remaining: null,
    periodStart,
    resetsAt: periodEnd,
  };
}

/**
 * Situation du compte pour ce mois et, avec `saleId`, état de déblocage de cette vente. Une base
 * sans la fonction répond « rien n'est débloquable », jamais une erreur (même repli que
 * `hasUnlockedSale`).
 */
export async function getSaleUnlockStatus(
  auth: SupabaseAuthContext,
  saleId: string | null = null,
): Promise<SaleUnlockStatus> {
  const { data, error } = await auth.supabase.rpc(
    "get_sale_unlock_status",
    saleId ? { p_sale_id: saleId } : {},
  );
  if (error) {
    if (isMissingFunction(error)) return unavailableSaleUnlockStatus(saleId);
    throw error;
  }
  return parseSaleUnlockStatus(data);
}

const unlockedSaleRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  city: z.string().nullable(),
  department: z.string().nullable(),
  property_type: z.string().nullable(),
  starting_price_eur: z.number().nullable(),
  sale_date: z.string().nullable(),
  status: z.string().nullable(),
});

const UNLOCKED_SALE_COLUMNS =
  "id,title,city,department,property_type,starting_price_eur,sale_date,status";
/** Au plus 3 par mois et 24 mois de validité : 72 au maximum, la marge couvre un compte Analyse passé. */
const UNLOCKED_SALES_LIST_LIMIT = 100;

/**
 * Les ventes que le compte a débloquées et qui sont toujours en ligne, la plus proche d'abord. La
 * vue `v_auction_sales_unlocked` ne liste que les ventes débloquées du compte connecté (limite de
 * 24 mois et vente en ligne comprises) : aucune autre vente n'est lisible par ce chemin. Une base
 * sans la vue (déploiement échelonné) répond une liste vide.
 */
export async function listUnlockedSales(auth: SupabaseAuthContext): Promise<UnlockedSaleSummary[]> {
  const { data, error } = await auth.supabase
    .from(UNLOCKED_VIEW as typeof DETAIL_VIEW)
    .select(UNLOCKED_SALE_COLUMNS)
    .order("sale_date", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(UNLOCKED_SALES_LIST_LIMIT);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205") return [];
    throw error;
  }
  return z
    .array(unlockedSaleRowSchema)
    .parse(data ?? [])
    .map((row) => ({
      id: row.id,
      title: row.title,
      city: row.city,
      department: row.department,
      propertyType: row.property_type,
      startingPriceEur: row.starting_price_eur,
      saleDate: row.sale_date,
      status: row.status,
    }));
}

/**
 * La vente est-elle débloquée pour ce compte, et toujours en ligne ? Sert aux routes qui
 * raisonnent par offre. Réponse positive uniquement quand la base le confirme ; une base sans le
 * déblocage (déploiement échelonné) revient à « non », jamais à « oui ».
 */
export async function hasUnlockedSale(auth: SupabaseAuthContext, saleId: string): Promise<boolean> {
  const { data, error } = await auth.supabase.rpc("get_sale_unlock_status", { p_sale_id: saleId });
  if (error) {
    if (isMissingFunction(error)) return false;
    throw error;
  }
  return parseSaleUnlockStatus(data).unlocked;
}

/** Débloque une vente en ligne (idempotent). Quota atteint : `SaleUnlockQuotaError`. */
export async function unlockSale(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<SaleUnlockResult> {
  const { data, error } = await auth.supabase.rpc("unlock_sale", { p_sale_id: saleId });
  if (error) {
    if (error.code === "P0001" && error.details === "sale_unlock_quota_reached") {
      throw new SaleUnlockQuotaError(await getSaleUnlockStatus(auth, saleId));
    }
    if (error.code === "P0002") {
      throw new PublicApiError("Vente introuvable ou plus en ligne.", 404);
    }
    if (error.code === "42501") throw new Error("Unauthorized: Connexion requise.");
    if (isMissingFunction(error)) {
      throw new PublicApiError("Le déblocage d’une vente n’est pas encore disponible.", 503);
    }
    throw error;
  }
  return parseSaleUnlockResult(data);
}
