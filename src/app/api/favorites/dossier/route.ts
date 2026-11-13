import { apiRoute } from "@/lib/api-route";
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

export const GET = apiRoute(
  { scope: "api.favorites.dossier.read", fallbackMessage: "Dossier indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const { saleId } = favoriteDossierQuerySchema.parse({
      saleId: url.searchParams.get("saleId"),
    });
    return getFavoriteDossier({ auth, saleId });
  },
);

export const PUT = apiRoute(
  { scope: "api.favorites.dossier.save", fallbackMessage: "Enregistrement du dossier impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = favoriteDossierInputSchema.parse(await request.json());
    return saveFavoriteDossier({ auth, input });
  },
);
