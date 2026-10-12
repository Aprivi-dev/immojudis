import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { disableSaleComparisonShare, enableSaleComparisonShare } from "@/lib/sale-analysis-sets";

const setIdSchema = z.string().uuid();

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await context.params;
    const response = await enableSaleComparisonShare({
      auth,
      setId: setIdSchema.parse(id),
      origin: new URL(request.url).origin,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "sale-analysis-sets.id.share", {
      fallbackMessage: "Partage impossible",
      extra: { enabled: false, url: null, expiresAt: null },
    });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await context.params;
    const response = await disableSaleComparisonShare({
      auth,
      setId: setIdSchema.parse(id),
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return apiRouteError(error, request, "sale-analysis-sets.id.share", {
      fallbackMessage: "Désactivation impossible",
      extra: { enabled: false, url: null, expiresAt: null },
    });
  }
}
