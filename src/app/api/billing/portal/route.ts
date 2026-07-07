import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createBillingPortalSession } from "@/lib/billing";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const response = await createBillingPortalSession({ auth, origin: url.origin });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Portail d'abonnement indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("configur")
        ? 503
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
