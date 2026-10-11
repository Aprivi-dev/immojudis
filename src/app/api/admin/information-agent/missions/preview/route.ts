import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentPreviewSchema,
  previewAdminInformationAgentMissionForToken,
} from "@/lib/admin-information-agent";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Aperçu exact de l'e-mail d'une mission (HTML et texte, pied RGPD, liens) et motifs qui
 * bloqueraient l'envoi. Ne modifie rien et n'envoie rien : l'empreinte rendue est exigée par
 * « Valider et envoyer », qui reste la seule action d'envoi.
 */
async function handlePOST(request: Request) {
  try {
    const input = adminInformationAgentPreviewSchema.parse(await request.json());
    const response = await previewAdminInformationAgentMissionForToken({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const POST = withAdminDeadline(handlePOST);
