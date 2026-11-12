import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { resolvePlanEntitlements } from "@/lib/entitlements.server";
import { getPlanUsageSummary } from "@/lib/usage";

export const GET = apiRoute(
  { scope: "api.feature-entitlements", fallbackMessage: "Accès indisponible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const plan = await resolvePlanEntitlements(auth);
    if (new URL(request.url).searchParams.get("scope") === "plan") return { plan };
    const usage = await getPlanUsageSummary({ auth, plan });
    return { plan, usage };
  },
);
