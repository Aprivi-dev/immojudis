import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type { FloodPositionInput, StoredFloodRisk } from "@/lib/flood-risk";

/**
 * Lectures et écritures du verdict d'inondation par vente : table privée `auction_sale_flood_risk` (service_role
 * seul, migration 20261106100200) et code commune de la vente `auction_sale_communes` (migration
 * 20261106100000). Ce module est le seul, avec le traitement planifié (`sale-flood-risk-batch.ts`), à nommer la
 * table d'inondation (invariant de `scripts/check-security-invariants.mjs`) : le calcul des pépites lit le
 * verdict par ses fonctions, sans jamais appeler de service externe.
 *
 * Aucune coordonnée n'est copiée dans la table : la position n'y figure que sous forme d'empreinte tronquée
 * (pseudonymisation, voir `flood-risk-position.server.ts`).
 */

const PAGE_SIZE = 1000;
/** Au-delà, le catalogue en ligne a changé d'échelle et la tâche doit être revue. */
const MAX_ROWS = 20_000;

export type FloodRiskInsert = Database["public"]["Tables"]["auction_sale_flood_risk"]["Insert"];
export type FloodRiskUpdate = Database["public"]["Tables"]["auction_sale_flood_risk"]["Update"];

export type StoredFloodRow = StoredFloodRisk & {
  saleId: string;
  communeInsee: string | null;
  /** Dernier changement de verdict (ISO) : une pépite publiée dont il est plus récent que l'évaluation est refaite. */
  verdictChangedAt: string | null;
};

export type SaleCommune = {
  /** Code INSEE de la commune pour GASPAR (751xx, 132xx, 693xx ramenés à 75056, 13055, 69123). */
  communeInsee: string;
  /** Code de l'arrondissement quand la vente en a un (Paris, Lyon, Marseille). */
  arrondissementInsee: string | null;
};

/** Une vente en ligne et ce qu'il faut de sa position pour le contrôle d'inondation. */
export type FloodSale = {
  id: string;
  updatedAt: string | null;
  status: string | null;
  saleDate: string | null;
  latitude: number | null;
  longitude: number | null;
  locationPrecision: string | null;
  qualityFlags: string[];
};

/** Table ou fonction inconnue de la base : la migration n'est pas encore appliquée (déploiement échelonné). */
export function isMissingDatabaseObject(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01";
}

/** Verdicts stockés ; `null` : la table n'existe pas encore. */
export async function readStoredFloodRisks(): Promise<StoredFloodRow[] | null> {
  const rows: StoredFloodRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_flood_risk")
      .select(
        "sale_id, verdict, derive_version, position_key, commune_insee, observed_at, attempted_at, failure_count, ppri_checked, map_date, verdict_changed_at",
      )
      .order("sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (isMissingDatabaseObject(error)) return null;
      throw error;
    }
    for (const row of data ?? []) {
      rows.push({
        saleId: row.sale_id,
        verdict: row.verdict,
        deriveVersion: row.derive_version,
        positionKey: row.position_key,
        communeInsee: row.commune_insee,
        observedAt: row.observed_at,
        attemptedAt: row.attempted_at,
        failureCount: row.failure_count,
        ppriChecked: row.ppri_checked,
        mapDate: row.map_date,
        verdictChangedAt: row.verdict_changed_at,
      });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
  throw new Error("Trop de verdicts d'inondation stockés.");
}

/** Code commune de chaque vente ; `null` : la table n'existe pas encore. */
export async function readSaleCommunes(): Promise<Map<string, SaleCommune> | null> {
  const communes = new Map<string, SaleCommune>();
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_communes")
      .select("sale_id, commune_insee, arrondissement_insee")
      .order("sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (isMissingDatabaseObject(error)) return null;
      throw error;
    }
    for (const row of data ?? []) {
      communes.set(row.sale_id, {
        communeInsee: row.commune_insee,
        arrondissementInsee: row.arrondissement_insee,
      });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return communes;
  }
  throw new Error("Trop de communes de ventes stockées.");
}

/** Les ventes en ligne, avec leur position (vue de la fiche, rôle de service), par pages de 1 000. */
export async function readFloodSales(): Promise<FloodSale[]> {
  const sales: FloodSale[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("v_auction_sales_app")
      .select(
        "id, updated_at, status, sale_date, latitude, longitude, location_precision, quality_flags",
      )
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (!row.id) continue;
      sales.push({
        id: row.id,
        updatedAt: row.updated_at,
        status: row.status,
        saleDate: row.sale_date,
        latitude: typeof row.latitude === "number" ? row.latitude : null,
        longitude: typeof row.longitude === "number" ? row.longitude : null,
        locationPrecision: row.location_precision ?? null,
        qualityFlags: Array.isArray(row.quality_flags)
          ? row.quality_flags.filter((flag): flag is string => typeof flag === "string")
          : [],
      });
    }
    if ((data?.length ?? 0) < PAGE_SIZE) return sales;
  }
  throw new Error("Trop de ventes en ligne pour le contrôle d'inondation.");
}

