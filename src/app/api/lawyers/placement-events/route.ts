import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  lawyerPlacementEventInputSchema,
  recordLawyerPlacementEvent,
} from "@/lib/lawyer-placement-events";
import { assertFeatureEntitlement } from "@/lib/property-reports";

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "lawyers.directory",
      "Avocats référencés réservés au plan Analyse.",
    );
    const input = lawyerPlacementEventInputSchema.parse(await request.json());
    return NextResponse.json(await recordLawyerPlacementEvent({ input }));
  } catch (error) {
    return apiRouteError(error, request, "lawyers.placement-events", {
      fallbackMessage: "Événement de placement avocat impossible",
      extra: { recorded: false },
    });
  }
}
