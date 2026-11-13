import { apiRoute } from "@/lib/api-route";
import { getSharedPropertyReport } from "@/lib/property-reports";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

export const GET = apiRoute<{ token: string }>(
  { scope: "api.property-reports.share.read", fallbackMessage: "Rapport partagé indisponible." },
  async (request, { params }) => {
    await enforceIpRateLimit({
      request,
      bucketKey: "property-reports.share",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const report = await getSharedPropertyReport({ token: params.token });
    return { report };
  },
);
