import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  createPrivacyRequest,
  listPrivacyRequests,
  privacyRequestInputSchema,
} from "@/lib/privacy-requests";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.privacy.requests.list");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return apiJson(await listPrivacyRequests(auth), context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Demandes indisponibles.",
      fallbackStatus: 400,
    });
  }
}

export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.privacy.requests.create");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = privacyRequestInputSchema.parse(await request.json());
    const response = await createPrivacyRequest({ auth, input });
    return apiJson(response, context, { status: 201 });
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Demande impossible.",
      fallbackStatus: 400,
    });
  }
}
