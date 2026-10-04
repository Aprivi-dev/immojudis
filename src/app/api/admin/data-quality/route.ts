import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getDataQualityReport } from "@/lib/data-quality-monitor";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
  try {
    const report = await getDataQualityReport(bearerTokenFromRequest(request));
    return NextResponse.json(report, {
      headers: {
        "cache-control": "private, max-age=30",
        "x-immojudis-data-quality-status": report.overallStatus,
      },
    });
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Qualité data indisponible",
      fallbackStatus: 500,
    });
  }
}
