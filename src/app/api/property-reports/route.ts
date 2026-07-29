import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  listPropertyReports,
  propertyReportRequestSchema,
  savePropertyReport,
} from "@/lib/property-reports";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.property-reports.list");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const saleId = url.searchParams.get("saleId");
    const response = await listPropertyReports({ auth, saleId });
    return apiJson(response, context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Rapports indisponibles.",
      fallbackStatus: 400,
    });
  }
}

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.property-reports.create");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = propertyReportRequestSchema.parse(await request.json());
    const response = await savePropertyReport({ auth, input });
    return apiJson(response, context, { status: 201 });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Rapport impossible.",
      fallbackStatus: 400,
    });
  }
}
