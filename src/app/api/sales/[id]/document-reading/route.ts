import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import { apiRouteError } from "@/lib/api-observability";
import { documentReadingTeaser, type DocumentReadingResponse } from "@/lib/document-reading";
import { getDocumentReading } from "@/lib/document-reading.server";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { DETAIL_VIEW } from "@/lib/sale-views";

const saleIdSchema = z.string().uuid();

/**
 * « Lecture des pièces ». Analyse: the points with their verified quotes.
 * Other signed-in accounts: how many points were found, never their content.
 * The sale must be visible to the caller first.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "document-reading",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const plan = await resolvePlanEntitlements(auth);
    const full = featureIncluded(plan.plan, "property.documentReading");
    const { data: sale, error } = await auth.supabase
      .from(full ? DETAIL_VIEW : "v_auction_sales_discovery")
      .select("id")
      .eq("id", saleId)
      .maybeSingle();
    if (error) throw error;
    if (!sale) throw new PublicApiError("Vente introuvable.", 404);

    const reading = await getDocumentReading(saleId);
    const body: DocumentReadingResponse = full ? reading : documentReadingTeaser(reading);
    return NextResponse.json(body, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "document-reading", {
      fallbackMessage: "Lecture des pièces indisponible.",
    });
  }
}
