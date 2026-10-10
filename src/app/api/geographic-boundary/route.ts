import { NextResponse } from "next/server";
import { RateLimitError } from "@/lib/api-errors";
import { rateLimitResponse } from "@/lib/api-observability";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import {
  fetchGeographicBoundary,
  GeographicBoundaryUpstreamError,
} from "@/lib/geographic-boundary";

const PUBLIC_BOUNDARY_HEADERS = {
  "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
  "referrer-policy": "no-referrer",
};

/**
 * Proxy the public French administrative geography API so the map can request
 * a contour without depending on third-party CORS configuration. The proxy
 * deliberately returns no sale data and accepts only a short search label.
 */
export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "geographic-boundary",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error, { boundary: null });
    throw error;
  }
  const label = new URL(request.url).searchParams.get("label")?.trim() ?? "";
  if (!label || label.length > 120) {
    return NextResponse.json(
      { boundary: null, error: "Libellé géographique invalide." },
      { status: 400, headers: PUBLIC_BOUNDARY_HEADERS },
    );
  }

  try {
    const boundary = await fetchGeographicBoundary(label);
    return NextResponse.json(
      {
        boundary,
        requestedLabel: label,
        source: boundary?.sourceUrl ?? "geo.api.gouv.fr",
      },
      { headers: PUBLIC_BOUNDARY_HEADERS },
    );
  } catch (error) {
    if (!(error instanceof GeographicBoundaryUpstreamError)) {
      console.error("[geographic-boundary] unexpected upstream failure", error);
    }
    return NextResponse.json(
      { boundary: null, error: "Contour géographique temporairement indisponible." },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      },
    );
  }
}
