import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api-route";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { PUBLIC_DIRECTORY_CACHE_SECONDS, RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
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
        "cache-control": `public, s-maxage=${PUBLIC_DIRECTORY_CACHE_SECONDS}, stale-while-revalidate=300`,
      },
    });
  },
);
