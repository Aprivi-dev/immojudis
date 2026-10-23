import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { exportProfessionalPrivacyData } from "@/lib/privacy-requests";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const querySchema = z.object({ requestId: z.string().uuid() });

/**
 * Copie des données d'un professionnel sans compte qui a demandé l'accès par le lien signé de
 * l'email de l'agent d'information (messages, dossiers, pièces, registre).
 */
async function handleGET(request: Request) {
  const context = createApiRequestContext(
    request,
    "api.admin.privacy_requests.professional_export",
  );
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { requestId } = querySchema.parse({
      requestId: new URL(request.url).searchParams.get("requestId"),
    });
    return apiJson(await exportProfessionalPrivacyData({ auth, requestId }), context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Export impossible.",
      fallbackStatus: 400,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
