import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";
import { getCadastralParcels, getSale } from "@/lib/property-report/repository";
import { enforceDailyOperationLimits, enforceUserRateLimit } from "@/lib/rate-limit";
import { landLocationInputFromSale } from "@/lib/land-report-input";
import { getCachedLandReport } from "@/lib/land-report";
import { listingPluZone } from "@/lib/land-report-coherence";
import { landReportToLines, LAND_REPORT_HEADINGS } from "@/lib/land-report-export";
import { createTextPdf } from "@/lib/simple-pdf";

export const maxDuration = 180;
const paramsSchema = z.object({ id: z.string().guid() });
const querySchema = z.object({
  format: z.enum(["json", "pdf"]).default("json"),
  refresh: z.enum(["0", "1"]).default("0"),
});

export const GET = apiRoute<{ id: string }>(
  {
    scope: "land-report.sale",
    fallbackMessage: "L’analyse du PLU et des risques est momentanément indisponible.",
    fallbackStatus: 503,
    versionedApi: true,
  },
  async (request, { api, params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = paramsSchema.parse(params);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    // Les droits sont indépendants : contrôlés ensemble, avant toute lecture de la vente.
    const [plan] = await Promise.all([
      assertFeatureEntitlement(
        auth,
        "property.urbanPlanning",
        "L’analyse du PLU et des risques est réservée à l’offre Analyse.",
      ),
      assertFeatureEntitlement(
        auth,
        "property.cadastralAnalysis",
        "L’analyse cadastrale est réservée à l’offre Analyse.",
      ),
      query.format === "pdf"
        ? assertFeatureEntitlement(
            auth,
            "property.pdfExport",
            "L’export PDF est réservé à l’offre Analyse.",
          )
        : null,
    ]);
    const sale = await getSale(auth.supabase, id);
    await enforceUserRateLimit({
      userId: auth.userId,
      context: api,
      bucketKey: "land-report",
      limit: 12,
      windowSeconds: 60,
    });
    // Après les droits d'accès : seul un compte qui y a droit use les compteurs de son adresse et le
    // disjoncteur global. Le dossier appelle les services de l'État (fonction jusqu'à 180 s).
    await enforceDailyOperationLimits({
      request,
      userId: auth.userId,
      operation: "landReport",
      launchOffer: plan.launchOffer === true,
    });
    const parcels = await getCadastralParcels(sale.source_url);
    const report = await getCachedLandReport(landLocationInputFromSale(sale, parcels), {
      refresh: query.refresh === "1",
    });
    if (query.format === "pdf") {
      const address = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
      const pdf = createTextPdf({
        title: "Immojudis - PLU et risques du bien",
        lines: landReportToLines(report, address, {
          listingZone: listingPluZone(sale.source_description, sale.description),
          landSurfaceM2: sale.land_surface_m2,
        }),
        headings: LAND_REPORT_HEADINGS,
        footer: "Immojudis - preuves officielles et vérifications, ne vaut pas autorisation.",
      });
      return new Response(new Uint8Array(pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="immojudis-plu-risques-${id}.pdf"`,
        },
      });
    }
    return { report };
  },
);
