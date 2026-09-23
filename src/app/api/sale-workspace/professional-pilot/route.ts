import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { assertFeatureEntitlement } from "@/lib/property-reports";
import {
  professionalPilotSaveSchema,
  SaleWorkspaceConflictError,
  saveProfessionalPilot,
} from "@/lib/sale-workspaces";

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
    const message = error instanceof Error ? error.message : "Enregistrement impossible";
    const status =
      error instanceof SaleWorkspaceConflictError
        ? 409
        : message.startsWith("Unauthorized")
          ? 401
          : message.includes("réservé")
            ? 403
            : 400;
    return NextResponse.json({ workspace: null, error: message }, { status });
  }
}
