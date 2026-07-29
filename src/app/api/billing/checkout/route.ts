import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createPlanCheckoutSession, resolveCheckoutPlanCode } from "@/lib/billing";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.billing.checkout");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const body = (await request.json().catch(() => null)) as { plan?: unknown } | null;
    const plan = resolveCheckoutPlanCode(body?.plan ?? url.searchParams.get("plan"));
    const response = await createPlanCheckoutSession({ auth, origin: url.origin, plan });
    return apiJson(response, context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Paiement indisponible.",
      fallbackStatus: 400,
    });
  }
}
