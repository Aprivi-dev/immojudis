import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  listPropertyReports,
  propertyReportRequestSchema,
  savePropertyReport,
} from "@/lib/property-reports";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const saleId = url.searchParams.get("saleId");
    const response = await listPropertyReports({ auth, saleId });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rapports indisponibles";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = propertyReportRequestSchema.parse(await request.json());
    const response = await savePropertyReport({ auth, input });
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rapport impossible";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
