import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createPlanCheckoutSession, resolveCheckoutPlanCode } from "@/lib/billing";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { checkoutConsentSchema } from "@/lib/commercial-acceptance";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.billing.checkout");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    // Chaque appel ouvre une session de paiement chez Stripe : 10 par heure et par compte, avant
    // toute lecture du corps.
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "billing.checkout",
      ...RATE_LIMIT_POLICIES.formSubmit,
      context,
    });
    const url = new URL(request.url);
    const body = (await request.json().catch(() => null)) as {
      plan?: unknown;
      consent?: unknown;
    } | null;
    const plan = resolveCheckoutPlanCode(body?.plan ?? url.searchParams.get("plan"));
    const consent = checkoutConsentSchema.parse(body?.consent);
    const response = await createPlanCheckoutSession({
      auth,
      origin: url.origin,
      plan,
      consent,
      requestId: context.requestId,
      userAgent: request.headers.get("user-agent"),
    });
    return apiJson(response, context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Paiement indisponible.",
      fallbackStatus: 400,
    });
  }
}
