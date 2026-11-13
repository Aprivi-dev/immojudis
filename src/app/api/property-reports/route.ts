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
import { apiRoute } from "@/lib/api-route";

export const GET = apiRoute(
  { scope: "api.property-reports.list", fallbackMessage: "Rapports indisponibles." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const saleId = url.searchParams.get("saleId");
    return listPropertyReports({ auth, saleId });
  },
);

export const POST = apiRoute(
  { scope: "api.property-reports.create", fallbackMessage: "Rapport impossible." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = propertyReportRequestSchema.parse(await request.json());
    const response = await savePropertyReport({ auth, input, request });
    return NextResponse.json(response, { status: 201 });
  },
);
