import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/types";
import { getStripe } from "@/lib/billing";
import { privacyDeadlineStatus, type PrivacyDeadlineStatus } from "@/lib/privacy-deadline";

const privacyRequestTypeSchema = z.enum([
  "access",
  "portability",
  "rectification",
  "erasure",
  "restriction",
  "objection",
  "consent_withdrawal",
  "contract_withdrawal",
]);

const privacyRequestStatusSchema = z.enum([
  "received",
  "identity_verification",
  "in_review",
  "completed",
  "rejected",
]);

export const privacyRequestInputSchema = z.object({
  requestType: privacyRequestTypeSchema,
  message: z.string().trim().max(4000).optional(),
});

export const privacyRequestAdminUpdateSchema = z
  .object({
    requestId: z.string().uuid(),
    status: privacyRequestStatusSchema,
    identityStatus: z
      .enum(["authenticated", "additional_verification_required", "verified"])
      .optional(),
    resolutionCode: z.string().trim().max(120).optional(),
    operatorNotes: z.string().trim().max(8000).optional(),
  })
  .superRefine((input, context) => {
    if (["completed", "rejected"].includes(input.status) && !input.resolutionCode?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["resolutionCode"],
        message: "Un code de résolution est requis pour clôturer la demande.",
      });
    }
  });

export type PrivacyRequestType = z.infer<typeof privacyRequestTypeSchema>;
export type PrivacyRequestStatus = z.infer<typeof privacyRequestStatusSchema>;
export type PrivacyRequestInput = z.input<typeof privacyRequestInputSchema>;
export type PrivacyRequestAdminUpdate = z.infer<typeof privacyRequestAdminUpdateSchema>;

export type PrivacyRequestSummary = {
  id: string;
  requestType: PrivacyRequestType;
  status: PrivacyRequestStatus;
  identityStatus: string;
  message: string | null;
  submittedAt: string;
  acknowledgedAt: string;
  dueAt: string;
  completedAt: string | null;
  resolutionCode: string | null;
};

export type PrivacyRequestAdminSummary = PrivacyRequestSummary & {
  requesterEmail: string;
  userId: string | null;
  operatorNotes: string | null;
  deadline: PrivacyDeadlineStatus;
};

export const privacyErasureExecuteSchema = z.object({
  requestId: z.string().uuid(),
  /** The operator retypes the requester's email: erasure is irreversible. */
  confirmEmail: z.string().trim().email().max(320),
});
export type PrivacyErasureExecuteInput = z.input<typeof privacyErasureExecuteSchema>;

export type PrivacyErasureReport = {
  request: PrivacyRequestAdminSummary;
  stripeCustomerDeleted: boolean;
  deletedRows: Record<string, number>;
  storageObjectsRemoved: number;
  authUserDeleted: true;
};

export type PrivacyRequestListResponse = { requests: PrivacyRequestSummary[] };
export type PrivacyRequestAdminListResponse = {
  requests: PrivacyRequestAdminSummary[];
  totalCount: number;
  openCount: number;
  overdueCount: number;
  truncated: boolean;
  offset: number;
  limit: number;
  hasMore: boolean;
};

type PrivacyRequestRow = Tables<"data_subject_requests">;

const USER_COLUMNS =
  "id,request_type,status,identity_status,message,submitted_at,acknowledged_at,due_at,completed_at,resolution_code";
const ADMIN_COLUMNS = `${USER_COLUMNS},requester_email,user_id,operator_notes`;

export async function createPrivacyRequest({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof privacyRequestInputSchema>;
}): Promise<PrivacyRequestSummary> {
  const requesterEmail = typeof auth.claims.email === "string" ? auth.claims.email.trim() : "";
  if (!requesterEmail) throw new Error("Une adresse email vérifiée est requise.");

  const { count, error: countError } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .in("status", ["received", "identity_verification", "in_review"]);
  if (countError) throw countError;
  if ((count ?? 0) >= 5) {
    throw new Error("Trop de demandes ouvertes. Attendez le traitement d’une demande existante.");
  }

  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .insert({
      user_id: auth.userId,
      requester_email: requesterEmail,
      request_type: input.requestType,
      message: input.message || null,
      metadata: { source: "authenticated_rights_portal" },
    })
    .select(USER_COLUMNS)
    .single();
  if (error) throw error;
  return toPrivacyRequestSummary(data as Pick<PrivacyRequestRow, UserColumn>);
}

export async function listPrivacyRequests(
  auth: SupabaseAuthContext,
): Promise<PrivacyRequestListResponse> {
  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .select(USER_COLUMNS)
    .eq("user_id", auth.userId)
    .order("submitted_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return {
    requests: (data ?? []).map((row) =>
      toPrivacyRequestSummary(row as Pick<PrivacyRequestRow, UserColumn>),
    ),
  };
}

