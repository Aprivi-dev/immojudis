import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { ForbiddenError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import {
  loadProsecutedSalesForLawyerIds,
  parseLawyerIdsParam,
} from "@/lib/lawyer-prosecuted-sales.server";
import { hasStandingAnalysisAccess } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * Ventes à venir où chacun des avocats demandés est l'avocat poursuivant (point 72b). Réservé aux
 * comptes qui ont un droit PAYANT durable (abonnement Analyse actif, compte premium,
 * administrateur) : l'offre de lancement ne l'ouvre pas, comme pour le prix d'adjudication des
 * instantanés (`has_standing_analysis_access`). Refus 403 sans détail pour les autres comptes.
 *
 * Jamais de cache partagé : la réponse dépend du compte (droit payant durable) et le lien avocat
 * poursuivant ↔ vente ne doit pas être servi à un visiteur ou à un compte gratuit par un CDN.
 */
export const GET = apiRoute(
  {
    scope: "api.lawyers.prosecuted-sales",
    fallbackMessage: "Ventes à venir indisponibles",
    fallbackStatus: 503,
  },
  async (request, { api }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    if (!hasStandingAnalysisAccess(await resolvePlanEntitlements(auth))) {
      throw new ForbiddenError();
    }
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "lawyers.prosecuted-sales",
      ...RATE_LIMIT_POLICIES.compute,
      context: api,
    });
    const lawyerIds = parseLawyerIdsParam(new URL(request.url).searchParams.get("lawyerIds"));
    return loadProsecutedSalesForLawyerIds(lawyerIds);
  },
);
