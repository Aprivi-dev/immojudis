import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { adminRoute } from "@/lib/admin-route-deadline";
import { getDataQualityReport } from "@/lib/data-quality-monitor";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  { scope: "admin.data-quality.read", fallbackMessage: "Qualité data indisponible" },
  async (request) => {
    const report = await getDataQualityReport(bearerTokenFromRequest(request));
    return NextResponse.json(report, {
      headers: {
        "cache-control": "private, max-age=30",
        "x-immojudis-data-quality-status": report.overallStatus,
      },
    });
  },
);
