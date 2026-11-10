import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminAutoPublicationActionSchema,
  getAdminAutoPublicationView,
  runAdminAutoPublicationAction,
} from "@/lib/admin-information-agent-auto-publication";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Mode de la publication automatique (arrêt, simulation ; automatique verrouillé) et changements récents. */
async function handleGET(request: Request) {
  try {
    const response = await getAdminAutoPublicationView(bearerTokenFromRequest(request));
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** Changement de mode ou arrêt d'urgence (administrateur, tracé en base). */
async function handlePOST(request: Request) {
  try {
    const authToken = bearerTokenFromRequest(request);
    const input = adminAutoPublicationActionSchema.parse(await request.json());
    const response = await runAdminAutoPublicationAction({ authToken, input });
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
