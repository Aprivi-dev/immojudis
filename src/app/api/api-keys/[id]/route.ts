import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { revokeUserApiKey } from "@/lib/api-keys";

export const DELETE = apiRoute<{ id: string }>(
  { scope: "api.api-keys.revoke", fallbackMessage: "Révocation impossible" },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return revokeUserApiKey({ auth, keyId: params.id });
  },
);
