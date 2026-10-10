import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import { professionalPilotSaveSchema, saveProfessionalPilot } from "@/lib/sale-workspaces";

export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "workspace.audienceTracking",
      "Espace de suivi réservé au plan Analyse.",
    );
    const input = professionalPilotSaveSchema.parse(await request.json());
    return NextResponse.json(await saveProfessionalPilot({ auth, input }));
  } catch (error) {
    return apiRouteError(error, request, "sale-workspace.professional-pilot", {
      fallbackMessage: "Enregistrement impossible",
      extra: { workspace: null },
    });
  }
}
