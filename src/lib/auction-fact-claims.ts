import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  AuctionFactClaimSummary,
  FactReliabilityStatus,
  KeyFact,
} from "@/lib/fact-reliability";

/**
 * Server-only contract for internal workflows that need a compact signal per
 * sale. It intentionally omits source URLs, artifact identifiers and raw
 * values. A draft generator can use this to prioritize questions without
 * treating a candidate as verified.
 */
export type SaleFactSignal = {
  saleId: string;
  field: KeyFact;
  status: FactReliabilityStatus;
  confidence: number | null;
  conflict: boolean;
};

export type SaleFactSignalRead = {
  signals: SaleFactSignal[];
  claimsBacked: boolean;
};

const CLAIM_FIELD_ALIASES: Record<KeyFact, ReadonlySet<string>> = {
  sale_date: new Set(["sale_date", "sale.sale_date", "date", "event_date", "auction_date"]),
  starting_price_eur: new Set([
    "starting_price_eur",
    "sale.starting_price_eur",
    "starting_price",
    "price",
    "mise_a_prix",
  ]),
  surface: new Set([
    "surface",
    "surface_m2",
    "property.surface_m2",
    "app_surface_m2",
    "property.app_surface_m2",
    "habitable_surface_m2",
    "property.habitable_surface_m2",
    "carrez_surface_m2",
    "property.carrez_surface_m2",
    "land_surface_m2",
    "property.land_surface_m2",
  ]),
  occupancy_status: new Set([
    "occupancy_status",
    "property.occupancy_status",
    "occupancy",
    "occupation",
  ]),
};

const CLAIM_FIELD_KEYS = [
  ...new Set([...Object.values(CLAIM_FIELD_ALIASES)].flatMap((set) => [...set])),
];

/**
 * Reads the private claim view with a service role and keeps the result inside
 * server workflows. `claimsBacked` distinguishes an empty migrated view from
 * a pre-migration or temporarily unavailable environment.
 */
export async function readSaleFactClaims(saleId: string): Promise<{
  claims: AuctionFactClaimSummary[];
  claimsBacked: boolean;
}> {
  try {
    const { data, error } = await supabaseAdmin
      .from("v_auction_fact_claims_read_model")
      .select("field_key,fact_status,value_jsonb,confidence_score,captured_at")
      .eq("auction_sale_id", saleId)
      .in("field_key", CLAIM_FIELD_KEYS);
    if (error) return { claims: [], claimsBacked: false };

    return {
      claims: (data ?? [])
        .map(parseClaimSummary)
        .filter((claim): claim is AuctionFactClaimSummary => claim != null),
      claimsBacked: true,
    };
  } catch {
    return { claims: [], claimsBacked: false };
  }
}

/**
 * Returns the compact contract used by admin enrichment workflows.
 *
 * Priority is conflict > candidate > accepted. Candidates therefore produce
 * `to_confirm`, even when an older accepted row is also present. Confidence
 * is the highest valid score among the rows for that field; the value is only
 * a prioritization hint and never upgrades the status.
 */
export async function readSaleFactSignals(saleId: string): Promise<SaleFactSignalRead> {
  const read = await readSaleFactClaims(saleId);
  const signals = (Object.keys(CLAIM_FIELD_ALIASES) as KeyFact[])
    .map((field) => signalForField(saleId, field, read.claims))
    .filter((signal): signal is SaleFactSignal => signal != null);
  return { signals, claimsBacked: read.claimsBacked };
}

function signalForField(
  saleId: string,
  field: KeyFact,
  claims: readonly AuctionFactClaimSummary[],
): SaleFactSignal | null {
  const relevant = claims.filter((claim) =>
    CLAIM_FIELD_ALIASES[field].has(normalizeClaimField(claim.field_key)),
  );
  if (!relevant.length) return null;

  const conflict = relevant.some((claim) => claim.fact_status === "conflicted");
  const hasCandidate = relevant.some((claim) => claim.fact_status === "candidate");
  const status: FactReliabilityStatus = conflict
    ? "conflict"
    : hasCandidate
      ? "to_confirm"
      : "observed";
  const scores = relevant
    .map((claim) => claim.confidence_score)
    .filter((score): score is number => score != null && Number.isFinite(score));

  return {
    saleId,
    field,
    status,
    confidence: scores.length ? Math.max(...scores) : null,
    conflict,
  };
}

function parseClaimSummary(value: unknown): AuctionFactClaimSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const fieldKey = row.field_key;
  const status = row.fact_status;
  if (
    typeof fieldKey !== "string" ||
    !CLAIM_FIELD_KEYS.includes(normalizeClaimField(fieldKey)) ||
    (status !== "candidate" && status !== "accepted" && status !== "conflicted")
  ) {
    return null;
  }
  const confidence = row.confidence_score;
  return {
    field_key: fieldKey,
    fact_status: status,
    value_jsonb: row.value_jsonb,
    confidence_score:
      typeof confidence === "number" &&
      Number.isFinite(confidence) &&
      confidence >= 0 &&
      confidence <= 1
        ? confidence
        : null,
    captured_at: typeof row.captured_at === "string" ? row.captured_at : null,
  };
}

function normalizeClaimField(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[\s-]+/g, "_")
    .trim();
}
