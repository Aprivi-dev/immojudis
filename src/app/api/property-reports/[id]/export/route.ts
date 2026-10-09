import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { exportPropertyReportPdf } from "@/lib/property-reports";

type RouteParams = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const pdf = await exportPropertyReportPdf({ auth, reportId: id });
    const body = pdf.bytes.buffer.slice(
      pdf.bytes.byteOffset,
      pdf.bytes.byteOffset + pdf.bytes.byteLength,
    ) as ArrayBuffer;

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": pdf.contentType,
        "content-disposition": `attachment; filename="${pdf.filename}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "property-reports.id.export", {
      fallbackMessage: "Export impossible",
    });
  }
}
