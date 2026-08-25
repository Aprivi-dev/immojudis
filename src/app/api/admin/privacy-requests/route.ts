import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  listPrivacyRequestsForAdmin,
  privacyRequestAdminUpdateSchema,
  updatePrivacyRequestForAdmin,
} from "@/lib/privacy-requests";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.admin.privacy_requests.list");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return apiJson(await listPrivacyRequestsForAdmin(auth), context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Demandes indisponibles.",
      fallbackStatus: 400,
    });
  }
}

export async function PATCH(request: Request) {
  const context = createApiRequestContext(request, "api.admin.privacy_requests.update");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = privacyRequestAdminUpdateSchema.parse(await request.json());
    return apiJson(await updatePrivacyRequestForAdmin({ auth, input }), context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Mise à jour impossible.",
      fallbackStatus: 400,
    });
  }
}
