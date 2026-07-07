import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { getDataQualityReport } from "@/lib/data-quality-monitor";

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
    const message = error instanceof Error ? error.message : "Qualité data indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
