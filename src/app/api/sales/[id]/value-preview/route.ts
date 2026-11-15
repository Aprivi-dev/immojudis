import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
  type SupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { readSaleThroughDoor, saleFeatureDoor } from "@/lib/entitlements.server";
import { isPublicMarketGapBand, type PublicMarketGapBand } from "@/lib/market-gap-band";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { getPrecomputedMarketEstimate } from "@/lib/sale-market-estimates";
import {
  buildValuePreview,
  valuePreviewComparables,
  type ValuePreviewResponse,
} from "@/lib/value-preview";

const saleIdSchema = z.string().guid();

/**
 * Valuation preview of a sale for a signed-in account. With the detailed estimate for this sale (the
 * offer, or the unlock of this sale): the estimated range and the gap with the starting price. Any
 * other account: no value nor gap figure, only the qualitative band of the public page and the size
 * of the comparable sample. Only stored estimates are read: a preview never triggers a computation.
 */
export const GET = apiRoute<{ id: string }>(
  { scope: "value-preview", fallbackMessage: "Aperçu de la valeur indisponible." },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "value-preview",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const door = await saleFeatureDoor(auth, "property.valueEstimate", saleId);
    const sale = await readSaleThroughDoor<{
      starting_price_eur: number | null;
      occupancy_status: string | null;
    }>(auth, saleId, door, "id, starting_price_eur, occupancy_status");
    const estimate = await getPrecomputedMarketEstimate(saleId);
    if (door) {
      const body: ValuePreviewResponse = {
        access: "full",
        ...buildValuePreview(estimate, sale.starting_price_eur, sale.occupancy_status),
      };
      // Through an unlock, not kept by the browser either: the right can end (unlock returned, sale
      // withdrawn) and a kept copy would still show the figures.
      return NextResponse.json(body, {
        headers: {
          "cache-control":
            door === "plan"
              ? "private, max-age=300, stale-while-revalidate=3600"
              : "private, no-store",
        },
      });
    }
    const body: ValuePreviewResponse = {
      access: "teaser",
      band: await publicMarketGapBand(auth, saleId),
      comparables: valuePreviewComparables(estimate),
    };
    // Not kept by the browser: once the account unlocks the sale, the next read must be the full one.
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  },
);

/**
 * The band of the public page (`get_public_sale_market_gap_band`), or `null`: nothing reliable to
 * say, an answer outside the contract, or an error (logged; a missing band never becomes a figure).
 */
async function publicMarketGapBand(
  auth: SupabaseAuthContext,
  saleId: string,
): Promise<PublicMarketGapBand | null> {
  const { data, error } = await auth.supabase.rpc("get_public_sale_market_gap_band", {
    p_sale_id: saleId,
  });
  if (error) {
    console.warn(
      JSON.stringify({
        scope: "value-preview",
        level: "warn",
        event: "market_gap_band_failed",
        saleId,
        code: error.code ?? null,
      }),
    );
    return null;
  }
  return isPublicMarketGapBand(data) ? data : null;
}
