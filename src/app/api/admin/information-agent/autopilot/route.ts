import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminAutopilotActionSchema,
  getAdminAutopilotView,
  runAdminAutopilotAction,
} from "@/lib/admin-information-agent-autopilot";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** État du pilote automatique, déjà mis en forme (mode, compteurs, contrôle de préparation, journal). */
async function handleGET(request: Request) {
  try {
    const response = await getAdminAutopilotView(bearerTokenFromRequest(request));
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** Mode, réglages, arrêt d'urgence, attestation d'AIPD : toujours journalisés, motif obligatoire. */
async function handlePOST(request: Request) {
  try {
    const authToken = bearerTokenFromRequest(request);
    const input = adminAutopilotActionSchema.parse(await request.json());
    const response = await runAdminAutopilotAction({ authToken, input });
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
