import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { RateLimitError } from "@/lib/api-errors";
import { apiRouteError, rateLimitResponse } from "@/lib/api-observability";
import { getClimateHistory } from "@/lib/climate-history.server";
import { resolveSaleCommune, validCoordinates } from "@/lib/commune-risks.server";
import type { ClimateResult } from "@/lib/environment-reference";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { loadVisibleSaleLocation } from "@/lib/sale-location.server";

const saleIdSchema = z.string().uuid();

type SaleWeatherResponse = {
  saleId: string;
  weather: ClimateResult;
};

/**
 * Public Météo-France climate history around a listing.
 *
 * The data comes from local tables imported from official open data, so the
 * route costs no third-party call. Only station-level figures leave the server:
 * the listing coordinates are read with the service role and never returned.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<SaleWeatherResponse | { error: string }>> {
  const parsedId = saleIdSchema.safeParse((await context.params).id);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Identifiant de vente invalide." }, { status: 400 });
  }
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "sales.weather",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return rateLimitResponse(error) as NextResponse<{ error: string }>;
    }
    throw error;
  }

  try {
    // Same rule as the listing page: only missing or quarantined sales are refused.
    const sale = await loadVisibleSaleLocation(parsedId.data);
    if (!sale) return NextResponse.json({ error: "Vente introuvable." }, { status: 404 });

    let weather: ClimateResult;
    if (validCoordinates(sale.latitude, sale.longitude)) {
      weather = await getClimateHistory(sale.latitude, sale.longitude, {
        locationSource: "listing",
      });
    } else {
      // Without coordinates, the centre of the listing's commune is close enough
      // to pick the nearest Météo-France station.
      const commune = await resolveSaleCommune({
        latitude: null,
        longitude: null,
        city: sale.city,
        postalCode: sale.postalCode,
        department: sale.department,
      });
      weather = commune
        ? await getClimateHistory(commune.latitude, commune.longitude, {
            locationSource: "commune",
          })
        : { status: "unavailable", reason: "location_missing" };
    }

    return NextResponse.json(
      { saleId: parsedId.data, weather },
      {
        headers: {
          "cache-control":
            weather.status === "ready"
              ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
              : "public, max-age=300, s-maxage=300",
        },
      },
    );
  } catch (error) {
    return apiRouteError(error, request, "sales.id.weather", {
      fallbackMessage: "Historique météo indisponible",
    });
  }
}
