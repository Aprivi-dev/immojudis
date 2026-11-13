import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type { FloodPositionInput, FloodProbePoint, StoredFloodRisk } from "@/lib/flood-risk";

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
  /** Type du résultat de la BAN (`raw_payload.geocode.type`) ; `null` : pas de résultat BAN. */
  geocodeType: string | null;
  /** Score du résultat de la BAN (`raw_payload.geocode.score`) ; `null` : inconnu. */
  geocodeScore: number | null;
  /** Centroïdes des parcelles trouvées (résumé cadastral du pipeline) ; vide : aucune ou une seule. */
  parcelCentroids: FloodProbePoint[];
};

/** Les seuls champs de `raw_payload` lus (jamais l'objet entier) : résultat de la BAN et centroïdes des parcelles. */
const POSITION_EXTRAS_SELECT =
  "id,geocode_type:raw_payload->geocode->>type,geocode_score:raw_payload->geocode->>score,parcels:raw_payload->cadastre_location->resolution->parcels";

type PositionExtras = Pick<FloodSale, "geocodeType" | "geocodeScore" | "parcelCentroids">;

function parcelCentroidsFrom(value: unknown): FloodProbePoint[] {
  if (!Array.isArray(value)) return [];
  const points: FloodProbePoint[] = [];
  for (const parcel of value) {
    const centroid = (parcel as { centroid?: unknown } | null)?.centroid;
    if (!Array.isArray(centroid) || centroid.length !== 2) continue;
    const [latitude, longitude] = centroid;
    if (typeof latitude === "number" && typeof longitude === "number") {
      points.push({ latitude, longitude });
    }
  }
  return points;
}

/**
 * Type et score du résultat de la BAN et centroïdes des parcelles des ventes à venir, par identifiant. Ils
 * décident si une position « rue » ou « adresse » compte pour précise (`classifyFloodPosition`) : sans eux, la
 * clé de position serait celle d'un point précis alors que le point est un lieu-dit.
 */
async function readPositionExtras(): Promise<Map<string, PositionExtras>> {
  const extras = new Map<string, PositionExtras>();
  let after: string | null = null;
  for (;;) {
    if (extras.size >= MAX_ROWS) {
      throw new Error("Trop de ventes à venir pour le contrôle d'inondation.");
    }
    // Curseur sur `id` (comme `readFloodSales`) : un décalage relirait et ferait trier toutes les lignes
    // précédentes, avec leur `raw_payload`, à chaque page de chaque passe.
    let query = supabaseAdmin
      .from("auction_sales")
      .select(POSITION_EXTRAS_SELECT)
      .eq("status", "upcoming");
    if (after) query = query.gt("id", after);
    const { data, error } = await query.order("id", { ascending: true }).limit(PAGE_SIZE);
    if (error) throw error;
    for (const row of data ?? []) {
      const score = row.geocode_score == null ? NaN : Number(row.geocode_score);
      extras.set(row.id, {
        geocodeType: typeof row.geocode_type === "string" ? row.geocode_type : null,
        geocodeScore: Number.isFinite(score) ? score : null,
        parcelCentroids: parcelCentroidsFrom(row.parcels),
      });
    }
    const last = data?.at(-1)?.id ?? null;
    if ((data?.length ?? 0) < PAGE_SIZE || !last) return extras;
    after = last;
  }
}

/**
 * Refus de la base sur la table d'inondation ou son bail. Seul le code SQL est gardé : le message de la base peut
 * citer une ligne.
 */
export class FloodRiskStoreError extends Error {
  readonly code: string;

  constructor(operation: string, code: string | undefined) {
    const known = code || "unknown";
    super(`Flood risk ${operation} refused (code ${known})`);
    this.name = "FloodRiskStoreError";
    this.code = known;
  }
}

