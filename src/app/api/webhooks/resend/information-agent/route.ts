import { NextResponse } from "next/server";
import { processInformationAgentInboundWebhook } from "@/lib/information-agent-inbound";
import { logInformationAgentRouteError } from "@/lib/information-agent-route-log";
import { resendWebhookErrorResponse } from "@/lib/resend-webhook";

export async function POST(request: Request) {
  try {
    const result = await processInformationAgentInboundWebhook({
      request,
      deferProcessing: true,
    });
    return NextResponse.json(result, {
      status: result.processingStatus === "queued" ? 202 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return resendWebhookErrorResponse(error, "Réception email impossible.", (failure) =>
      logInformationAgentRouteError("information-agent.inbound-webhook", failure),
    );
  }
}
