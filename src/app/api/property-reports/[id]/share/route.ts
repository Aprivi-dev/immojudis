import { NextResponse } from "next/server";
import { z } from "zod";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { disablePropertyReportShare, enablePropertyReportShare } from "@/lib/property-reports";

const shareBodySchema = z.object({ expiresAt: z.string().nullable().optional() });

type RouteParams = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    // Corps facultatif : absent ou vide, la durée par défaut s'applique. Un JSON mal formé ou `null`
    // est une erreur de l'appelant (400), pas une panne.
    const rawBody = await request.text();
    const payload = shareBodySchema.parse(rawBody.trim() ? JSON.parse(rawBody) : {});
    const response = await enablePropertyReportShare({
      auth,
      reportId: id,
      origin: url.origin,
      expiresAt: payload.expiresAt,
    });

    return NextResponse.json(response);
  } catch (error) {
    return apiRouteError(error, request, "property-reports.id.share", {
      fallbackMessage: "Partage impossible",
    });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const response = await disablePropertyReportShare({ auth, reportId: id, origin: url.origin });
    return NextResponse.json(response);
  } catch (error) {
    return apiRouteError(error, request, "property-reports.id.share", {
      fallbackMessage: "Désactivation du partage impossible",
    });
  }
}
