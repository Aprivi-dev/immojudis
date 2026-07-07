import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { evaluateUserAlertMatches, listUserAlertMatches } from "@/lib/alert-matches";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const includeDismissed = url.searchParams.get("includeDismissed") === "true";
    const response = await listUserAlertMatches({ auth, limit, includeDismissed });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Matches d'alertes indisponibles";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const body = (await request.json().catch(() => ({}))) as {
      saleLimit?: number;
      persist?: boolean;
    };
    const response = await evaluateUserAlertMatches({
      auth,
      saleLimit: body.saleLimit,
      persist: body.persist ?? true,
    });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Évaluation des alertes impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservées")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
