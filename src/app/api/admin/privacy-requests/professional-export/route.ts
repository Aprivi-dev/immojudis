import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { adminRoute } from "@/lib/admin-route-deadline";
import { exportProfessionalPrivacyData } from "@/lib/privacy-requests";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const querySchema = z.object({ requestId: z.string().guid() });

/**
 * Copie des données d'un professionnel sans compte qui a demandé l'accès par le lien signé de
 * l'email de l'agent d'information (messages, dossiers, pièces, registre).
 */
export const GET = adminRoute(
  {
    scope: "api.admin.privacy_requests.professional_export",
    fallbackMessage: "Export impossible.",
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { requestId } = querySchema.parse({
      requestId: new URL(request.url).searchParams.get("requestId"),
    });
    return exportProfessionalPrivacyData({ auth, requestId });
  },
);
