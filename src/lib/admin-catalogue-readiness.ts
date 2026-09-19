import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

const ACTIVE_SALE_STATUSES = ["upcoming", "unknown", "postponed"];

export type CatalogueReadinessStatus =
  | "unassessed"
  | "internal_only"
  | "needs_enrichment"
  | "premium_ready";

export type CatalogueReadinessQueueItem = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  saleDate: string | null;
  sourceName: string | null;
  lawyerName: string | null;
  lawyerContact: string | null;
  scoreConfidence: number | null;
  readinessScore: number | null;
  readinessStatus: CatalogueReadinessStatus;
  policyVersion: string | null;
  factors: Record<string, unknown>;
  blockers: string[];
  missingFields: string[];
  evaluatedAt: string | null;
  override: "hold" | "publish" | null;
  overrideReason: string | null;
  overrideExpiresAt: string | null;
};

export type CatalogueReadinessOverview = {
  policy: {
    enforcementEnabled: boolean;
    policyVersion: string;
    premiumReadyMin: number;
    minimumScoreConfidence: number;
    updatedAt: string;
  };
  counts: Record<CatalogueReadinessStatus, number>;
  activeSales: number;
  pendingEvaluations: number;
  canEnableEnforcement: boolean;
  queueTotal: number;
  queueOffset: number;
  queueLimit: number;
  items: CatalogueReadinessQueueItem[];
};

export const adminCatalogueReadinessQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(250).default(100),
});

export const adminCatalogueReadinessActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set_enforcement"),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal("set_override"),
    saleId: z.string().uuid(),
    decision: z.enum(["hold", "publish"]),
    reason: z.string().trim().min(8).max(2000),
    expiresAt: z.string().datetime().nullable().optional(),
  }),
  z.object({
    action: z.literal("clear_override"),
    saleId: z.string().uuid(),
  }),
]);

export type AdminCatalogueReadinessAction = z.output<typeof adminCatalogueReadinessActionSchema>;

export async function getAdminCatalogueReadinessOverview(
  authToken: string,
  options: { offset?: number; limit?: number } = {},
): Promise<CatalogueReadinessOverview> {
  await requireAdmin(authToken);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(250, options.limit ?? 100));
  const [
    { data: policy, error: policyError },
    { data: sales, error: salesError, count: queueTotal },
    activeCount,
    ...statusCounts
  ] = await Promise.all([
    supabaseAdmin.from("catalogue_readiness_policy").select("*").eq("singleton", true).single(),
    supabaseAdmin
      .from("auction_sales")
      .select(
        "id,title,city,department,sale_date,source_name,premium_readiness_score,premium_readiness_status,premium_readiness_policy_version,premium_readiness_factors,premium_readiness_blockers,premium_readiness_missing_fields,premium_readiness_evaluated_at,premium_readiness_override,premium_readiness_override_reason,premium_readiness_override_expires_at",
        { count: "exact" },
      )
      .in("status", ACTIVE_SALE_STATUSES)
      .or("premium_readiness_status.neq.premium_ready,premium_readiness_override.eq.hold")
      .order("premium_readiness_score", { ascending: false, nullsFirst: false })
      .order("sale_date", { ascending: true, nullsFirst: false })
      .range(offset, offset + limit - 1),
    countActiveSales(),
    ...(["unassessed", "internal_only", "needs_enrichment", "premium_ready"] as const).map(
      (status) => countActiveSales(status),
    ),
  ]);
  if (policyError) throw policyError;
  if (salesError) throw salesError;

  const contacts = await loadSaleContactDetails((sales ?? []).map((sale) => sale.id));
  const items = (sales ?? []).map((sale) => toQueueItem(sale, contacts.get(sale.id)));
  const pendingEvaluations = await countPendingEvaluations(policy.policy_version);
  const counts: Record<CatalogueReadinessStatus, number> = {
    unassessed: statusCounts[0],
    internal_only: statusCounts[1],
    needs_enrichment: statusCounts[2],
    premium_ready: statusCounts[3],
  };

  return {
    policy: {
      enforcementEnabled: policy.enforcement_enabled,
      policyVersion: policy.policy_version,
      premiumReadyMin: policy.premium_ready_min,
      minimumScoreConfidence: Number(policy.minimum_score_confidence),
      updatedAt: policy.updated_at,
    },
    counts,
    activeSales: activeCount,
    pendingEvaluations,
    canEnableEnforcement: pendingEvaluations === 0,
    queueTotal: queueTotal ?? 0,
    queueOffset: offset,
    queueLimit: limit,
    items,
  };
}

