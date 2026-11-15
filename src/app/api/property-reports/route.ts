import { NextResponse } from "next/server";
import { z } from "zod";
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

const saleIdQuerySchema = z.string().guid().nullable();

export const GET = apiRoute(
  { scope: "api.property-reports.list", fallbackMessage: "Rapports indisponibles." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    // Validated before any read: a malformed identifier is the caller's error (400), not a 500.
    const saleId = saleIdQuerySchema.parse(url.searchParams.get("saleId"));
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
