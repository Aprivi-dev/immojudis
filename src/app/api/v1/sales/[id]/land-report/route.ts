import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  apiError,
  apiJson,
  createApiRequestContext,
  withApiHeaders,
} from "@/lib/api-observability";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { getCadastralParcels, getSale } from "@/lib/property-report/repository";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { landLocationInputFromSale } from "@/lib/land-report-input";
import { getCachedLandReport } from "@/lib/land-report";
import { landReportToLines, LAND_REPORT_HEADINGS } from "@/lib/land-report-export";
import { createTextPdf } from "@/lib/simple-pdf";

export const maxDuration = 180;
const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  format: z.enum(["json", "pdf"]).default("json"),
  refresh: z.enum(["0", "1"]).default("0"),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = createApiRequestContext(request, "land-report.sale");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "property.urbanPlanning",
      "L’analyse du PLU et des risques est réservée au plan Analyse.",
    );
    await assertFeatureEntitlement(
      auth,
      "property.cadastralAnalysis",
      "L’analyse cadastrale est réservée au plan Analyse.",
    );
    const { id } = paramsSchema.parse(await params);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    if (query.format === "pdf")
      await assertFeatureEntitlement(
        auth,
        "property.pdfExport",
        "L’export PDF est réservé au plan Analyse.",
      );
    const sale = await getSale(auth.supabase, id);
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "land-report",
      limit: 12,
      windowSeconds: 60,
    });
    const parcels = await getCadastralParcels(sale.source_url);
    const report = await getCachedLandReport(landLocationInputFromSale(sale, parcels), {
      refresh: query.refresh === "1",
    });
    const headers = { "cache-control": "private, no-store", vary: "authorization" };
    if (query.format === "pdf") {
      const address = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
      const pdf = createTextPdf({
        title: "Immojudis - PLU et risques du bien",
        lines: landReportToLines(report, address),
        headings: LAND_REPORT_HEADINGS,
        footer: "Immojudis - preuves officielles et vérifications, ne vaut pas autorisation.",
      });
      return withApiHeaders(
        new Response(new Uint8Array(pdf), {
          headers: {
            ...headers,
            "content-type": "application/pdf",
            "content-disposition": `attachment; filename="immojudis-plu-risques-${id}.pdf"`,
          },
        }),
        context,
      );
    }
    return apiJson({ report }, context, { headers });
  } catch (error) {
    const response = apiError(error, context, {
      fallbackMessage: "L’analyse du PLU et des risques est momentanément indisponible.",
      fallbackStatus: 503,
    });
    response.headers.set("cache-control", "private, no-store");
    response.headers.set("vary", "authorization");
    return response;
  }
}
