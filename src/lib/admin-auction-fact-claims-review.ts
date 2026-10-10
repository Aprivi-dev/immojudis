import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRecord } from "@/lib/guards";

const REVIEW_PAGE_SIZE = 50;
const MAX_REVIEW_PAGE_SIZE = 100;

const reviewCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  claimId: z.string().uuid(),
});

export const adminAuctionFactClaimReviewQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_REVIEW_PAGE_SIZE).default(REVIEW_PAGE_SIZE),
  status: z.enum(["candidate", "conflicted"]).optional(),
});

export const adminAuctionFactClaimDecisionSchema = z.object({
  claimId: z.string().uuid(),
  decision: z.enum(["accepted", "rejected", "conflicted"]),
  resolutionNote: z.string().trim().max(2000).nullable().optional(),
});

export type AdminAuctionFactClaimReviewQuery = z.output<
  typeof adminAuctionFactClaimReviewQuerySchema
>;
export type AdminAuctionFactClaimDecision = z.output<typeof adminAuctionFactClaimDecisionSchema>;

export type AdminAuctionFactClaimReviewItem = {
  claimId: string;
  saleId: string;
  lotId: string | null;
  fieldKey: string;
  value: unknown;
  currentCanonicalValue: unknown;
  status: "candidate" | "conflicted";
  conflictGroup: string | null;
  evidence: {
    kind: string;
    sourceId: string | null;
    rawArtifactId: string | null;
    sourceRecordId: string | null;
    extractionId: string | null;
    sourceUrl: string | null;
    locator: Record<string, unknown>;
    confidence: number | null;
    capturedAt: string;
  };
  sale: {
    title: string | null;
    city: string | null;
    saleDate: string | null;
    startingPriceEur: number | null;
  };
  createdAt: string;
  updatedAt: string;
  resolutionNote: string | null;
};

export type AdminAuctionFactClaimReviewResponse = {
  ok: true;
  items: AdminAuctionFactClaimReviewItem[];
  hasMore: boolean;
  nextCursor: string | null;
};

type ClaimReadRow = {
  claim_id: string;
  auction_sale_id: string | null;
  lot_id: string | null;
  field_key: string;
  value_jsonb: unknown;
  fact_status: "candidate" | "conflicted";
  conflict_group: string | null;
  evidence_kind: string;
  source_id: string | null;
  raw_artifact_id: string | null;
  source_record_id: string | null;
  artifact_extraction_id: string | null;
  source_url: string | null;
  evidence_locator: unknown;
  confidence_score: number | string | null;
  captured_at: string;
  created_at: string;
  updated_at: string;
  resolution_note: string | null;
};

type PrivateQueryResult = {
  data: unknown[] | null;
  error: { code?: string; message?: string } | null;
};

type PrivateClaimQuery = PromiseLike<PrivateQueryResult> & {
  select(columns: string): PrivateClaimQuery;
  in(column: string, values: string[]): PrivateClaimQuery;
  eq(column: string, value: string): PrivateClaimQuery;
  not(column: string, operator: string, value: string | null): PrivateClaimQuery;
  order(column: string, options: { ascending: boolean }): PrivateClaimQuery;
  range(from: number, to: number): PrivateClaimQuery;
  or(filters: string): PrivateClaimQuery;
};

type PrivateClaimReader = {
  from(table: string): PrivateClaimQuery;
};

type ReviewRpcClient = {
  rpc(
    functionName: "review_auction_fact_claim",
    args: {
      p_reviewer_id: string;
      p_claim_id: string;
      p_decision: AdminAuctionFactClaimDecision["decision"];
      p_resolution_note: string | null;
    },
  ): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

/**
 * Lists source-backed candidates for a trusted admin review surface.
 *
 * The query intentionally reads the private service-role view and returns the
 * evidence only after the route has checked the caller's admin context. No
 * browser role receives this DTO.
 */
export async function listAdminAuctionFactClaims({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: AdminAuctionFactClaimReviewQuery;
}): Promise<AdminAuctionFactClaimReviewResponse> {
  requireAdmin(auth);
  const cursor = parseReviewCursor(input.cursor);
  const query = (supabaseAdmin as unknown as PrivateClaimReader)
    .from("v_auction_fact_claims_read_model")
    .select(
      "claim_id,auction_sale_id,lot_id,field_key,value_jsonb,fact_status,conflict_group,evidence_kind,source_id,raw_artifact_id,source_record_id,artifact_extraction_id,source_url,evidence_locator,confidence_score,captured_at,created_at,updated_at,resolution_note",
    )
    .not("auction_sale_id", "is", null)
    .order("created_at", { ascending: true })
    .order("claim_id", { ascending: true });

  if (input.status) query.eq("fact_status", input.status);
  else query.in("fact_status", ["candidate", "conflicted"]);
  if (cursor) query.or(cursorFilter(cursor));

  const { data, error } = await query.range(0, input.limit);
  if (error) throw error;

  const rows = (data ?? [])
    .map(parseClaimReadRow)
    .filter((row): row is ClaimReadRow => row != null);
  const pageRows = rows.slice(0, input.limit);
  const hasMore = rows.length > input.limit;
  const sales = await loadSaleSummaries(
    pageRows.flatMap((row) => (row.auction_sale_id ? [row.auction_sale_id] : [])),
  );

  return {
    ok: true,
    items: pageRows
      .map((row) => {
        const sale = row.auction_sale_id ? sales.get(row.auction_sale_id) : null;
        return sale ? toReviewItem(row, sale) : null;
      })
      .filter((item): item is AdminAuctionFactClaimReviewItem => item != null),
    hasMore,
    nextCursor:
      hasMore && pageRows.length ? encodeReviewCursor(pageRows[pageRows.length - 1]) : null,
  };
}

/**
 * Resolves exactly one candidate through the guarded SQL function. The
 * database locks the claim and its sale, rechecks the canonical value, and
 * lets the append-only claim trigger reject any forbidden mutation.
 */
export async function reviewAdminAuctionFactClaim({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: AdminAuctionFactClaimDecision;
}): Promise<{ ok: true; result: unknown }> {
  requireAdmin(auth);
  const client = supabaseAdmin as unknown as ReviewRpcClient;
  const { data, error } = await client.rpc("review_auction_fact_claim", {
    p_reviewer_id: auth.userId,
    p_claim_id: input.claimId,
    p_decision: input.decision,
    p_resolution_note: input.resolutionNote || null,
  });
  if (error) throw error;
  return { ok: true, result: data };
}

function requireAdmin(auth: SupabaseAuthContext): void {
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
}

function parseReviewCursor(value: string | undefined): z.output<typeof reviewCursorSchema> | null {
  if (!value) return null;
  try {
    return reviewCursorSchema.parse(JSON.parse(value));
  } catch {
    throw new Error("Curseur de revue des faits invalide.");
  }
}

function encodeReviewCursor(row: Pick<ClaimReadRow, "created_at" | "claim_id">): string {
  return JSON.stringify({ createdAt: row.created_at, claimId: row.claim_id });
}

function cursorFilter(cursor: z.output<typeof reviewCursorSchema>): string {
  return `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},claim_id.gt.${cursor.claimId})`;
}

async function loadSaleSummaries(ids: string[]): Promise<Map<string, SaleSummary>> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select(
      "id,title,city,sale_date,starting_price_eur,surface_m2,habitable_surface_m2,carrez_surface_m2,land_surface_m2,occupancy_status",
    )
    .in("id", uniqueIds);
  if (error) throw error;

  return new Map(
    (data ?? []).map((row) => [
      row.id,
      {
        title: row.title,
        city: row.city,
        saleDate: row.sale_date,
        startingPriceEur: row.starting_price_eur,
        surfaceM2: row.surface_m2,
        habitableSurfaceM2: row.habitable_surface_m2,
        carrezSurfaceM2: row.carrez_surface_m2,
        landSurfaceM2: row.land_surface_m2,
        occupancyStatus: row.occupancy_status,
      },
    ]),
  );
}

