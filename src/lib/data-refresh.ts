import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { featureIncluded, type PlanCode } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { recordFeatureUsageEvent } from "@/lib/usage";

type AuctionSaleRow = Database["public"]["Tables"]["auction_sales"]["Row"];
type DataRefreshRequestRow = Database["public"]["Tables"]["data_refresh_requests"]["Row"];
type RefreshSaleRow = Pick<AuctionSaleRow, "id" | "title" | "city" | "department"> & {
  source_url: string;
};

type DataRefreshAdmissionRpcClient = {
  rpc(
    name: "enqueue_data_refresh_bounded",
    args: {
      p_force: boolean;
      p_request_kind: DataRefreshKind;
      p_sale_id: string;
      p_user_id: string;
    },
  ): Promise<{
    data: Array<{ request_id: string; reused: boolean }> | null;
    error: { message?: string } | null;
  }>;
};

export const DATA_REFRESH_KINDS = ["cadastre", "dpe", "full"] as const;
export type DataRefreshKind = (typeof DATA_REFRESH_KINDS)[number];
export const DATA_REFRESH_REQUESTS_PER_MINUTE = 5;

export const dataRefreshRequestSchema = z.object({
  saleId: z.string().uuid(),
  kinds: z
    .preprocess((value) => normalizeDataRefreshKindList(value), z.array(z.enum(DATA_REFRESH_KINDS)))
    .default(["full"]),
  force: z.boolean().default(false),
});

export const dataRefreshListQuerySchema = z.object({
  saleId: z.string().uuid().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
});

export type DataRefreshRequestInput = z.input<typeof dataRefreshRequestSchema>;
export type DataRefreshRequestPayload = z.output<typeof dataRefreshRequestSchema>;
export type DataRefreshListQuery = z.output<typeof dataRefreshListQuerySchema>;

export type DataRefreshSaleSnapshot = {
  id: string;
  sourceUrl: string;
  title: string | null;
  city: string | null;
  department: string | null;
};

export type DataRefreshRequestItem = {
  id: string;
  saleId: string;
  sourceUrl: string;
  kind: DataRefreshKind;
  status: DataRefreshRequestRow["status"];
  priority: number;
  reused: boolean;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  resultSummary: Json;
  errorMessage: string | null;
};

export type DataRefreshRequestResponse = {
  ok: true;
  sale: DataRefreshSaleSnapshot;
  requests: DataRefreshRequestItem[];
  plan: {
    code: PlanCode;
    label: string;
  };
};

export type DataRefreshListResponse = {
  ok: true;
  requests: DataRefreshRequestItem[];
};

export async function requestDataRefresh({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: DataRefreshRequestPayload;
}): Promise<DataRefreshRequestResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "data.onDemandRefresh")) {
    throw new Error("Le refresh DPE/cadastre à la demande est réservé aux plans Analyse.");
  }

  await enforceUserRateLimit({
    userId: auth.userId,
    bucketKey: "data.refresh",
    limit: DATA_REFRESH_REQUESTS_PER_MINUTE,
    windowSeconds: 60,
  });

  const sale = await loadRefreshSale(auth, input.saleId);
  const kinds = normalizeRequestedKinds(input.kinds);
  const requests: DataRefreshRequestItem[] = [];

  for (const kind of kinds) {
    const admission = await admitRefreshRequest({
      auth,
      saleId: sale.id,
      kind,
      force: input.force,
    });
    const request = await loadRefreshRequest(auth, admission.requestId);
    requests.push(rowToRefreshItem(request, admission.reused));
  }

  await recordFeatureUsageEvent({
    auth,
    eventKey: "data_refresh.requested",
    subjectType: "sale",
    subjectId: sale.id,
    quantity: requests.filter((request) => !request.reused).length || 1,
    metadata: {
      kinds,
      created_count: requests.filter((request) => !request.reused).length,
      reused_count: requests.filter((request) => request.reused).length,
    },
  });

  return {
    ok: true,
    sale: saleSnapshot(sale),
    requests,
    plan: {
      code: plan.plan,
      label: plan.label,
    },
  };
}

