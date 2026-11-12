import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createPlanCheckoutSession, resolveCheckoutPlanCode } from "@/lib/billing";
import { apiRoute } from "@/lib/api-route";
import { checkoutConsentSchema } from "@/lib/commercial-acceptance";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

export const POST = apiRoute(
  { scope: "api.billing.checkout", fallbackMessage: "Paiement indisponible." },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    // Chaque appel ouvre une session de paiement chez Stripe : 10 par heure et par compte, avant
    // toute lecture du corps.
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "billing.checkout",
      ...RATE_LIMIT_POLICIES.formSubmit,
      context: api,
    });
    const url = new URL(request.url);
    const body = (await request.json()) as { plan?: unknown; consent?: unknown } | null;
    const plan = resolveCheckoutPlanCode(body?.plan ?? url.searchParams.get("plan"));
    const consent = checkoutConsentSchema.parse(body?.consent);
    return createPlanCheckoutSession({
      auth,
      origin: url.origin,
      plan,
      consent,
      requestId: api.requestId,
      userAgent: request.headers.get("user-agent"),
    });
  },
);
