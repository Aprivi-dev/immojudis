import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  deleteFollowedSaleSnapshot,
  listFollowedSaleSnapshots,
  updateFollowedSaleSnapshot,
} from "@/lib/followed-sale-snapshots";
import {
  followedSaleSnapshotDeleteSchema,
  followedSaleSnapshotUpdateSchema,
} from "@/lib/followed-sale-snapshots-shared";

// Après l'audience (point 70) : instantanés des ventes suivies, gardés 6 mois au plus dans l'espace
// du compte. Lecture, suppression et bilan (statut, prix final) par le propriétaire seul (RLS) ;
// l'API ne crée jamais d'instantané.

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

export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = followedSaleSnapshotUpdateSchema.parse(await request.json());
    const response = await updateFollowedSaleSnapshot({ auth, input });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorite-snapshots", {
      fallbackMessage: "Enregistrement du bilan impossible",
    });
  }
}