export async function listDataRefreshRequests({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: DataRefreshListQuery;
}): Promise<DataRefreshListResponse> {
  let query = auth.supabase
    .from("data_refresh_requests")
    .select("*")
    .eq("user_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (input.saleId) query = query.eq("sale_id", input.saleId);
  if (input.status) query = query.eq("status", input.status);

  const { data, error } = await query;
  if (error) throw error;

  return {
    ok: true,
    requests: (data ?? []).map((row) => rowToRefreshItem(row, false)),
  };
}

export function normalizeDataRefreshKindList(value: unknown): DataRefreshKind[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value == null
        ? ["full"]
        : [value];
  const kinds = rawValues
    .map((item) => String(item).trim())
    .filter((item): item is DataRefreshKind =>
      DATA_REFRESH_KINDS.includes(item as DataRefreshKind),
    );
  return normalizeRequestedKinds(kinds);
}

export function normalizeRequestedKinds(kinds: readonly DataRefreshKind[]): DataRefreshKind[] {
  const normalized: DataRefreshKind[] = [
    ...new Set<DataRefreshKind>(kinds.length ? kinds : ["full"]),
  ];
  return normalized.includes("full") ? ["full"] : normalized;
}

async function loadRefreshSale(auth: SupabaseAuthContext, saleId: string): Promise<RefreshSaleRow> {
  const { data, error } = await auth.supabase
    .from("auction_sales")
    .select("id,source_url,title,city,department")
    .eq("id", saleId)
    .single();

  if (error) throw error;
  if (!data?.source_url) throw new Error("Vente introuvable ou source non rafraîchissable.");
  return { ...data, source_url: data.source_url };
}

async function admitRefreshRequest({
  auth,
  saleId,
  kind,
  force,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
  kind: DataRefreshKind;
  force: boolean;
}): Promise<{ requestId: string; reused: boolean }> {
  const client = supabaseAdmin as unknown as DataRefreshAdmissionRpcClient;
  const { data, error } = await client.rpc("enqueue_data_refresh_bounded", {
    p_force: force,
    p_request_kind: kind,
    p_sale_id: saleId,
    p_user_id: auth.userId,
  });

  if (error) {
    if (error.message?.includes("DATA_REFRESH_")) {
      throw new Error("Trop de demandes de rafraîchissement. Réessayez dans une minute.");
    }
    throw new Error(error.message || "Admission du rafraîchissement indisponible.");
  }

  const admission = data?.[0];
  if (!admission?.request_id) {
    throw new Error("Admission du rafraîchissement indisponible.");
  }
  return { requestId: admission.request_id, reused: admission.reused };
}

async function loadRefreshRequest(
  auth: SupabaseAuthContext,
  requestId: string,
): Promise<DataRefreshRequestRow> {
  const { data, error } = await supabaseAdmin
    .from("data_refresh_requests")
    .select("*")
    .eq("id", requestId)
    .eq("user_id", auth.userId)
    .single();

  if (error) throw error;
  if (!data) throw new Error("Demande de rafraîchissement introuvable après admission.");
  return data;
}

function saleSnapshot(sale: RefreshSaleRow): DataRefreshSaleSnapshot {
  return {
    id: sale.id,
    sourceUrl: sale.source_url,
    title: sale.title,
    city: sale.city,
    department: sale.department,
  };
}

function rowToRefreshItem(row: DataRefreshRequestRow, reused: boolean): DataRefreshRequestItem {
  return {
    id: row.id,
    saleId: row.sale_id,
    sourceUrl: row.source_url,
    kind: row.request_kind,
    status: row.status,
    priority: row.priority,
    reused,
    requestedAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resultSummary: row.result_summary,
    errorMessage: row.error_message,
  };
}
