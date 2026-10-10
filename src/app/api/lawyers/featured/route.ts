import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { PUBLIC_DIRECTORY_CACHE_SECONDS, RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  featuredLawyerQuerySchema,
  getFeaturedReferencedLawyerForSale,
} from "@/lib/featured-lawyers";

export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "lawyers.featured",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const url = new URL(request.url);
    const query = featuredLawyerQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
    });

    return NextResponse.json(await getFeaturedReferencedLawyerForSale(query), {
      headers: {
        "cache-control": `public, s-maxage=${PUBLIC_DIRECTORY_CACHE_SECONDS}, stale-while-revalidate=300`,
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "lawyers.featured", {
      fallbackMessage: "Avocat référencé indisponible sur ce secteur",
      extra: { lawyer: null },
    });
  }
}
