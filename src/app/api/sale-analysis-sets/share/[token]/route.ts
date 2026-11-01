import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { getSharedSaleComparison } from "@/lib/sale-analysis-sets";

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "sale-analysis-sets.share",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const { token } = await context.params;
    const comparison = await getSharedSaleComparison(token);
    return NextResponse.json(comparison, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    // Un lien inconnu ou expiré reste un 404 (message métier) ; une panne de lecture est un 500.
    return apiRouteError(error, request, "sale-analysis-sets.share.token", {
      fallbackMessage: "Comparaison indisponible.",
      fallbackStatus: 500,
      extra: { comparison: null },
    });
  }
}
