import { NextResponse } from "next/server";
import { processInformationAgentInboundWebhook } from "@/lib/information-agent-inbound";

export const runtime = "nodejs";

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
