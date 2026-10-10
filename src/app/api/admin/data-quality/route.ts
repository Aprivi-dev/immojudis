import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getDataQualityReport } from "@/lib/data-quality-monitor";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
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

export const GET = withAdminDeadline(handleGET);
