import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  AuctionFactClaimSummary,
  FactReliabilityStatus,
  KeyFact,
} from "@/lib/fact-reliability";
import {
  factClaimLotAttachmentHolds,
  type FactClaimLotAttachment,
} from "@/lib/fact-claim-decisions";
import { asRecordOrNull } from "@/lib/guards";
import { KEY_FACT_FIELDS, normalizeFactKey } from "@/lib/key-fact-fields";

/**
 * Server-only contract for internal workflows that need a compact signal per
 * sale. It intentionally omits source URLs, artifact identifiers and raw
 * values. A draft generator can use this to prioritize questions without
 * treating a candidate as verified.
 */
type SaleFactSignal = {
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

const CLAIM_FIELD_KEYS = [...new Set(Object.values(KEY_FACT_FIELDS).flat())];

/**
 * Reads the private claim view with a service role and keeps the result inside
 * server workflows. A failed read is thrown: an outage is never mistaken for
 * a sale without claims.
 */
export async function readSaleFactClaims(saleId: string): Promise<{
  claims: AuctionFactClaimSummary[];
  claimsBacked: boolean;
}> {
  const { data, error } = await supabaseAdmin
    .from("v_auction_fact_claims_read_model")
    .select(
      "claim_id,field_key,fact_status,value_jsonb,confidence_score,captured_at,evidence_locator",
    )
    .eq("auction_sale_id", saleId)
    .in("field_key", CLAIM_FIELD_KEYS);
  if (error) throw error;

  const rows = data ?? [];
  const unsettled = await unsettledAgentClaimIds(rows);
  return {
    claims: rows
      .filter((row) => !row.claim_id || !unsettled.has(row.claim_id))
      .map(parseClaimSummary)
      .filter((claim): claim is AuctionFactClaimSummary => claim != null),
    claimsBacked: true,
  };
}

/**
 * Observations créées par le pont de l'agent d'information (réponse d'un professionnel acceptée) dont la dernière
 * décision au registre n'est pas une acceptation qui tient (vente à un seul lot ou lot identifié) : décision jamais
 * écrite (échec après l'acceptation, réponse acceptée avant le lot C du 14/11/2026), retrait, opposition. La fiche
 * n'affiche pas leur valeur : les compter ferait un faux conflit.
 */
async function unsettledAgentClaimIds(
  rows: ReadonlyArray<{ claim_id: string | null; evidence_locator: unknown }>,
): Promise<Set<string>> {
  const agentClaimIds = rows.flatMap((row) => {
    const locator = asRecordOrNull(row.evidence_locator);
    return row.claim_id && typeof locator?.information_agent_fact_id === "string"
      ? [row.claim_id]
      : [];
  });
  if (!agentClaimIds.length) return new Set();
  const { data, error } = await supabaseAdmin
    .from("auction_fact_claim_decisions")
    .select("claim_id,decision,lot_attachment,seq")
    .in("claim_id", agentClaimIds)
    .order("seq", { ascending: false });
  if (error) throw error;
  const latest = new Map<string, { decision: string; lot_attachment: string }>();
  for (const decision of data ?? []) {
    if (!latest.has(decision.claim_id)) latest.set(decision.claim_id, decision);
  }
  return new Set(
    agentClaimIds.filter((claimId) => {
      const decision = latest.get(claimId);
      return !(
        decision?.decision === "accepted" &&
        // Une valeur inconnue de la base ne tient pas : la fonction ne reconnaît que les deux qui tiennent.
        factClaimLotAttachmentHolds(decision.lot_attachment as FactClaimLotAttachment)
      );
    }),
  );
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
  const signals = (Object.keys(KEY_FACT_FIELDS) as KeyFact[])
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
    KEY_FACT_FIELDS[field].includes(normalizeFactKey(claim.field_key)),
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
    !CLAIM_FIELD_KEYS.includes(normalizeFactKey(fieldKey)) ||
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