export async function listPrivacyRequestsForAdmin(
  auth: SupabaseAuthContext,
  { offset = 0, limit = 100 }: { offset?: number; limit?: number } = {},
): Promise<PrivacyRequestAdminListResponse> {
  assertAdmin(auth);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const openStatuses = ["received", "identity_verification", "in_review"] as const;
  const now = new Date().toISOString();
  const [
    { data, error, count: totalCount },
    { count: openCount, error: openError },
    { count: overdueCount, error: overdueError },
  ] = await Promise.all([
    supabaseAdmin
      .from("data_subject_requests")
      .select(ADMIN_COLUMNS, { count: "exact" })
      .order("submitted_at", { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1),
    supabaseAdmin
      .from("data_subject_requests")
      .select("id", { count: "exact", head: true })
      .in("status", openStatuses),
    supabaseAdmin
      .from("data_subject_requests")
      .select("id", { count: "exact", head: true })
      .in("status", openStatuses)
      .lt("due_at", now),
  ]);
  if (error) throw error;
  if (openError) throw openError;
  if (overdueError) throw overdueError;
  return {
    requests: (data ?? []).map((row) => {
      const typed = row as Pick<PrivacyRequestRow, AdminColumn>;
      return {
        ...toPrivacyRequestSummary(typed),
        requesterEmail: typed.requester_email,
        userId: typed.user_id,
        operatorNotes: typed.operator_notes,
        deadline: privacyDeadlineStatus(typed.due_at, typed.status),
      };
    }),
    totalCount: totalCount ?? data?.length ?? 0,
    openCount: openCount ?? 0,
    overdueCount: overdueCount ?? 0,
    truncated: (totalCount ?? data?.length ?? 0) > (data?.length ?? 0),
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + (data?.length ?? 0) < (totalCount ?? 0),
  };
}

export async function updatePrivacyRequestForAdmin({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: PrivacyRequestAdminUpdate;
}): Promise<PrivacyRequestAdminSummary> {
  assertAdmin(auth);
  const terminal = input.status === "completed" || input.status === "rejected";
  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .update({
      status: input.status,
      identity_status: input.identityStatus,
      resolution_code: input.resolutionCode || null,
      operator_notes: input.operatorNotes || null,
      completed_at: terminal ? new Date().toISOString() : null,
    })
    .eq("id", input.requestId)
    .select(ADMIN_COLUMNS)
    .single();
  if (error) throw error;
  const typed = data as Pick<PrivacyRequestRow, AdminColumn>;
  return {
    ...toPrivacyRequestSummary(typed),
    requesterEmail: typed.requester_email,
    userId: typed.user_id,
    operatorNotes: typed.operator_notes,
    deadline: privacyDeadlineStatus(typed.due_at, typed.status),
  };
}

// Application data owned by the requester, deleted explicitly (with counts for the audit trail)
// before the auth user is removed; every one of these also cascades from auth.users. Records the
// law obliges us to keep stay out: data_subject_requests (proof of handling), commercial_acceptances
// and valuation_estimates are detached (user_id set null) by their foreign keys.
export const ERASURE_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ["user_alerts", "user_id"],
  ["user_alert_matches", "user_id"],
  ["user_alert_notifications", "user_id"],
  ["user_favorites", "user_id"],
  ["user_watched_zones", "user_id"],
  ["user_sale_change_events", "user_id"],
  ["user_sale_watch_snapshots", "user_id"],
  ["user_sale_analysis_items", "user_id"],
  ["user_sale_analysis_sets", "user_id"],
  ["saved_property_reports", "user_id"],
  ["property_report_exports", "user_id"],
  ["sale_data_exports", "user_id"],
  ["sale_workspace_annotations", "author_id"],
  ["sale_workspace_collaborators", "owner_id"],
  ["sale_workspace_collaborators", "invited_by"],
  ["sale_workspaces", "user_id"],
  ["lawyer_referral_requests", "requester_id"],
  ["listing_publication_requests", "requester_id"],
  ["data_refresh_requests", "user_id"],
  ["feature_usage_events", "user_id"],
  ["user_api_keys", "user_id"],
  ["user_notification_preferences", "user_id"],
  ["information_agent_messages", "user_id"],
  ["information_agent_missions", "user_id"],
  ["information_agent_case_subscribers", "user_id"],
  ["stripe_checkout_access_grants", "user_id"],
  ["stripe_payment_lifecycle", "user_id"],
  ["user_subscriptions", "user_id"],
  ["user_profiles", "user_id"],
];

const ERASURE_STORAGE_BUCKETS = ["listing-request-documents"] as const;

type DeleteBuilder = {
  from(name: string): {
    delete(options: { count: "exact" }): {
      eq(
        column: string,
        value: string,
      ): Promise<{ count: number | null; error: { message?: string } | null }>;
    };
  };
};

/**
 * Executes an erasure request: Stripe customer first (so a failure leaves the account intact and
 * the operation can be retried), then application data, uploaded files and finally the auth user.
 */
