import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { adminRoute } from "@/lib/admin-route-deadline";
import {
  executePrivacyErasure,
  listPrivacyRequestsForAdmin,
  privacyErasureExecuteSchema,
  privacyRequestAdminUpdateSchema,
  updatePrivacyRequestForAdmin,
} from "@/lib/privacy-requests";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  { scope: "api.admin.privacy_requests.list", fallbackMessage: "Demandes indisponibles." },
  async (request) => {
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
    return listPrivacyRequestsForAdmin(auth, { offset, limit });
  },
);

export const PATCH = adminRoute(
  { scope: "api.admin.privacy_requests.update", fallbackMessage: "Mise à jour impossible." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = privacyRequestAdminUpdateSchema.parse(await request.json());
    return updatePrivacyRequestForAdmin({ auth, input });
  },
);

/** Executes a verified erasure request (Stripe customer, application data, files, auth user). */
export const POST = adminRoute(
  { scope: "api.admin.privacy_requests.erase", fallbackMessage: "Effacement impossible." },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = privacyErasureExecuteSchema.parse(await request.json());
    return executePrivacyErasure({ auth, input });
  },
);
