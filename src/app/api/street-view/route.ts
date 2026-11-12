import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { PublicApiError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
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
export const GET = apiRoute(
  { scope: "street_view.panorama", fallbackMessage: "Street View indisponible" },
  async (request) => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      lat: url.searchParams.get("lat"),
      lng: url.searchParams.get("lng"),
    });
    if (!parsed.success) throw new PublicApiError("Coordonnées invalides.", 400);
    await enforceIpRateLimit({
      request,
      bucketKey: "street_view.panorama",
      ...RATE_LIMIT_POLICIES.publicIp,
    });

    const panorama = await findStreetViewPanorama(parsed.data.lat, parsed.data.lng);
    // Sans clé Google configurée, la réponse n'est gardée par aucun cache.
    if (panorama.status === "unavailable" && panorama.reason === "not_configured") {
      return { panorama };
    }
    return NextResponse.json(
      { panorama },
      {
        headers: {
          "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000",
        },
      },
    );
  },
);
