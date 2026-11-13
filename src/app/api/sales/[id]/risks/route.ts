import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { getCommuneRiskProfile, resolveSaleCommune } from "@/lib/commune-risks.server";
import type { CommuneRiskResult } from "@/lib/environment-reference";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { loadVisibleSaleLocation } from "@/lib/sale-location.server";

const saleIdSchema = z.string().guid();

type SaleRisksResponse = { saleId: string; risks: CommuneRiskResult };

/**
 * Public commune-level risk summary of a listing (GASPAR, Géorisques).
 *
 * Only commune facts leave the server: the listing coordinates are read with
 * the service role to find the commune and are never returned.
 */
export const GET = apiRoute<{ id: string }>(
  { scope: "sales.id.risks", fallbackMessage: "Risques de la commune indisponibles" },
  async (request, { params }) => {
    const parsedId = saleIdSchema.safeParse(params.id);
    if (!parsedId.success) throw new PublicApiError("Identifiant de vente invalide.", 400);
    await enforceIpRateLimit({
      request,
      bucketKey: "sales.risks",
      ...RATE_LIMIT_POLICIES.publicIp,
    });

    // Same rule as the listing page: only missing or quarantined sales are refused.
    const sale = await loadVisibleSaleLocation(parsedId.data);
    if (!sale) throw new NotFoundError("Vente introuvable.");

    const commune = await resolveSaleCommune({
      latitude: sale.latitude,
      longitude: sale.longitude,
      city: sale.city,
      postalCode: sale.postalCode,
      department: sale.department,
    });
    const risks: CommuneRiskResult = commune
      ? await getCommuneRiskProfile(commune)
      : {
          status: "unavailable",
          reason: sale.city || sale.latitude != null ? "commune_not_found" : "location_missing",
        };
    const cacheable = risks.status === "ready";
    const body: SaleRisksResponse = { saleId: parsedId.data, risks };
    return NextResponse.json(body, {
      headers: {
        "cache-control": cacheable
          ? "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"
          : "public, max-age=300, s-maxage=300",
      },
    });
  },
);
