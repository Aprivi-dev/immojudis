import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createBillingPortalSession } from "@/lib/billing";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.billing.portal");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const response = await createBillingPortalSession({ auth, origin: url.origin });
    return apiJson(response, context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Portail de paiement indisponible.",
      fallbackStatus: 400,
    });
  }
}
