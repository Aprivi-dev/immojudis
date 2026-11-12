import { apiRoute } from "@/lib/api-route";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { getSharedSaleComparison } from "@/lib/sale-analysis-sets";

export const GET = apiRoute<{ token: string }>(
  {
    scope: "sale-analysis-sets.share.token",
    fallbackMessage: "Comparaison indisponible.",
    emptyBody: { comparison: null },
  },
  async (request, { params }) => {
    await enforceIpRateLimit({
      request,
      bucketKey: "sale-analysis-sets.share",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    return getSharedSaleComparison(params.token);
  },
);