type SaleSummary = {
  title: string | null;
  city: string | null;
  saleDate: string | null;
  startingPriceEur: number | null;
  surfaceM2: number | null;
  habitableSurfaceM2: number | null;
  carrezSurfaceM2: number | null;
  landSurfaceM2: number | null;
  occupancyStatus: string | null;
};

function toReviewItem(row: ClaimReadRow, sale: SaleSummary): AdminAuctionFactClaimReviewItem {
  return {
    claimId: row.claim_id,
    saleId: row.auction_sale_id as string,
    lotId: row.lot_id,
    fieldKey: row.field_key,
    value: row.value_jsonb,
    currentCanonicalValue: canonicalValue(row.field_key, sale),
    status: row.fact_status,
    conflictGroup: row.conflict_group,
    evidence: {
      kind: row.evidence_kind,
      sourceId: row.source_id,
      rawArtifactId: row.raw_artifact_id,
      sourceRecordId: row.source_record_id,
      extractionId: row.artifact_extraction_id,
      sourceUrl: row.source_url,
      locator: asRecord(row.evidence_locator),
      confidence: normalizeConfidence(row.confidence_score),
      capturedAt: row.captured_at,
    },
    sale: {
      title: sale.title,
      city: sale.city,
      saleDate: sale.saleDate,
      startingPriceEur: sale.startingPriceEur,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolutionNote: row.resolution_note,
  };
}

function canonicalValue(fieldKey: string, sale: SaleSummary): unknown {
  switch (fieldKey) {
    case "sale.sale_date":
      return sale.saleDate;
    case "sale.starting_price_eur":
      return sale.startingPriceEur;
    case "property.surface_m2":
      return sale.surfaceM2;
    case "property.habitable_surface_m2":
      return sale.habitableSurfaceM2;
    case "property.carrez_surface_m2":
      return sale.carrezSurfaceM2;
    case "property.land_surface_m2":
      return sale.landSurfaceM2;
    case "property.occupancy_status":
      return sale.occupancyStatus;
    default:
      return null;
  }
}

function parseClaimReadRow(value: unknown): ClaimReadRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.claim_id !== "string" ||
    typeof row.auction_sale_id !== "string" ||
    (row.fact_status !== "candidate" && row.fact_status !== "conflicted") ||
    typeof row.field_key !== "string" ||
    typeof row.evidence_kind !== "string" ||
    typeof row.captured_at !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    return null;
  }
  return {
    claim_id: row.claim_id,
    auction_sale_id: row.auction_sale_id,
    lot_id: nullableString(row.lot_id),
    field_key: row.field_key,
    value_jsonb: row.value_jsonb,
    fact_status: row.fact_status,
    conflict_group: nullableString(row.conflict_group),
    evidence_kind: row.evidence_kind,
    source_id: nullableString(row.source_id),
    raw_artifact_id: nullableString(row.raw_artifact_id),
    source_record_id: nullableString(row.source_record_id),
    artifact_extraction_id: nullableString(row.artifact_extraction_id),
    source_url: nullableString(row.source_url),
    evidence_locator: row.evidence_locator,
    confidence_score:
      typeof row.confidence_score === "number" || typeof row.confidence_score === "string"
        ? row.confidence_score
        : null,
    captured_at: row.captured_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolution_note: nullableString(row.resolution_note),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeConfidence(value: number | string | null): number | null {
  const parsed = typeof value === "number" ? value : value == null ? NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}
