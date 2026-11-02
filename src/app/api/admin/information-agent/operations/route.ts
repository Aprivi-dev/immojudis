import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  attestAdminInformationAgentRoundtrip,
  getAdminInformationAgentOperations,
} from "@/lib/admin-information-agent-operations";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Indicateurs d'exploitation (30 jours) et état de la vérification de l'aller-retour, déjà mis en forme. */
async function handleGET(request: Request) {
  try {
    const response = await getAdminInformationAgentOperations(bearerTokenFromRequest(request));
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** « J'ai vérifié l'aller-retour réel » : enregistre la date. N'envoie rien. */
async function handlePOST(request: Request) {
  try {
    const response = await attestAdminInformationAgentRoundtrip(bearerTokenFromRequest(request));
    return NextResponse.json(response, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
