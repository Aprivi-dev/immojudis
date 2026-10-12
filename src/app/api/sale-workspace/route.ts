import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  getSaleWorkspace,
  saleWorkspaceInputSchema,
  upsertSaleWorkspace,
} from "@/lib/sale-workspaces";
import { assertFeatureEntitlement } from "@/lib/property-reports";

const saleIdSchema = z.string().uuid();

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "workspace.audienceTracking",
      "Espace de suivi réservé au plan Analyse.",
    );
    const url = new URL(request.url);
    const saleId = saleIdSchema.parse(url.searchParams.get("saleId"));
    const response = await getSaleWorkspace({ auth, saleId });
    return NextResponse.json(response);
  } catch (error) {
    return apiRouteError(error, request, "sale-workspace", {
      fallbackMessage: "Dossier de suivi indisponible",
      extra: { workspace: null },
    });
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "workspace.audienceTracking",
      "Espace de suivi réservé au plan Analyse.",
    );
    const input = saleWorkspaceInputSchema.parse(await request.json());
    const response = await upsertSaleWorkspace({ auth, input });
    return NextResponse.json(response);
  } catch (error) {
    return apiRouteError(error, request, "sale-workspace", {
      fallbackMessage: "Dossier de suivi impossible",
      extra: { workspace: null },
    });
  }
}
