import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  lawyerPlacementEventInputSchema,
  recordLawyerPlacementEvent,
} from "@/lib/lawyer-placement-events";
import { assertFeatureEntitlement } from "@/lib/entitlements.server";

export const POST = apiRoute(
  {
    scope: "api.lawyers.placement-events",
    fallbackMessage: "Événement de placement avocat impossible",
    emptyBody: { recorded: false },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "lawyers.directory",
      "Annuaire des avocats indisponible pour ce compte.",
    );
    const input = lawyerPlacementEventInputSchema.parse(await request.json());
    return recordLawyerPlacementEvent({ input, userId: auth.userId });
  },
);
