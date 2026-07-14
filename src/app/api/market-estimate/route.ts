import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { getStoredSaleMarketContext } from "@/lib/sale-market-estimates";
import { recordFeatureUsageEvent } from "@/lib/usage";
import { z } from "zod";

const requestSchema = z.object({ saleId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.valueEstimate",
      "Estimation de marché réservée au plan Analyse.",
    );
    const { saleId } = requestSchema.parse(await request.json());
    const response = await getStoredSaleMarketContext(saleId);
    if (response.estimate) {
      await recordFeatureUsageEvent({
        auth,
        eventKey: "valuation.estimated",
        subjectType: "auction_sale",
        subjectId: saleId,
        metadata: {
          source: "precomputed",
          engine_version: response.estimate.engineVersion ?? "v3",
          engine_kind: response.estimate.engineKind ?? "comparable_ensemble",
          segment: response.estimate.segment ?? null,
          sample_size: response.estimate.sampleSize,
          quality_score: response.estimate.qualityScore,
          actionable: response.estimate.actionable === true,
        },
      });
    }
    return NextResponse.json(response, {
      headers: {
        "cache-control": response.estimate
          ? "private, max-age=300, stale-while-revalidate=3600"
          : "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unauthorized";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réserv")
        ? 403
        : 400;
    return NextResponse.json({ ok: false, error: message, estimate: null }, { status });
  }
}
