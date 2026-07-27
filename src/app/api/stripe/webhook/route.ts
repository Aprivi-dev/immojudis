import { handleStripeWebhook } from "@/lib/billing";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.stripe.webhook");
  try {
    const result = await handleStripeWebhook({
      payload: await request.text(),
      signature: request.headers.get("stripe-signature"),
    });

    return apiJson({ received: true, ...result }, context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Webhook Stripe invalide.",
      fallbackStatus: 400,
    });
  }
}
