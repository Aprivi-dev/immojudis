import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { getSharedSaleComparison } from "@/lib/sale-analysis-sets";

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    const comparison = await getSharedSaleComparison(token);
    return NextResponse.json(comparison, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "sale-analysis-sets.share.token", {
      fallbackMessage: "Comparaison indisponible",
      fallbackStatus: 404,
      extra: { comparison: null },
    });
  }
}
