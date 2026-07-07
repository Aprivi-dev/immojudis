import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Favoris indisponibles";
    return NextResponse.json(
      { favorites: [], error: message },
      { status: statusFromErrorMessage(message) },
    );
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
    const message = error instanceof Error ? error.message : "Ajout aux favoris impossible";
    return NextResponse.json(
      { favorite: null, error: message },
      { status: statusFromErrorMessage(message) },
    );
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
    const message = error instanceof Error ? error.message : "Retrait des favoris impossible";
    return NextResponse.json(
      { ok: false, error: message },
      { status: statusFromErrorMessage(message) },
    );
  }
}

function statusFromErrorMessage(message: string): number {
  if (message.startsWith("Unauthorized")) return 401;
  if (message.includes("réservés")) return 403;
  return 400;
}
