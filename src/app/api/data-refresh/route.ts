import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  dataRefreshListQuerySchema,
  dataRefreshRequestSchema,
  listDataRefreshRequests,
  requestDataRefresh,
} from "@/lib/data-refresh";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = dataRefreshListQuerySchema.parse(Object.fromEntries(url.searchParams.entries()));
    const response = await listDataRefreshRequests({ auth, input });

    return NextResponse.json(response, {
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-refresh-count": String(response.requests.length),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Demandes de refresh indisponibles";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = dataRefreshRequestSchema.parse(await request.json());
    const response = await requestDataRefresh({ auth, input });

    return NextResponse.json(response, {
      status: 202,
      headers: {
        "cache-control": "private, no-store",
        "x-immojudis-refresh-count": String(response.requests.length),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Refresh DPE/cadastre impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réserv")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
