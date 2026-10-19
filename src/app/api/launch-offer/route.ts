import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import { LAUNCH_OFFER_CACHE_SECONDS, type LaunchOfferResponse } from "@/lib/launch-offer";
import { isLaunchOfferActive } from "@/lib/launch-offer.server";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * État public de l'offre de lancement (`app_private.launch_offer`, lu par le RPC
 * `get_launch_offer_status`). Identique pour tout le monde et sans donnée personnelle : mis en cache
 * au CDN 30 s, en plus des 30 s du cache du serveur (`launch-offer.server.ts`). Une coupure de
 * l'offre se voit donc en une minute au plus.
 */
export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.launch-offer");
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "launch-offer.status",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const body: LaunchOfferResponse = { active: await isLaunchOfferActive() };
    return apiJson(body, context, {
      headers: { "cache-control": `public, s-maxage=${LAUNCH_OFFER_CACHE_SECONDS}` },
    });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Offre de lancement indisponible.",
      fallbackStatus: 503,
    });
  }
}
