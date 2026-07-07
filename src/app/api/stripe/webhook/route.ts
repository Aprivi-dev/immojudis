import { NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/billing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const result = await handleStripeWebhook({
      payload: await request.text(),
      signature: request.headers.get("stripe-signature"),
    });

    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook Stripe invalide";
    const status = message.includes("configur") ? 503 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
