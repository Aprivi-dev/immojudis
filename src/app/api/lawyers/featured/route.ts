import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  featuredLawyerQuerySchema,
  getFeaturedReferencedLawyerForSale,
} from "@/lib/featured-lawyers";

export const GET = apiRoute(
  {
    scope: "api.lawyers.featured",
    fallbackMessage: "Avocat référencé indisponible sur ce secteur",
    emptyBody: { lawyer: null },
  },
  async (request) => {
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
        // Same for every visitor of the sale: the edge may keep it for an hour.
        "cache-control": "public, s-maxage=3600, stale-while-revalidate=300",
      },
    });
  },
);
