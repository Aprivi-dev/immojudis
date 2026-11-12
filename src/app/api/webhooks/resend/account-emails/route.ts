import { NextResponse } from "next/server";
import { processAccountEmailDeliveryWebhook } from "@/lib/account-email-delivery-events";
import { resendWebhookErrorResponse } from "@/lib/resend-webhook";

/**
 * Webhook Resend (signature Svix) des rebonds et plaintes des emails envoyés aux comptes. À abonner
 * aux évènements `email.bounced` et `email.complained` dans Resend, avec son propre secret de
 * signature `RESEND_ACCOUNT_WEBHOOK_SECRET`. Voir docs/runbooks/rebonds-plaintes-emails.md.
 */
export async function POST(request: Request) {
  try {
    const result = await processAccountEmailDeliveryWebhook({ request });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return resendWebhookErrorResponse(error, "Traitement de l’évènement impossible.", (failure) =>
      console.error(
        JSON.stringify({
          scope: "account-email-delivery",
          level: "error",
          event: "webhook_failed",
          errorName: failure instanceof Error ? failure.name : "Error",
        }),
      ),
    );
  }
}
