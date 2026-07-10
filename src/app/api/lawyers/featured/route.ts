import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  featuredLawyerQuerySchema,
  getFeaturedReferencedLawyerForSale,
} from "@/lib/featured-lawyers";
import { assertFeatureEntitlement } from "@/lib/property-reports";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "lawyers.directory",
      "Annuaire d'avocats réservé au plan Analyse.",
    );
    const url = new URL(request.url);
    const query = featuredLawyerQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
    });

    return NextResponse.json(await getFeaturedReferencedLawyerForSale(query));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Avocat référencé indisponible sur ce secteur";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réserv")
        ? 403
        : message.includes("introuvable")
          ? 404
          : 400;
    return NextResponse.json({ lawyer: null, error: message }, { status });
  }
}
