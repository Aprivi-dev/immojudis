import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { deleteWatchedZone, updateWatchedZone, watchedZoneUpdateSchema } from "@/lib/watched-zones";

const zoneIdSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await context.params;
    const zoneId = zoneIdSchema.parse(id);
    const input = watchedZoneUpdateSchema.parse(await request.json());
    const response = await updateWatchedZone({ auth, zoneId, input });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "watched-zones.id", {
      fallbackMessage: "Mise à jour de zone impossible",
      extra: { zone: null },
    });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await context.params;
    const zoneId = zoneIdSchema.parse(id);
    const response = await deleteWatchedZone({ auth, zoneId });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "watched-zones.id", {
      fallbackMessage: "Suppression de zone impossible",
    });
  }
}
