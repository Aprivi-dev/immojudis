import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { hasAdminRole } from "@/lib/account";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements, type PlanEntitlements } from "@/lib/property-reports";

type SaleWorkspaceRow = Database["public"]["Tables"]["sale_workspaces"]["Row"];
type CollaboratorRow = Database["public"]["Tables"]["sale_workspace_collaborators"]["Row"];
type CollaboratorInsert = Database["public"]["Tables"]["sale_workspace_collaborators"]["Insert"];
type AnnotationRow = Database["public"]["Tables"]["sale_workspace_annotations"]["Row"];
type AnnotationInsert = Database["public"]["Tables"]["sale_workspace_annotations"]["Insert"];
type AnnotationUpdate = Database["public"]["Tables"]["sale_workspace_annotations"]["Update"];

export const COLLABORATOR_ROLES = ["viewer", "commenter", "editor"] as const;
export const COLLABORATOR_STATUSES = ["invited", "accepted", "revoked"] as const;
export const ANNOTATION_TARGET_KINDS = ["general", "document", "page", "excerpt"] as const;
export const ANNOTATION_STATUSES = ["open", "resolved", "archived"] as const;

export const collaboratorInviteSchema = z.object({
  saleId: z.string().uuid(),
  invitedEmail: z.string().trim().email().max(320).transform(normalizeEmail),
  role: z.enum(COLLABORATOR_ROLES).default("commenter"),
});

export const collaboratorAcceptSchema = z.object({
  collaboratorId: z.string().uuid(),
});

export const collaboratorRevokeSchema = z.object({
  collaboratorId: z.string().uuid(),
});

export const workspaceAnnotationCreateSchema = z.object({
  saleId: z.string().uuid(),
  documentKey: z.string().trim().max(240).nullable().optional(),
  documentLabel: z.string().trim().max(300).nullable().optional(),
  documentType: z.string().trim().max(120).nullable().optional(),
  documentUrl: z.string().trim().max(2000).nullable().optional(),
  targetKind: z.enum(ANNOTATION_TARGET_KINDS).default("general"),
  pageNumber: z.number().int().positive().nullable().optional(),
  excerpt: z.string().trim().max(2000).nullable().optional(),
  body: z.string().trim().min(1).max(5000),
});

export const workspaceAnnotationUpdateSchema = z.object({
  annotationId: z.string().uuid(),
  body: z.string().trim().min(1).max(5000).optional(),
  status: z.enum(ANNOTATION_STATUSES).optional(),
});

export type CollaboratorInviteInput = z.input<typeof collaboratorInviteSchema>;
export type CollaboratorInvitePayload = z.output<typeof collaboratorInviteSchema>;
export type CollaboratorAcceptInput = z.input<typeof collaboratorAcceptSchema>;
export type CollaboratorAcceptPayload = z.output<typeof collaboratorAcceptSchema>;
export type CollaboratorRevokeInput = z.input<typeof collaboratorRevokeSchema>;
export type CollaboratorRevokePayload = z.output<typeof collaboratorRevokeSchema>;
export type WorkspaceAnnotationCreateInput = z.input<typeof workspaceAnnotationCreateSchema>;
export type WorkspaceAnnotationCreatePayload = z.output<typeof workspaceAnnotationCreateSchema>;
export type WorkspaceAnnotationUpdateInput = z.input<typeof workspaceAnnotationUpdateSchema>;
export type WorkspaceAnnotationUpdatePayload = z.output<typeof workspaceAnnotationUpdateSchema>;

export type SaleWorkspaceCollaborator = CollaboratorRow;
export type SaleWorkspaceAnnotation = AnnotationRow;
export type WorkspaceCollaborationRole = "owner" | (typeof COLLABORATOR_ROLES)[number];

export type SaleWorkspaceCollaborationResponse = {
  workspaceId: string | null;
  saleId: string;
  role: WorkspaceCollaborationRole | null;
  collaborators: SaleWorkspaceCollaborator[];
  annotations: SaleWorkspaceAnnotation[];
  plan: PlanEntitlements;
};

type AccessibleWorkspace = {
  workspace: SaleWorkspaceRow;
  role: WorkspaceCollaborationRole;
};

