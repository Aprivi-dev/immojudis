import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  addFavoriteSale,
  favoriteSaleInputSchema,
  listFavoriteSales,
  removeFavoriteSale,
} from "@/lib/favorites";

export const GET = apiRoute(
  {
    scope: "api.favorites.list",
    fallbackMessage: "Favoris indisponibles",
    emptyBody: { favorites: [] },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return listFavoriteSales({ auth });
  },
);

export const POST = apiRoute(
  {
    scope: "api.favorites.add",
    fallbackMessage: "Ajout aux favoris impossible",
    emptyBody: { favorite: null },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = favoriteSaleInputSchema.parse(await request.json());
    return addFavoriteSale({ auth, input });
  },
);

export const DELETE = apiRoute(
  { scope: "api.favorites.remove", fallbackMessage: "Retrait des favoris impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = favoriteSaleInputSchema.parse({ saleId: url.searchParams.get("saleId") });
    return removeFavoriteSale({ auth, input });
  },
);
