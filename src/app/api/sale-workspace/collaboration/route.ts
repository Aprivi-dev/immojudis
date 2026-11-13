import { apiRoute } from "@/lib/api-route";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  acceptSaleWorkspaceInvitation,
  collaboratorAcceptSchema,
  collaboratorInviteSchema,
  collaboratorRevokeSchema,
  createSaleWorkspaceAnnotation,
  inviteSaleWorkspaceCollaborator,
  listSaleWorkspaceCollaboration,
  revokeSaleWorkspaceCollaborator,
  updateSaleWorkspaceAnnotation,
  workspaceAnnotationCreateSchema,
  workspaceAnnotationUpdateSchema,
} from "@/lib/sale-workspace-collaboration";

const saleIdSchema = z.string().guid();

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("invite"),
    data: collaboratorInviteSchema,
  }),
  z.object({
    action: z.literal("accept"),
    data: collaboratorAcceptSchema,
  }),
  z.object({
    action: z.literal("annotate"),
    data: workspaceAnnotationCreateSchema,
  }),
]);

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("revoke"),
    data: collaboratorRevokeSchema,
  }),
  z.object({
    action: z.literal("update_annotation"),
    data: workspaceAnnotationUpdateSchema,
  }),
]);

const scope = "sale-workspace.collaboration";

export const GET = apiRoute(
  { scope, fallbackMessage: "Dossier collaboratif indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const saleId = saleIdSchema.parse(url.searchParams.get("saleId"));
    return listSaleWorkspaceCollaboration({ auth, saleId });
  },
);

export const POST = apiRoute(
  { scope, fallbackMessage: "Action collaborative impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = postSchema.parse(await request.json());

    if (input.action === "invite") {
      return inviteSaleWorkspaceCollaborator({ auth, input: input.data });
    }
    if (input.action === "accept") {
      return acceptSaleWorkspaceInvitation({ auth, input: input.data });
    }
    return createSaleWorkspaceAnnotation({ auth, input: input.data });
  },
);

export const PATCH = apiRoute(
  { scope, fallbackMessage: "Mise à jour collaborative impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = patchSchema.parse(await request.json());

    if (input.action === "revoke") {
      return revokeSaleWorkspaceCollaborator({ auth, input: input.data });
    }
    return updateSaleWorkspaceAnnotation({ auth, input: input.data });
  },
);
