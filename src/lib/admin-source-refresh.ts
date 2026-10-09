import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ADMIN_SOURCE_REFRESH_RPC = "enqueue_admin_source_detail_bounded" as const;

type SourceDetailStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

type SourceDetailJobRow = {
  id: string;
  source_url: string;
  job_type: "source_detail";
  status: SourceDetailStatus;
  priority: number;
  detail_source_name: string | null;
  detail_source_url: string | null;
  attempt_count: number;
  max_attempts: number;
  locked_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  request_origin: "system" | "admin_information_agent";
  requested_by: string | null;
};

type SourceDetailQueryBuilder = PromiseLike<{
  data: SourceDetailJobRow[] | null;
  error: { message?: string } | null;
}> & {
  eq: (column: string, value: unknown) => SourceDetailQueryBuilder;
  order: (
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ) => SourceDetailQueryBuilder;
  limit: (count: number) => SourceDetailQueryBuilder;
};

type SourceDetailDatabaseClient = {
  from: (table: "auction_enrichment_jobs") => {
    select: (columns: string) => SourceDetailQueryBuilder;
  };
};

export const adminSourceRefreshRequestSchema = z.object({
  saleId: z.string().uuid(),
  force: z.boolean().default(true),
});

export const adminSourceRefreshStatusQuerySchema = z.object({
  saleId: z.string().uuid(),
});

export type AdminSourceRefreshRequestInput = z.input<typeof adminSourceRefreshRequestSchema>;
export type AdminSourceRefreshRequest = z.output<typeof adminSourceRefreshRequestSchema>;
export type AdminSourceRefreshStatusQuery = z.output<typeof adminSourceRefreshStatusQuerySchema>;

export type AdminSourceRefreshItem = {
  id: string;
  saleId: string;
  kind: "source_detail";
  sourceName: string | null;
  sourceUrl: string | null;
  status: SourceDetailStatus;
  priority: number;
  reused: boolean;
  attemptCount: number;
  maxAttempts: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
};

export type AdminSourceRefreshResponse = {
  ok: true;
  saleId: string;
  request: AdminSourceRefreshItem | null;
  history: AdminSourceRefreshItem[];
};

type AdminSourceRefreshRpcClient = {
  rpc(
    name: typeof ADMIN_SOURCE_REFRESH_RPC,
    args: {
      p_admin_id: string;
      p_force: boolean;
      p_sale_id: string;
    },
  ): Promise<{
    data: Array<{ job_id: string; reused: boolean }> | null;
    error: { code?: string; message?: string } | null;
  }>;
};

type RefreshableSale = {
  id: string;
  source_url: string | null;
  source_name: string | null;
};

export async function requestAdminSourceRefresh({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: AdminSourceRefreshRequest;
}): Promise<AdminSourceRefreshResponse> {
  requireAdmin(auth);

  const client = supabaseAdmin as unknown as AdminSourceRefreshRpcClient;
  const { data, error } = await client.rpc(ADMIN_SOURCE_REFRESH_RPC, {
    p_admin_id: auth.userId,
    p_force: input.force,
    p_sale_id: input.saleId,
  });

  if (error) throw mapAdmissionError(error);
  const admission = data?.[0];
  if (!admission?.job_id) {
    throw new Error("Le refresh source n’a pas pu être admis.");
  }

  const history = await loadAdminSourceRefreshHistory(input.saleId);
  const request = history.find((item) => item.id === admission.job_id) ?? null;
  if (!request) {
    throw new Error("Le refresh source a été admis mais son statut est indisponible.");
  }

  return {
    ok: true,
    saleId: input.saleId,
    request: { ...request, reused: admission.reused },
    history,
  };
}

export async function getAdminSourceRefreshStatus({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: AdminSourceRefreshStatusQuery;
}): Promise<AdminSourceRefreshResponse> {
  requireAdmin(auth);
  const history = await loadAdminSourceRefreshHistory(input.saleId);
  return {
    ok: true,
    saleId: input.saleId,
    request: history[0] ?? null,
    history,
  };
}

function requireAdmin(auth: SupabaseAuthContext): void {
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
}

async function loadAdminSourceRefreshHistory(saleId: string): Promise<AdminSourceRefreshItem[]> {
  const { data: sale, error: saleError } = await supabaseAdmin
    .from("auction_sales")
    .select("id,source_url,source_name")
    .eq("id", saleId)
    .maybeSingle();
  if (saleError) throw saleError;
  if (!sale?.source_url || !sale.source_name) return [];

  const client = supabaseAdmin as unknown as SourceDetailDatabaseClient;
  const { data, error } = await client
    .from("auction_enrichment_jobs")
    .select(
      "id,source_url,job_type,status,priority,detail_source_name,detail_source_url,attempt_count,max_attempts,locked_at,completed_at,last_error,created_at,updated_at,request_origin,requested_by",
    )
    .eq("source_url", sale.source_url)
    .eq("job_type", "source_detail")
    .eq("detail_source_name", sale.source_name)
    .eq("detail_source_url", sale.source_url)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  return (data ?? []).map((row) => rowToRefreshItem(row, sale));
}

function rowToRefreshItem(
  row: SourceDetailJobRow,
  sale: RefreshableSale,
  reused = false,
): AdminSourceRefreshItem {
  return {
    id: row.id,
    saleId: sale.id,
    kind: "source_detail",
    sourceName: row.detail_source_name,
    sourceUrl: row.detail_source_url,
    status: row.status,
    priority: row.priority,
    reused,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    requestedAt: row.created_at,
    startedAt: row.locked_at,
    completedAt: row.completed_at,
    errorMessage: row.last_error,
  };
}

function mapAdmissionError(error: { code?: string; message?: string }): Error {
  const message = error.message ?? "";
  if (message.includes("ADMIN_SOURCE_DETAIL_")) {
    if (message.includes("PAUSED")) {
      return new Error("Le refresh source est désactivé dans le contrôle du pipeline.");
    }
    if (message.includes("SUSPENDED")) {
      return new Error("Cette source est temporairement suspendue après des refus d’accès.");
    }
    if (message.includes("DISABLED")) {
      return new Error("Cette source n’est pas activée pour la lecture détaillée.");
    }
    return new Error(
      "Le refresh source est temporairement limité. Réessayez dans quelques minutes.",
    );
  }
  if (message.includes("Could not find the function") || message.includes("does not exist")) {
    return new Error(
      "Le refresh source administrateur n’est pas encore activé sur cet environnement.",
    );
  }
  return new Error(message || "Le refresh source n’a pas pu être admis.");
}
