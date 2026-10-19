import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  deleteFollowedSaleSnapshot,
  listFollowedSaleSnapshots,
} from "@/lib/followed-sale-snapshots";
import { followedSaleSnapshotDeleteSchema } from "@/lib/followed-sale-snapshots-shared";

// Après l'audience (point 70) : instantanés des ventes suivies, gardés 6 mois au plus dans l'espace
// du compte. Lecture et suppression par le propriétaire seul (RLS) ; aucune écriture par l'API.

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await listFollowedSaleSnapshots({ auth });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorite-snapshots", {
      fallbackMessage: "Ventes passées indisponibles",
      extra: { snapshots: [] },
    });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const { id } = followedSaleSnapshotDeleteSchema.parse({ id: url.searchParams.get("id") });
    const response = await deleteFollowedSaleSnapshot({ auth, id });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorite-snapshots", {
      fallbackMessage: "Retrait impossible",
    });
  }
}
