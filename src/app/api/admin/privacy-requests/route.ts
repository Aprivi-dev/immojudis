import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiError, apiJson, createApiRequestContext } from "@/lib/api-observability";
import {
  executePrivacyErasure,
  listPrivacyRequestsForAdmin,
  privacyErasureExecuteSchema,
  privacyRequestAdminUpdateSchema,
  updatePrivacyRequestForAdmin,
} from "@/lib/privacy-requests";

export async function GET(request: Request) {
  const context = createApiRequestContext(request, "api.admin.privacy_requests.list");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error("Pagination des demandes de conformité invalide.");
    }
    return apiJson(await listPrivacyRequestsForAdmin(auth, { offset, limit }), context);
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

/** Executes a verified erasure request (Stripe customer, application data, files, auth user). */
export async function POST(request: Request) {
  const context = createApiRequestContext(request, "api.admin.privacy_requests.erase");
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = privacyErasureExecuteSchema.parse(await request.json());
    return apiJson(await executePrivacyErasure({ auth, input }), context);
  } catch (error) {
    return apiError(error, context, {
      fallbackMessage: "Effacement impossible.",
      fallbackStatus: 400,
    });
  }
}
