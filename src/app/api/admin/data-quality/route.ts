import { NextResponse } from "next/server";
import { adminRoute } from "@/lib/admin-route-deadline";
import { getDataQualityReport } from "@/lib/data-quality-monitor";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.data-quality.read",
    fallbackMessage: "Qualité data indisponible",
    guard: "admin",
  },
  async (_request, { authToken }) => {
    const report = await getDataQualityReport(authToken);
    return NextResponse.json(report, {
      headers: {
        "cache-control": "private, max-age=30",
        "x-immojudis-data-quality-status": report.overallStatus,
      },
    });
  },
);
