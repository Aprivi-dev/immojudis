import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Tables } from "@/integrations/supabase/types";

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
};

export type PrivacyRequestListResponse = { requests: PrivacyRequestSummary[] };
export type PrivacyRequestAdminListResponse = { requests: PrivacyRequestAdminSummary[] };

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
): Promise<PrivacyRequestAdminListResponse> {
  assertAdmin(auth);
  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .select(ADMIN_COLUMNS)
    .order("submitted_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return {
    requests: (data ?? []).map((row) => {
      const typed = row as Pick<PrivacyRequestRow, AdminColumn>;
      return {
        ...toPrivacyRequestSummary(typed),
        requesterEmail: typed.requester_email,
        userId: typed.user_id,
        operatorNotes: typed.operator_notes,
      };
    }),
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
  };
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
