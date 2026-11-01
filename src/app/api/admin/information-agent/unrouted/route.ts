import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentUnroutedActionSchema,
  adminInformationAgentUnroutedQuerySchema,
  listAdminInformationAgentUnrouted,
  runAdminInformationAgentUnroutedAction,
} from "@/lib/admin-information-agent";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Messages reçus sans dossier ouvert, encore à traiter (`offset` / `limit`, 50 par défaut). */
async function handleGET(request: Request) {
  try {
    const input = adminInformationAgentUnroutedQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const response = await listAdminInformationAgentUnrouted(
      bearerTokenFromRequest(request),
      input,
    );
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** « Marquer comme traité » : la seule action ; aucun envoi, aucune extraction. */
async function handlePOST(request: Request) {
  try {
    const authToken = bearerTokenFromRequest(request);
    const input = adminInformationAgentUnroutedActionSchema.parse(await request.json());
    const response = await runAdminInformationAgentUnroutedAction({ authToken, input });
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
