import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RateLimitError } from "@/lib/api-errors";
import { apiRouteError, rateLimitResponse } from "@/lib/api-observability";
import { getCommuneRiskProfile, resolveSaleCommune } from "@/lib/commune-risks.server";
import type { CommuneRiskResult } from "@/lib/environment-reference";
import { lookupPublicSale } from "@/lib/public-sale.server";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

const saleIdSchema = z.string().uuid();

type SaleRisksResponse = { saleId: string; risks: CommuneRiskResult };

/**
 * Public commune-level risk summary of a listing (GASPAR, Géorisques).
 *
 * Only commune facts leave the server: the listing coordinates are read with
 * the service role to find the commune and are never returned.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<SaleRisksResponse | { error: string }>> {
  const parsedId = saleIdSchema.safeParse((await context.params).id);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Identifiant de vente invalide." }, { status: 400 });
  }
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "sales.risks",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return rateLimitResponse(error) as NextResponse<{ error: string }>;
    }
    throw error;
  }

  try {
    // Same gate as the public listing page: quarantined or retired sales are 404.
    const lookup = await lookupPublicSale(parsedId.data);
    if (lookup.status !== "found") {
      return NextResponse.json({ error: "Vente introuvable." }, { status: 404 });
    }
    const { data: sale, error } = await supabaseAdmin
      .from("auction_sales")
      .select("latitude,longitude,city,postal_code,department")
      .eq("id", parsedId.data)
      .maybeSingle();
    if (error) throw error;
    if (!sale) return NextResponse.json({ error: "Vente introuvable." }, { status: 404 });

    const commune = await resolveSaleCommune({
      latitude: sale.latitude,
      longitude: sale.longitude,
      city: sale.city,
      postalCode: sale.postal_code,
      department: sale.department,
    });
    const risks: CommuneRiskResult = commune
      ? await getCommuneRiskProfile(commune)
      : {
          status: "unavailable",
          reason: sale.city || sale.latitude != null ? "commune_not_found" : "location_missing",
        };
    const cacheable = risks.status === "ready";
    return NextResponse.json(
      { saleId: parsedId.data, risks },
      {
        headers: {
          "cache-control": cacheable
            ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
            : "public, max-age=300, s-maxage=300",
        },
      },
    );
  } catch (error) {
    return apiRouteError(error, request, "sales.id.risks", {
      fallbackMessage: "Risques de la commune indisponibles",
    });
  }
}
