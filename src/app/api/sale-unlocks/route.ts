import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRouteError } from "@/lib/api-observability";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { SaleUnlocksOverview } from "@/lib/sale-unlocks";
import { getSaleUnlockStatus, listUnlockedSales } from "@/lib/sale-unlocks.server";

const PRIVATE_HEADERS = { "cache-control": "private, no-store", vary: "authorization" };

/**
 * « 3 déblocages par mois » vus du compte : où il en est ce mois-ci (utilisés, remise à zéro) et
 * la liste des ventes qu'il a débloquées et qui sont toujours en ligne. Sert la page Mon compte,
 * « Mes ventes débloquées » et la pastille « Débloquée » des résultats. Lecture seule : rien n'est
 * consommé, et seules les lignes du compte connecté sont lisibles.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-unlocks-overview",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const [status, sales] = await Promise.all([getSaleUnlockStatus(auth), listUnlockedSales(auth)]);
    const overview: SaleUnlocksOverview = { status, sales };
    return NextResponse.json(overview, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return apiRouteError(error, request, "sale-unlocks-overview", {
      fallbackMessage: "Vos déblocages sont indisponibles.",
    });
  }
}
