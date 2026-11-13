import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import { PublicApiError } from "@/lib/api-errors";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import type { SelectedRow } from "@/lib/supabase-select";

const ADMIN_SOURCE_REFRESH_RPC = "enqueue_admin_source_detail_bounded" as const;

type SourceDetailStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

const SOURCE_DETAIL_JOB_COLUMNS =
  "id,source_url,job_type,status,priority,detail_source_name,detail_source_url,attempt_count,max_attempts,locked_at,completed_at,last_error,created_at,updated_at,request_origin,requested_by";

/** `status` est protégé par une contrainte CHECK : le type généré le déclare en string. */
type SourceDetailJobRow = Omit<
  SelectedRow<
    Database["public"]["Tables"]["auction_enrichment_jobs"]["Row"],
    typeof SOURCE_DETAIL_JOB_COLUMNS
  >,
  "status"
> & { status: SourceDetailStatus };

export const adminSourceRefreshRequestSchema = z.object({
  saleId: z.string().guid(),
  force: z.boolean().default(true),
});

export const adminSourceRefreshStatusQuerySchema = z.object({
  saleId: z.string().guid(),
});

export type AdminSourceRefreshRequestInput = z.input<typeof adminSourceRefreshRequestSchema>;
export type AdminSourceRefreshRequest = z.output<typeof adminSourceRefreshRequestSchema>;
export type AdminSourceRefreshStatusQuery = z.output<typeof adminSourceRefreshStatusQuerySchema>;

type AdminSourceRefreshItem = {
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
  assertAdmin(auth);

  const { data, error } = await supabaseAdmin.rpc(ADMIN_SOURCE_REFRESH_RPC, {
    p_admin_id: auth.userId,
    p_force: input.force,
    p_sale_id: input.saleId,
  });

  if (error) throw mapAdmissionError(error);
  const admission = data?.[0];
  if (!admission?.job_id) {
    throw new Error("Source refresh admission returned no job.");
  }

  const history = await loadAdminSourceRefreshHistory(input.saleId);
  const request = history.find((item) => item.id === admission.job_id) ?? null;
  if (!request) {
    throw new Error("Admitted source refresh job is missing from the history.");
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
  assertAdmin(auth);
  const history = await loadAdminSourceRefreshHistory(input.saleId);
  return {
    ok: true,
    saleId: input.saleId,
    request: history[0] ?? null,
    history,
  };
}

async function loadAdminSourceRefreshHistory(saleId: string): Promise<AdminSourceRefreshItem[]> {
  const { data: sale, error: saleError } = await supabaseAdmin
    .from("auction_sales")
    .select("id,source_url,source_name")
    .eq("id", saleId)
    .maybeSingle();
  if (saleError) throw saleError;
  if (!sale?.source_url || !sale.source_name) return [];

  const { data, error } = await supabaseAdmin
    .from("auction_enrichment_jobs")
    .select(SOURCE_DETAIL_JOB_COLUMNS)
    .eq("source_url", sale.source_url)
    .eq("job_type", "source_detail")
    .eq("detail_source_name", sale.source_name)
    .eq("detail_source_url", sale.source_url)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;

  return (data ?? []).map((row) =>
    rowToRefreshItem({ ...row, status: row.status as SourceDetailStatus }, sale),
  );
}

/** Une demande lue dans la file : `reused` ne vaut que pour la réponse à une nouvelle demande. */
function rowToRefreshItem(row: SourceDetailJobRow, sale: RefreshableSale): AdminSourceRefreshItem {
  return {
    id: row.id,
    saleId: sale.id,
    kind: "source_detail",
    sourceName: row.detail_source_name,
    sourceUrl: row.detail_source_url,
    status: row.status,
    priority: row.priority,
    reused: false,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    requestedAt: row.created_at,
    startedAt: row.locked_at,
    completedAt: row.completed_at,
    errorMessage: row.last_error,
  };
}

/** Refus de l'admission (`ADMIN_SOURCE_DETAIL_*`) : 409, message montré ; toute autre erreur reste interne. */
function mapAdmissionError(error: { code?: string; message?: string }): Error {
  const message = error.message ?? "";
  if (message.includes("ADMIN_SOURCE_DETAIL_")) {
    if (message.includes("PAUSED")) {
      return new PublicApiError(
        "Le refresh source est désactivé dans le contrôle du pipeline.",
        409,
      );
    }
    if (message.includes("SUSPENDED")) {
      return new PublicApiError(
        "Cette source est temporairement suspendue après des refus d’accès.",
        409,
      );
    }
    if (message.includes("DISABLED")) {
      return new PublicApiError("Cette source n’est pas activée pour la lecture détaillée.", 409);
    }
    return new PublicApiError(
      "Le refresh source est temporairement limité. Réessayez dans quelques minutes.",
      409,
    );
  }
  return new Error("Source refresh admission failed.", { cause: error });
}
