import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { RateLimitError } from "@/lib/api-errors";
import { apiRouteError, rateLimitResponse } from "@/lib/api-observability";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { StreetViewPanorama } from "@/lib/street-view";
import { findStreetViewPanorama } from "@/lib/street-view-panorama.server";

const coordinate = (min: number, max: number) =>
  z.string().trim().min(1).pipe(z.coerce.number<string>().finite().min(min).max(max));

const querySchema = z.object({
  lat: coordinate(-90, 90),
  lng: coordinate(-180, 180),
});

/**
 * Nearest Google Street View car panorama around a point, for the listing
 * Street View dialog.
 *
 * The caller already knows the point: the route only reads Google's public
 * metadata, so it reveals nothing about our catalogue. Results change only
 * when Google publishes new imagery and are cached at the edge for a week.
 */
export async function GET(
  request: Request,
): Promise<NextResponse<{ panorama: StreetViewPanorama } | { error: string }>> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    lat: url.searchParams.get("lat"),
    lng: url.searchParams.get("lng"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Coordonnées invalides." }, { status: 400 });
  }
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "street_view.panorama",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return rateLimitResponse(error) as NextResponse<{ error: string }>;
    }
    throw error;
  }

  try {
    const panorama = await findStreetViewPanorama(parsed.data.lat, parsed.data.lng);
    return NextResponse.json(
      { panorama },
      {
        headers: {
          "cache-control":
            panorama.status === "unavailable" && panorama.reason === "not_configured"
              ? "no-store"
              : "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000",
        },
      },
    );
  } catch (error) {
    return apiRouteError(error, request, "street_view.panorama", {
      fallbackMessage: "Street View indisponible",
    });
  }
}
