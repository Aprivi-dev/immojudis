import { NextResponse } from "next/server";
import { processAccountEmailDeliveryWebhook } from "@/lib/account-email-delivery-events";

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
    const name = error instanceof Error ? error.name : "";
    const payloadTooLarge = name === "AccountEmailWebhookPayloadTooLargeError";
    const invalidSignature = name === "InvalidAccountEmailWebhookSignatureError";
    // Les erreurs de la base arrivent ici en 500 : le fournisseur rejoue l'évènement. On les garde dans
    // le journal, sans message (il peut citer une adresse).
    if (!payloadTooLarge && !invalidSignature) {
      console.error(
        JSON.stringify({
          scope: "account-email-delivery",
          level: "error",
          event: "webhook_failed",
          errorName: name || "Error",
        }),
      );
    }
    return NextResponse.json(
      {
        error: payloadTooLarge
          ? "Webhook trop volumineux."
          : invalidSignature
            ? "Signature webhook invalide."
            : "Traitement de l’évènement impossible.",
      },
      {
        status: payloadTooLarge ? 413 : invalidSignature ? 400 : 500,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
