import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { DETAIL_VIEW } from "@/lib/sale-views";
import { getClimateHistory } from "@/lib/climate-history.server";
import { resolveSaleCommune, validCoordinates } from "@/lib/commune-risks.server";
import type { ClimateResult } from "@/lib/environment-reference";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { assertSalePublicationVisible } from "@/lib/sale-publication-guard";

const saleIdSchema = z.string().uuid();
const WEATHER_COLUMNS = "id,latitude,longitude,city,postal_code,department";

type SaleWeatherResponse = {
  saleId: string;
  weather: ClimateResult;
};

const PRIVATE_WEATHER_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  vary: "authorization",
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<SaleWeatherResponse | { error: string }>> {
  const parsedId = saleIdSchema.safeParse((await context.params).id);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Identifiant de vente invalide." }, { status: 400 });
  }

  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.weatherHistory",
      "Historique météo réservé au plan Analyse.",
    );
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sales.weather",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const { data: sale, error: saleError } = await auth.supabase
      .from(DETAIL_VIEW)
      .select(WEATHER_COLUMNS)
      .eq("id", parsedId.data)
      .maybeSingle();

    if (saleError) throw saleError;
    if (!sale) {
      return NextResponse.json({ error: "Vente introuvable." }, { status: 404 });
    }

    // The authenticated view check above protects the lookup. This explicit
    // guard keeps the endpoint safe if a service-role-backed view changes its
    // publication policy later.
    await assertSalePublicationVisible(parsedId.data);

    const latitude = typeof sale.latitude === "number" ? sale.latitude : null;
    const longitude = typeof sale.longitude === "number" ? sale.longitude : null;
    let weather: ClimateResult;
    if (validCoordinates(latitude, longitude)) {
      weather = await getClimateHistory(latitude, longitude, { locationSource: "listing" });
    } else {
      // Without coordinates, the centre of the listing's commune is close enough
      // to pick the nearest Météo-France station.
      const commune = await resolveSaleCommune({
        latitude: null,
        longitude: null,
        city: typeof sale.city === "string" ? sale.city : null,
        postalCode: typeof sale.postal_code === "string" ? sale.postal_code : null,
        department: typeof sale.department === "string" ? sale.department : null,
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
        // Do not let a shared CDN serve one user's authorization result to another user.
        headers: PRIVATE_WEATHER_HEADERS,
      },
    );
  } catch (error) {
    return apiRouteError(error, request, "sales.id.weather", {
      fallbackMessage: "Historique météo indisponible",
    });
  }
}
