import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  deletePropertyReport,
  getPropertyReport,
  propertyReportUpdateSchema,
  updatePropertyReport,
} from "@/lib/property-reports";

export const GET = apiRoute<{ id: string }>(
  { scope: "api.property-reports.read", fallbackMessage: "Rapport indisponible" },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return getPropertyReport({ auth, reportId: params.id });
  },
);

export const PATCH = apiRoute<{ id: string }>(
  { scope: "api.property-reports.update", fallbackMessage: "Rapport impossible à modifier" },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = propertyReportUpdateSchema.parse(await request.json());
    return updatePropertyReport({ auth, reportId: params.id, input });
  },
);

export const DELETE = apiRoute<{ id: string }>(
  { scope: "api.property-reports.delete", fallbackMessage: "Rapport impossible à supprimer" },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return deletePropertyReport({ auth, reportId: params.id });
  },
);