/** La position d'une vente telle que `flood-risk.ts` la lit. */
export function floodPositionOf(
  sale: FloodSale,
  commune: SaleCommune | null | undefined,
): FloodPositionInput {
  return {
    latitude: sale.latitude,
    longitude: sale.longitude,
    precision: sale.locationPrecision,
    flags: sale.qualityFlags,
    communeInsee: commune?.communeInsee ?? null,
  };
}

/** Écrit des verdicts (insertion ou remplacement complet de la ligne). Rend `false` si la table n'existe pas. */
export async function upsertFloodRisks(rows: FloodRiskInsert[]): Promise<boolean> {
  if (rows.length === 0) return true;
  // Un paquet mêle des verdicts complets et des tentatives « inconnu » sans observation : sans
  // `defaultToNull: false`, PostgREST mettrait NULL dans les colonnes absentes d'une ligne (tri_scenarios,
  // ppri_checked, NOT NULL) au lieu de leur valeur par défaut, et tout le paquet serait refusé (23502).
  const { error } = await supabaseAdmin
    .from("auction_sale_flood_risk")
    .upsert(rows, { onConflict: "sale_id", defaultToNull: false });
  if (error) {
    if (isMissingDatabaseObject(error)) return false;
    // Le message d'erreur peut citer une ligne : seul le code remonte.
    throw new Error(`Écriture des verdicts d'inondation refusée (code ${error.code ?? "inconnu"})`);
  }
  return true;
}

/** Met à jour une ligne existante sans toucher à son verdict (échec de la source). */
export async function updateFloodRisk(saleId: string, changes: FloodRiskUpdate): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("auction_sale_flood_risk")
    .update(changes)
    .eq("sale_id", saleId);
  if (error) {
    if (isMissingDatabaseObject(error)) return false;
    throw new Error(
      `Mise à jour du verdict d'inondation refusée (code ${error.code ?? "inconnu"})`,
    );
  }
  return true;
}

/** Le code d'une erreur du magasin (`… refusée (code 23514)`), ou `unknown` : de quoi journaliser sans donnée. */
export function storeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const match = /\(code ([A-Za-z0-9_]{1,12})\)/.exec(message);
  return match ? match[1] : "unknown";
}

/** Durée du bail du traitement d'inondation : au-delà de `maxDuration` (300 s), il expire seul si la passe meurt. */
export const FLOOD_LEASE_SECONDS = 360;

export type FloodLease =
  | { kind: "held"; token: string }
  | { kind: "busy" }
  /** La fonction de bail n'existe pas encore (migration en retard) : le traitement continue sans verrou. */
  | { kind: "unavailable" };

/** Prend le bail du traitement d'inondation (voir la migration 20261106100500) ; `busy` : une autre passe court. */
export async function claimFloodRiskLease(): Promise<FloodLease> {
  const { data, error } = await supabaseAdmin.rpc("claim_sale_flood_risk_lease", {
    p_ttl_seconds: FLOOD_LEASE_SECONDS,
  });
  if (error) {
    if (isMissingDatabaseObject(error)) return { kind: "unavailable" };
    throw new Error(`Bail du traitement d'inondation refusé (code ${error.code ?? "inconnu"})`);
  }
  return typeof data === "string" && data ? { kind: "held", token: data } : { kind: "busy" };
}

/** Rend le bail. Sans effet (et sans erreur) si la passe l'a déjà perdu ou si la fonction manque. */
export async function releaseFloodRiskLease(token: string): Promise<void> {
  try {
    await supabaseAdmin.rpc("release_sale_flood_risk_lease", { p_token: token });
  } catch {
    // Le bail expire seul (FLOOD_LEASE_SECONDS) : rendre le bail ne doit jamais faire échouer la passe.
  }
}