async function countActiveSales(status?: CatalogueReadinessStatus): Promise<number> {
  let query = supabaseAdmin
    .from("auction_sales")
    .select("id", { count: "exact", head: true })
    .in("status", ACTIVE_SALE_STATUSES);
  if (status) query = query.eq("premium_readiness_status", status);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function countPendingEvaluations(policyVersion: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("auction_sales")
    .select("id", { count: "exact", head: true })
    .in("status", ACTIVE_SALE_STATUSES)
    .or(
      `premium_readiness_status.eq.unassessed,premium_readiness_evaluated_at.is.null,premium_readiness_policy_version.is.null,premium_readiness_policy_version.neq.${policyVersion}`,
    );
  if (error) throw error;
  return count ?? 0;
}

type SaleContactDetails = {
  lawyer_name: string | null;
  lawyer_contact: string | null;
  score_confidence: number | null;
};

async function loadSaleContactDetails(ids: string[]): Promise<Map<string, SaleContactDetails>> {
  const result = new Map<string, SaleContactDetails>();
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += 200) chunks.push(ids.slice(index, index + 200));
  const responses = await Promise.all(
    chunks.map((chunk) =>
      supabaseAdmin
        .from("v_auction_sales_app")
        .select("id,lawyer_name,lawyer_contact,score_confidence")
        .in("id", chunk),
    ),
  );
  for (const response of responses) {
    if (response.error) throw response.error;
    for (const row of response.data ?? []) {
      if (row.id) result.set(row.id, row);
    }
  }
  return result;
}

export async function runAdminCatalogueReadinessAction({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminCatalogueReadinessAction;
}): Promise<CatalogueReadinessOverview> {
  const auth = await requireAdmin(authToken);
  if (input.action === "set_enforcement") {
    const { error } = await auth.supabase.rpc("set_catalogue_readiness_enforcement", {
      p_enabled: input.enabled,
    });
    if (error) throw error;
  } else if (input.action === "set_override") {
    const { error } = await auth.supabase.rpc("set_auction_sale_readiness_override", {
      p_sale_id: input.saleId,
      p_decision: input.decision,
      p_reason: input.reason,
      p_expires_at: input.expiresAt ?? null,
    });
    if (error) throw error;
  } else {
    const { error } = await auth.supabase.rpc("clear_auction_sale_readiness_override", {
      p_sale_id: input.saleId,
    });
    if (error) throw error;
  }
  return getAdminCatalogueReadinessOverview(authToken);
}

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}

function toQueueItem(
  row: {
    id: string;
    title: string | null;
    city: string | null;
    department: string | null;
    sale_date: string | null;
    source_name: string | null;
    premium_readiness_score: number | null;
    premium_readiness_status: string;
    premium_readiness_policy_version: string | null;
    premium_readiness_factors: Json;
    premium_readiness_blockers: Json;
    premium_readiness_missing_fields: Json;
    premium_readiness_evaluated_at: string | null;
    premium_readiness_override: string | null;
    premium_readiness_override_reason: string | null;
    premium_readiness_override_expires_at: string | null;
  },
  contact?: SaleContactDetails,
): CatalogueReadinessQueueItem {
  return {
    id: row.id,
    title: row.title,
    city: row.city,
    department: row.department,
    saleDate: row.sale_date,
    sourceName: row.source_name,
    lawyerName: contact?.lawyer_name ?? null,
    lawyerContact: contact?.lawyer_contact ?? null,
    scoreConfidence: contact?.score_confidence ?? null,
    readinessScore: row.premium_readiness_score,
    readinessStatus: normalizeStatus(row.premium_readiness_status),
    policyVersion: row.premium_readiness_policy_version,
    factors: jsonObject(row.premium_readiness_factors),
    blockers: jsonStrings(row.premium_readiness_blockers),
    missingFields: jsonStrings(row.premium_readiness_missing_fields),
    evaluatedAt: row.premium_readiness_evaluated_at,
    override:
      row.premium_readiness_override === "hold" || row.premium_readiness_override === "publish"
        ? row.premium_readiness_override
        : null,
    overrideReason: row.premium_readiness_override_reason,
    overrideExpiresAt: row.premium_readiness_override_expires_at,
  };
}

function normalizeStatus(value: string): CatalogueReadinessStatus {
  return value === "internal_only" || value === "needs_enrichment" || value === "premium_ready"
    ? value
    : "unassessed";
}

function jsonObject(value: Json): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonStrings(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
