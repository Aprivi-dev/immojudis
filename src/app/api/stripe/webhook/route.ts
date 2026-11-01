import { handleStripeWebhook } from "@/lib/billing";
import { PublicApiError } from "@/lib/api-errors";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

// Seules une signature absente ou invalide sont des erreurs de l'appelant (400). Toute autre panne
// (base, Stripe, configuration) répond 5xx pour que Stripe rejoue l'événement.
function isSignatureError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "StripeSignatureVerificationError"
  );
}

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.stripe.webhook");
  try {
    const signature = request.headers.get("stripe-signature");
    if (!signature) throw new PublicApiError("Signature Stripe manquante.", 400);

    const result = await handleStripeWebhook({
      payload: await request.text(),
      signature,
    });

    return apiJson({ received: true, ...result }, context);
  } catch (error) {
    if (isSignatureError(error)) {
      return apiError(new PublicApiError("Signature Stripe invalide.", 400), context, {
        fallbackMessage: "Signature Stripe invalide.",
      });
    }
    return apiError(error, context, {
      fallbackMessage: "Webhook Stripe indisponible.",
      fallbackStatus: 500,
    });
  }
}
