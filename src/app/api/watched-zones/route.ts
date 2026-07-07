import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createWatchedZone, listWatchedZones, watchedZoneInputSchema } from "@/lib/watched-zones";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    const response = await listWatchedZones({ auth, includeInactive });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Zones surveillées indisponibles";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservées")
        ? 403
        : 400;
    return NextResponse.json({ zones: [], error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = watchedZoneInputSchema.parse(await request.json());
    const response = await createWatchedZone({ auth, input });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Création de zone impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservées")
        ? 403
        : 400;
    return NextResponse.json({ zone: null, error: message }, { status });
  }
}
