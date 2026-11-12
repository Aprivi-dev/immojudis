import { z } from "zod";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { disablePropertyReportShare, enablePropertyReportShare } from "@/lib/property-reports";

const shareBodySchema = z.object({ expiresAt: z.string().nullable().optional() });

export const POST = apiRoute<{ id: string }>(
  { scope: "api.property-reports.share.enable", fallbackMessage: "Partage impossible" },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    // Corps facultatif : absent ou vide, la durée par défaut s'applique. Un JSON mal formé ou `null`
    // est une erreur de l'appelant (400), pas une panne.
    const rawBody = await request.text();
    const payload = shareBodySchema.parse(rawBody.trim() ? JSON.parse(rawBody) : {});
    return enablePropertyReportShare({
      auth,
      reportId: params.id,
      origin: url.origin,
      expiresAt: payload.expiresAt,
    });
  },
);

export const DELETE = apiRoute<{ id: string }>(
  {
    scope: "api.property-reports.share.disable",
    fallbackMessage: "Désactivation du partage impossible",
  },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    return disablePropertyReportShare({ auth, reportId: params.id, origin: url.origin });
  },
);
