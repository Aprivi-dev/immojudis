import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createBillingPortalSession } from "@/lib/billing";
import { billingPortalRequestSchema } from "@/lib/billing-portal-request";
import { apiRoute } from "@/lib/api-route";

export const POST = apiRoute(
  { scope: "api.billing.portal", fallbackMessage: "Portail de paiement indisponible." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    // The body is optional: the historical call (no body) opens the generic portal.
    const rawBody = await request.text();
    const { intent } = billingPortalRequestSchema.parse(rawBody.trim() ? JSON.parse(rawBody) : {});
    return createBillingPortalSession({ auth, origin: url.origin, intent });
  },
);