/** Verdicts stockés. */
export async function readStoredFloodRisks(): Promise<StoredFloodRow[]> {
  const rows: StoredFloodRow[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_flood_risk")
      .select(
        "sale_id, verdict, derive_version, position_key, commune_insee, observed_at, attempted_at, failure_count, ppri_checked, map_date, verdict_changed_at",
      )
      .order("sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
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

/** Code commune de chaque vente. */
export async function readSaleCommunes(): Promise<Map<string, SaleCommune>> {
  const communes = new Map<string, SaleCommune>();
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("auction_sale_communes")
      .select("sale_id, commune_insee, arrondissement_insee")
      .order("sale_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
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

/**
 * Les ventes À VENIR, avec leur position (vue de la fiche, rôle de service). Le filtre de statut est fait dans la
 * base (le traitement d'inondation et la règle de pépite v2 ne regardent que les ventes à venir) et la lecture se fait
 * par curseur sur `id` (`id > dernier`, par pages de 1 000), sans décalage.
 */
export async function readFloodSales(): Promise<FloodSale[]> {
  const extras = await readPositionExtras();
  const sales: FloodSale[] = [];
  let after: string | null = null;
  for (;;) {
    if (sales.length >= MAX_ROWS) {
      throw new Error("Trop de ventes en ligne pour le contrôle d'inondation.");
    }
    let query = supabaseAdmin
      .from("v_auction_sales_app")
      .select(
        "id, updated_at, status, sale_date, latitude, longitude, location_precision, quality_flags",
      )
      .eq("status", "upcoming");
    if (after) query = query.gt("id", after);
    const { data, error } = await query.order("id", { ascending: true }).limit(PAGE_SIZE);
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
        geocodeType: extras.get(row.id)?.geocodeType ?? null,
        geocodeScore: extras.get(row.id)?.geocodeScore ?? null,
        parcelCentroids: extras.get(row.id)?.parcelCentroids ?? [],
      });
    }
    const last = data?.at(-1)?.id ?? null;
    if ((data?.length ?? 0) < PAGE_SIZE || !last) return sales;
    after = last;
  }
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
    geocodeType: sale.geocodeType,
    geocodeScore: sale.geocodeScore,
    parcelCentroids: sale.parcelCentroids,
  };
}

/** Écrit des verdicts (insertion ou remplacement complet de la ligne). */
export async function upsertFloodRisks(rows: FloodRiskInsert[]): Promise<void> {
  if (rows.length === 0) return;
  // Un paquet mêle des verdicts complets et des tentatives « inconnu » sans observation : sans
  // `defaultToNull: false`, PostgREST mettrait NULL dans les colonnes absentes d'une ligne (tri_scenarios,
  // ppri_checked, NOT NULL) au lieu de leur valeur par défaut, et tout le paquet serait refusé (23502).
  const { error } = await supabaseAdmin
    .from("auction_sale_flood_risk")
    .upsert(rows, { onConflict: "sale_id", defaultToNull: false });
  if (error) throw new FloodRiskStoreError("write", error.code);
}

/** Met à jour une ligne existante sans toucher à son verdict (échec de la source). */
export async function updateFloodRisk(saleId: string, changes: FloodRiskUpdate): Promise<void> {
  const { error } = await supabaseAdmin
    .from("auction_sale_flood_risk")
    .update(changes)
    .eq("sale_id", saleId);
  if (error) throw new FloodRiskStoreError("update", error.code);
}

/** Le code d'une erreur du magasin, ou `unknown` : de quoi journaliser sans donnée. */
export function storeErrorCode(error: unknown): string {
  return error instanceof FloodRiskStoreError ? error.code : "unknown";
}

/** Durée du bail du traitement d'inondation : au-delà de `maxDuration` (300 s), il expire seul si la passe meurt. */
const FLOOD_LEASE_SECONDS = 360;

export type FloodLease = { kind: "held"; token: string } | { kind: "busy" };

/** Prend le bail du traitement d'inondation (voir la migration 20261106100500) ; `busy` : une autre passe court. */
export async function claimFloodRiskLease(): Promise<FloodLease> {
  const { data, error } = await supabaseAdmin.rpc("claim_sale_flood_risk_lease", {
    p_ttl_seconds: FLOOD_LEASE_SECONDS,
  });
  if (error) throw new FloodRiskStoreError("lease claim", error.code);
  return typeof data === "string" && data ? { kind: "held", token: data } : { kind: "busy" };
}

/** Rend le bail. Sans effet (et sans erreur) si la passe l'a déjà perdu. */
export async function releaseFloodRiskLease(token: string): Promise<void> {
  try {
    await supabaseAdmin.rpc("release_sale_flood_risk_lease", { p_token: token });
  } catch {
    // Le bail expire seul (FLOOD_LEASE_SECONDS) : rendre le bail ne doit jamais faire échouer la passe.
  }
}
