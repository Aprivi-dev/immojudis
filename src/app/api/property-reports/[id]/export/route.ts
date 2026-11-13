import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { exportPropertyReportPdf } from "@/lib/property-reports";

export const POST = apiRoute<{ id: string }>(
  { scope: "api.property-reports.export", fallbackMessage: "Export impossible" },
  async (request, { api, params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "property-reports.export",
      ...RATE_LIMIT_POLICIES.compute,
      context: api,
    });
    const pdf = await exportPropertyReportPdf({ auth, reportId: params.id, request });
    const body = pdf.bytes.buffer.slice(
      pdf.bytes.byteOffset,
      pdf.bytes.byteOffset + pdf.bytes.byteLength,
    ) as ArrayBuffer;

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": pdf.contentType,
        "content-disposition": `attachment; filename="${pdf.filename}"`,
      },
    });
  },
);
