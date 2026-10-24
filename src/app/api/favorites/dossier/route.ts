import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { getFavoriteDossier, saveFavoriteDossier } from "@/lib/favorite-dossier";
import {
  favoriteDossierInputSchema,
  favoriteDossierQuerySchema,
} from "@/lib/favorite-dossier-input";

// « Mon dossier » gratuit (point 68) : statut personnel et enchère plafond d'une vente suivie.
// Ouvert à tout compte qui a les favoris ; la RLS de user_favorites tient la frontière (propriétaire
// seul, deux colonnes modifiables).

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const { saleId } = favoriteDossierQuerySchema.parse({
      saleId: url.searchParams.get("saleId"),
    });
    const response = await getFavoriteDossier({ auth, saleId });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorite-dossier", {
      fallbackMessage: "Dossier indisponible",
    });
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = favoriteDossierInputSchema.parse(await request.json());
    const response = await saveFavoriteDossier({ auth, input });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorite-dossier", {
      fallbackMessage: "Enregistrement du dossier impossible",
    });
  }
}
