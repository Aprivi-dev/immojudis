import { NextResponse } from "next/server";
import { processInformationAgentInboundWebhook } from "@/lib/information-agent-inbound";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const result = await processInformationAgentInboundWebhook({ request });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook entrant invalide.";
    const invalidSignature = /signature|webhook/i.test(message);
    return NextResponse.json(
      { error: invalidSignature ? "Signature webhook invalide." : "Réception email impossible." },
      { status: invalidSignature ? 400 : 500 },
    );
  }
}
