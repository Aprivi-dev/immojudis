import { NextResponse } from "next/server";
import { processInformationAgentInboundWebhook } from "@/lib/information-agent-inbound";
import { logInformationAgentRouteError } from "@/lib/information-agent-route-log";

export async function POST(request: Request) {
  try {
    const result = await processInformationAgentInboundWebhook({
      request,
      deferProcessing: true,
    });
    return NextResponse.json(result, { status: result.processingStatus === "queued" ? 202 : 200 });
  } catch (error) {
    const payloadTooLarge =
      error instanceof Error && error.name === "InformationAgentWebhookPayloadTooLargeError";
    const invalidSignature =
      error instanceof Error && error.name === "InvalidInformationAgentWebhookSignatureError";
    // Les erreurs du fournisseur ou de la base arrivent ici en 500 : on les garde, sans message
    // (il peut citer une adresse ou un contenu).
    if (!payloadTooLarge && !invalidSignature) {
      logInformationAgentRouteError("information-agent.inbound-webhook", error);
    }
    return NextResponse.json(
      {
        error: payloadTooLarge
          ? "Webhook trop volumineux."
          : invalidSignature
            ? "Signature webhook invalide."
            : "Réception email impossible.",
      },
      { status: payloadTooLarge ? 413 : invalidSignature ? 400 : 500 },
    );
  }
}
