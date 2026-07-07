import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createPlanCheckoutSession, resolveCheckoutPlanCode } from "@/lib/billing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const body = (await request.json().catch(() => null)) as { plan?: unknown } | null;
    const plan = resolveCheckoutPlanCode(body?.plan ?? url.searchParams.get("plan"));
    const response = await createPlanCheckoutSession({ auth, origin: url.origin, plan });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Paiement indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("configur")
        ? 503
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
