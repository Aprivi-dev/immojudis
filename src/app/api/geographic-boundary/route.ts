import { NextResponse } from "next/server";
import { PublicApiError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  fetchGeographicBoundary,
  GeographicBoundaryUpstreamError,
} from "@/lib/geographic-boundary";

const UNAVAILABLE = "Contour géographique temporairement indisponible.";

/**
 * Proxy the public French administrative geography API so the map can request
 * a contour without depending on third-party CORS configuration. The proxy
 * deliberately returns no sale data and accepts only a short search label.
 */
export const GET = apiRoute(
  {
    scope: "geographic-boundary",
    fallbackMessage: UNAVAILABLE,
    // Toute panne, du service de l'État comme de notre côté, rend la carte sans contour.
    fallbackStatus: 503,
    emptyBody: { boundary: null },
  },
  async (request) => {
    await enforceIpRateLimit({
      request,
      bucketKey: "geographic-boundary",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const label = new URL(request.url).searchParams.get("label")?.trim() ?? "";
    if (!label || label.length > 120) {
      throw new PublicApiError("Libellé géographique invalide.", 400);
    }

    let boundary: Awaited<ReturnType<typeof fetchGeographicBoundary>>;
    try {
      boundary = await fetchGeographicBoundary(label);
    } catch (error) {
      // Panne attendue du service de l'État : son message (« Réponse GeoJSON invalide. ») ne part pas.
      if (error instanceof GeographicBoundaryUpstreamError) {
        throw new PublicApiError(UNAVAILABLE, 503, { cause: error });
      }
      throw error;
    }
    return NextResponse.json(
      {
        boundary,
        requestedLabel: label,
        source: boundary?.sourceUrl ?? "geo.api.gouv.fr",
      },
      {
        headers: {
          "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
          "referrer-policy": "no-referrer",
        },
      },
    );
  },
);