export async function executePrivacyErasure({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof privacyErasureExecuteSchema>;
}): Promise<PrivacyErasureReport> {
  assertAdmin(auth);

  const { data: row, error: requestError } = await supabaseAdmin
    .from("data_subject_requests")
    .select(ADMIN_COLUMNS)
    .eq("id", input.requestId)
    .single();
  if (requestError) throw requestError;
  const request = row as Pick<PrivacyRequestRow, AdminColumn>;

  if (request.request_type !== "erasure") {
    throw new Error("Cette demande n'est pas une demande d'effacement.");
  }
  if (request.status === "completed" || request.status === "rejected") {
    throw new Error("Cette demande est déjà clôturée.");
  }
  if (request.identity_status !== "verified") {
    throw new Error("Vérifiez l'identité du demandeur avant d'exécuter l'effacement.");
  }
  const userId = request.user_id;
  if (!userId) throw new Error("Le compte de ce demandeur n'existe plus.");
  if (userId === auth.userId) {
    throw new Error("Un administrateur ne peut pas effacer son propre compte depuis cet écran.");
  }
  if (input.confirmEmail.trim().toLowerCase() !== request.requester_email.trim().toLowerCase()) {
    throw new Error("L'adresse de confirmation ne correspond pas à celle du demandeur.");
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_role")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.user_role === "admin") {
    throw new Error("Un compte administrateur ne peut pas être effacé automatiquement.");
  }

  const stripeCustomerDeleted = await deleteStripeCustomer(userId);

  const deletedRows: Record<string, number> = {};
  for (const [table, column] of ERASURE_TABLES) {
    const { count, error } = await (supabaseAdmin as unknown as DeleteBuilder)
      .from(table)
      .delete({ count: "exact" })
      .eq(column, userId);
    if (error) throw new Error(`Effacement impossible dans ${table}: ${error.message ?? "erreur"}`);
    deletedRows[`${table}.${column}`] = count ?? 0;
  }

  let storageObjectsRemoved = 0;
  for (const bucket of ERASURE_STORAGE_BUCKETS) {
    storageObjectsRemoved += await removeUserStorageObjects(bucket, userId);
  }

  const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteUserError) throw deleteUserError;

  const report = {
    executed_at: new Date().toISOString(),
    executed_by: auth.userId,
    stripe_customer_deleted: stripeCustomerDeleted,
    storage_objects_removed: storageObjectsRemoved,
    deleted_rows: deletedRows,
  };
  const { data: closed, error: closeError } = await supabaseAdmin
    .from("data_subject_requests")
    .update({
      status: "completed",
      resolution_code: "erasure_executed",
      completed_at: new Date().toISOString(),
      operator_notes: [request.operator_notes, `Effacement exécuté: ${JSON.stringify(report)}`]
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000),
    })
    .eq("id", input.requestId)
    .select(ADMIN_COLUMNS)
    .single();
  if (closeError) throw closeError;

  const typed = closed as Pick<PrivacyRequestRow, AdminColumn>;
  return {
    request: {
      ...toPrivacyRequestSummary(typed),
      requesterEmail: typed.requester_email,
      userId: typed.user_id,
      operatorNotes: typed.operator_notes,
      deadline: privacyDeadlineStatus(typed.due_at, typed.status),
    },
    stripeCustomerDeleted,
    deletedRows,
    storageObjectsRemoved,
    authUserDeleted: true,
  };
}

async function deleteStripeCustomer(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const customerId = data?.stripe_customer_id;
  if (!customerId) return false;
  try {
    await getStripe().customers.del(customerId);
    return true;
  } catch (stripeError) {
    // Already deleted on the Stripe side: the goal is reached, keep going.
    if ((stripeError as { code?: string }).code === "resource_missing") return true;
    throw stripeError;
  }
}

async function removeUserStorageObjects(bucket: string, userId: string): Promise<number> {
  const storage = supabaseAdmin.storage.from(bucket);
  const paths: string[] = [];
  const { data: folders, error } = await storage.list(userId, { limit: 1000 });
  if (error) throw error;
  for (const entry of folders ?? []) {
    if (entry.id) {
      paths.push(`${userId}/${entry.name}`);
      continue;
    }
    const { data: files, error: listError } = await storage.list(`${userId}/${entry.name}`, {
      limit: 1000,
    });
    if (listError) throw listError;
    for (const file of files ?? []) paths.push(`${userId}/${entry.name}/${file.name}`);
  }
  if (!paths.length) return 0;
  const { error: removeError } = await storage.remove(paths);
  if (removeError) throw removeError;
  return paths.length;
}

type UserColumn =
  | "id"
  | "request_type"
  | "status"
  | "identity_status"
  | "message"
  | "submitted_at"
  | "acknowledged_at"
  | "due_at"
  | "completed_at"
  | "resolution_code";
type AdminColumn = UserColumn | "requester_email" | "user_id" | "operator_notes";

function toPrivacyRequestSummary(row: Pick<PrivacyRequestRow, UserColumn>): PrivacyRequestSummary {
  return {
    id: row.id,
    requestType: privacyRequestTypeSchema.parse(row.request_type),
    status: privacyRequestStatusSchema.parse(row.status),
    identityStatus: row.identity_status,
    message: row.message,
    submittedAt: row.submitted_at,
    acknowledgedAt: row.acknowledged_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    resolutionCode: row.resolution_code,
  };
}

function assertAdmin(auth: SupabaseAuthContext): void {
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
}