export async function listSaleWorkspaceCollaboration({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
}): Promise<SaleWorkspaceCollaborationResponse> {
  const plan = await resolvePlanEntitlements(auth);
  const accessible = await resolveAccessibleWorkspace({ auth, saleId });
  if (!accessible) {
    return {
      workspaceId: null,
      saleId,
      role: null,
      collaborators: [],
      annotations: [],
      plan,
    };
  }

  const [collaborators, annotations] = await Promise.all([
    listCollaborators(auth, accessible.workspace.id),
    listAnnotations(auth, accessible.workspace.id),
  ]);

  return {
    workspaceId: accessible.workspace.id,
    saleId,
    role: accessible.role,
    collaborators,
    annotations,
    plan,
  };
}

export async function inviteSaleWorkspaceCollaborator({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: CollaboratorInvitePayload;
}): Promise<{ collaborator: SaleWorkspaceCollaborator; plan: PlanEntitlements }> {
  const plan = await assertWorkspaceCollaborationAvailable(auth);
  const workspace = await ensureOwnerWorkspace({ auth, saleId: input.saleId });
  await assertCollaboratorLimitAvailable({ auth, workspaceId: workspace.id, plan });

  const payload: CollaboratorInsert = {
    workspace_id: workspace.id,
    owner_id: auth.userId,
    invited_by: auth.userId,
    invited_email: input.invitedEmail,
    role: input.role,
    status: "invited",
  };

  const { data, error } = await auth.supabase
    .from("sale_workspace_collaborators")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return { collaborator: data, plan };
}

export async function acceptSaleWorkspaceInvitation({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: CollaboratorAcceptPayload;
}): Promise<{ collaborator: SaleWorkspaceCollaborator }> {
  const email = normalizeEmail(String(auth.claims.email ?? ""));
  if (!email) throw new Error("Invitation impossible à accepter sans email authentifié.");

  const { data: invitation, error } = await supabaseAdmin
    .from("sale_workspace_collaborators")
    .select("*")
    .eq("id", input.collaboratorId)
    .maybeSingle();

  if (error) throw error;
  if (!invitation) throw new Error("Invitation introuvable.");
  if (invitation.status === "revoked") throw new Error("Cette invitation a été révoquée.");
  if (normalizeEmail(invitation.invited_email) !== email && !hasAdminRole(auth.claims)) {
    throw new Error("Cette invitation ne correspond pas à votre email.");
  }

  const now = new Date().toISOString();
  const { data, error: updateError } = await supabaseAdmin
    .from("sale_workspace_collaborators")
    .update({
      collaborator_user_id: auth.userId,
      status: "accepted",
      accepted_at: invitation.accepted_at ?? now,
      revoked_at: null,
    })
    .eq("id", input.collaboratorId)
    .select("*")
    .single();

  if (updateError) throw updateError;
  return { collaborator: data };
}

export async function revokeSaleWorkspaceCollaborator({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: CollaboratorRevokePayload;
}): Promise<{ collaborator: SaleWorkspaceCollaborator }> {
  const now = new Date().toISOString();
  const { data, error } = await auth.supabase
    .from("sale_workspace_collaborators")
    .update({
      status: "revoked",
      revoked_at: now,
    })
    .eq("id", input.collaboratorId)
    .select("*")
    .single();

  if (error) throw error;
  return { collaborator: data };
}

export async function createSaleWorkspaceAnnotation({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: WorkspaceAnnotationCreatePayload;
}): Promise<{ annotation: SaleWorkspaceAnnotation }> {
  let accessible = await resolveAccessibleWorkspace({ auth, saleId: input.saleId });
  if (!accessible) {
    await assertWorkspaceCollaborationAvailable(auth);
    accessible = {
      workspace: await ensureOwnerWorkspace({ auth, saleId: input.saleId }),
      role: "owner",
    };
  }
  if (accessible.role === "viewer") {
    throw new Error("Votre rôle permet la lecture, pas l'ajout d'annotations.");
  }

  const payload: AnnotationInsert = {
    workspace_id: accessible.workspace.id,
    sale_id: input.saleId,
    author_id: auth.userId,
    document_key: emptyToNull(input.documentKey),
    document_label: emptyToNull(input.documentLabel),
    document_type: emptyToNull(input.documentType),
    document_url: emptyToNull(input.documentUrl),
    target_kind: input.targetKind,
    page_number: input.pageNumber ?? null,
    excerpt: emptyToNull(input.excerpt),
    body: input.body,
    status: "open",
  };

  const { data, error } = await auth.supabase
    .from("sale_workspace_annotations")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return { annotation: data };
}

