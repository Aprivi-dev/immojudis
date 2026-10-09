import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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

const saleIdSchema = z.string().uuid();

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

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const saleId = saleIdSchema.parse(url.searchParams.get("saleId"));
    const response = await listSaleWorkspaceCollaboration({ auth, saleId });
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(request, error, "Dossier collaboratif indisponible");
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = postSchema.parse(await request.json());

    if (input.action === "invite") {
      return NextResponse.json(await inviteSaleWorkspaceCollaborator({ auth, input: input.data }));
    }
    if (input.action === "accept") {
      return NextResponse.json(await acceptSaleWorkspaceInvitation({ auth, input: input.data }));
    }

    return NextResponse.json(await createSaleWorkspaceAnnotation({ auth, input: input.data }));
  } catch (error) {
    return errorResponse(request, error, "Action collaborative impossible");
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = patchSchema.parse(await request.json());

    if (input.action === "revoke") {
      return NextResponse.json(await revokeSaleWorkspaceCollaborator({ auth, input: input.data }));
    }

    return NextResponse.json(await updateSaleWorkspaceAnnotation({ auth, input: input.data }));
  } catch (error) {
    return errorResponse(request, error, "Mise à jour collaborative impossible");
  }
}

function errorResponse(request: Request, error: unknown, fallback: string) {
  return apiRouteError(error, request, "sale-workspace.collaboration", {
    fallbackMessage: fallback,
  });
}
