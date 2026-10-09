import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { DETAIL_VIEW } from "@/lib/sale-views";
import { getMeteostatHistoricalWeather, type MeteostatResult } from "@/lib/meteostat";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { assertSalePublicationVisible } from "@/lib/sale-publication-guard";

const saleIdSchema = z.string().uuid();
const WEATHER_COLUMNS = "id,latitude,longitude";

type SaleWeatherResponse = {
  saleId: string;
  weather: MeteostatResult;
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
    const weather =
      latitude == null || longitude == null
        ? {
            status: "unavailable" as const,
            source: "Meteostat" as const,
            sourceUrl: "https://dev.meteostat.net/api/point/monthly.html",
            reason: "coordinates_missing" as const,
            message: "Cette annonce ne possède pas de coordonnées exploitables.",
          }
        : await getMeteostatHistoricalWeather(latitude, longitude);

    return NextResponse.json(
      { saleId: parsedId.data, weather },
      {
        // The durable cache lives in Supabase. Do not let a shared CDN serve
        // one user's authorization result to another user.
        headers: PRIVATE_WEATHER_HEADERS,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historique météo indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden") || message.includes("réserv")
        ? 403
        : 400;
    return NextResponse.json(
      { error: message },
      { status, headers: status === 401 || status === 403 ? PRIVATE_WEATHER_HEADERS : undefined },
    );
  }
}