export async function updateSaleWorkspaceAnnotation({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: WorkspaceAnnotationUpdatePayload;
}): Promise<{ annotation: SaleWorkspaceAnnotation }> {
  const patch: AnnotationUpdate = {};
  if (input.body !== undefined) patch.body = input.body;
  if (input.status !== undefined) {
    patch.status = input.status;
    patch.resolved_at = input.status === "resolved" ? new Date().toISOString() : null;
  }

  const { data, error } = await auth.supabase
    .from("sale_workspace_annotations")
    .update(patch)
    .eq("id", input.annotationId)
    .select("*")
    .single();

  if (error) throw error;
  return { annotation: data };
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function assertWorkspaceCollaborationAvailable(
  auth: SupabaseAuthContext,
): Promise<PlanEntitlements> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "workspace.collaboration") && !hasAdminRole(auth.claims)) {
    throw new Error("La collaboration de dossier est réservée au plan Analyse.");
  }
  return plan;
}

async function assertCollaboratorLimitAvailable({
  auth,
  workspaceId,
  plan,
}: {
  auth: SupabaseAuthContext;
  workspaceId: string;
  plan: PlanEntitlements;
}) {
  const limit = plan.limits.workspaceCollaborators;
  if (limit == null || hasAdminRole(auth.claims)) return;

  const { count, error } = await auth.supabase
    .from("sale_workspace_collaborators")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .neq("status", "revoked");

  if (error) throw error;
  if ((count ?? 0) >= limit) {
    throw new Error(`Quota collaborateurs atteint pour ce dossier (${limit}).`);
  }
}

async function ensureOwnerWorkspace({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
}): Promise<SaleWorkspaceRow> {
  const existing = await getOwnerWorkspace({ auth, saleId });
  if (existing) return existing;

  const { data, error } = await auth.supabase
    .from("sale_workspaces")
    .upsert(
      {
        user_id: auth.userId,
        sale_id: saleId,
        tracking_status: "reviewing",
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "user_id,sale_id" },
    )
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function resolveAccessibleWorkspace({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
}): Promise<AccessibleWorkspace | null> {
  const ownWorkspace = await getOwnerWorkspace({ auth, saleId });
  if (ownWorkspace) return { workspace: ownWorkspace, role: "owner" };

  const { data: collaboratorRows, error } = await auth.supabase
    .from("sale_workspace_collaborators")
    .select("*")
    .eq("collaborator_user_id", auth.userId)
    .eq("status", "accepted")
    .limit(50);

  if (error) throw error;
  const workspaceIds = [...new Set((collaboratorRows ?? []).map((row) => row.workspace_id))];
  if (!workspaceIds.length) return null;

  const { data: workspace, error: workspaceError } = await supabaseAdmin
    .from("sale_workspaces")
    .select("*")
    .in("id", workspaceIds)
    .eq("sale_id", saleId)
    .maybeSingle();

  if (workspaceError) throw workspaceError;
  if (!workspace) return null;

  const collaborator = (collaboratorRows ?? []).find((row) => row.workspace_id === workspace.id);
  return {
    workspace,
    role: collaborator?.role ?? "viewer",
  };
}

async function getOwnerWorkspace({
  auth,
  saleId,
}: {
  auth: SupabaseAuthContext;
  saleId: string;
}): Promise<SaleWorkspaceRow | null> {
  const { data, error } = await auth.supabase
    .from("sale_workspaces")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("sale_id", saleId)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function listCollaborators(
  auth: SupabaseAuthContext,
  workspaceId: string,
): Promise<SaleWorkspaceCollaborator[]> {
  const { data, error } = await auth.supabase
    .from("sale_workspace_collaborators")
    .select("*")
    .eq("workspace_id", workspaceId)
    .neq("status", "revoked")
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

async function listAnnotations(
  auth: SupabaseAuthContext,
  workspaceId: string,
): Promise<SaleWorkspaceAnnotation[]> {
  const { data, error } = await auth.supabase
    .from("sale_workspace_annotations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return data ?? [];
}

function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
