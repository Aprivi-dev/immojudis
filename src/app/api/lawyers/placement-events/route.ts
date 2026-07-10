import { NextResponse } from "next/server";
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
    const message =
      error instanceof Error ? error.message : "Événement de placement avocat impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réserv")
        ? 403
        : message.includes("introuvable")
          ? 404
          : 400;
    return NextResponse.json({ ok: false, recorded: false, error: message }, { status });
  }
}
