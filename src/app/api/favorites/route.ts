import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
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

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const response = await listFavoriteSales({ auth });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorites", {
      fallbackMessage: "Favoris indisponibles",
      extra: { favorites: [] },
    });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = favoriteSaleInputSchema.parse(await request.json());
    const response = await addFavoriteSale({ auth, input });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorites", {
      fallbackMessage: "Ajout aux favoris impossible",
      extra: { favorite: null },
    });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const input = favoriteSaleInputSchema.parse({ saleId: url.searchParams.get("saleId") });
    const response = await removeFavoriteSale({ auth, input });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "favorites", {
      fallbackMessage: "Retrait des favoris impossible",
    });
  }
}
