import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  featuredLawyerQuerySchema,
  getFeaturedReferencedLawyerForSale,
} from "@/lib/featured-lawyers";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = featuredLawyerQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
    });

    return NextResponse.json(await getFeaturedReferencedLawyerForSale(query));
  } catch (error) {
    return apiRouteError(error, request, "lawyers.featured", {
      fallbackMessage: "Avocat référencé indisponible sur ce secteur",
      extra: { lawyer: null },
    });
  }
}
