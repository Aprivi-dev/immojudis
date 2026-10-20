import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiJson, apiRouteError, createApiRequestContext } from "@/lib/api-observability";
import {
  loadProsecutedSalesForLawyerIds,
  parseLawyerIdsParam,
} from "@/lib/lawyer-prosecuted-sales.server";
import { hasStandingAnalysisAccess } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

// Jamais de cache partagé : la réponse dépend du compte (droit payant durable) et le lien avocat
// poursuivant ↔ vente ne doit pas être servi à un visiteur ou à un compte gratuit par un CDN.
const PRIVATE_AUTH_HEADERS = {
  "cache-control": "private, no-store",
  vary: "authorization",
};

/**
 * Ventes à venir où chacun des avocats demandés est l'avocat poursuivant (point 72b). Réservé aux
 * comptes qui ont un droit PAYANT durable (abonnement Analyse actif, compte premium,
 * administrateur) : l'offre de lancement ne l'ouvre pas, comme pour le prix d'adjudication des
 * instantanés (`has_standing_analysis_access`). Refus 403 sans détail pour les autres comptes.
 */
export async function GET(request: Request) {
  const context = createApiRequestContext(request, "lawyers.prosecuted_sales");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    if (!hasStandingAnalysisAccess(await resolvePlanEntitlements(auth))) {
      throw new PublicApiError("Accès refusé.", 403);
    }
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyers.prosecuted-sales",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const lawyerIds = parseLawyerIdsParam(new URL(request.url).searchParams.get("lawyerIds"));
    return apiJson(await loadProsecutedSalesForLawyerIds(lawyerIds), context, {
      headers: PRIVATE_AUTH_HEADERS,
    });
  } catch (error) {
    return apiRouteError(error, request, "lawyers.prosecuted_sales", {
      fallbackMessage: "Ventes à venir indisponibles",
      fallbackStatus: 503,
    });
  }
}
