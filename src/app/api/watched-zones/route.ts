import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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
    return apiRouteError(error, request, "watched-zones", {
      fallbackMessage: "Zones surveillées indisponibles",
      extra: { zones: [] },
    });
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
    return apiRouteError(error, request, "watched-zones", {
      fallbackMessage: "Création de zone impossible",
      extra: { zone: null },
    });
  }
}
