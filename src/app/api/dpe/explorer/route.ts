import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { dpeExplorerQuerySchema, getDpeExplorer } from "@/lib/dpe-explorer";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = dpeExplorerQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await getDpeExplorer({ auth, input });

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-dpe-count": String(response.summary.total),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Explorateur DPE indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réserv")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
