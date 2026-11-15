import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createSaleUnlockCheckoutSession } from "@/lib/billing";
import { apiRoute } from "@/lib/api-route";
import { saleUnlockConsentSchema } from "@/lib/commercial-acceptance";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { SaleUnlockPurchaseRefusedError } from "@/lib/sale-unlock-purchase";

const bodySchema = z.object({
  saleId: z.string().guid(),
  consent: saleUnlockConsentSchema,
});

/**
 * Ouvre la session Stripe Checkout de l'achat du déblocage d'une vente (19 € TTC). Réponses :
 * `{ url }` ; 409 `{ error, code }` quand la base refuse l'achat (`code` : voir
 * `SALE_UNLOCK_PURCHASE_REFUSAL_CODES`) ; 503 quand l'achat n'est pas ouvert. Le déblocage n'est
 * accordé que par le webhook Stripe.
 */
export const POST = apiRoute(
  { scope: "api.billing.sale-unlock-checkout", fallbackMessage: "Paiement indisponible." },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    // Même limite que le checkout d'abonnement : chaque appel peut ouvrir une session chez Stripe.
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "billing.sale-unlock-checkout",
      ...RATE_LIMIT_POLICIES.formSubmit,
      context: api,
    });
    const body = bodySchema.parse(await request.json());
    try {
      return await createSaleUnlockCheckoutSession({
        auth,
        origin: new URL(request.url).origin,
        saleId: body.saleId,
        consent: body.consent,
        requestId: api.requestId,
        userAgent: request.headers.get("user-agent"),
      });
    } catch (error) {
      if (!(error instanceof SaleUnlockPurchaseRefusedError)) throw error;
      // Le client lit `code` pour expliquer le refus : corps propre à ce 409.
      return NextResponse.json(error.refusal, { status: 409 });
    }
  },
);
