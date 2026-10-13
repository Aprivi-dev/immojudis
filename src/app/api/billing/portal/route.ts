import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createBillingPortalSession } from "@/lib/billing";
import { billingPortalRequestSchema } from "@/lib/billing-portal-request";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.billing.portal");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    // The body is optional: the historical call (no body) opens the generic portal.
    const rawBody = await request.text();
    const { intent } = billingPortalRequestSchema.parse(rawBody.trim() ? JSON.parse(rawBody) : {});
    const response = await createBillingPortalSession({ auth, origin: url.origin, intent });
    return apiJson(response, context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Portail de paiement indisponible.",
      fallbackStatus: 400,
    });
  }
}
