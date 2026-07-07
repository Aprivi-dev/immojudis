import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  deleteSaleAnalysisSet,
  saleAnalysisSetUpdateSchema,
  updateSaleAnalysisSet,
} from "@/lib/sale-analysis-sets";

const setIdSchema = z.string().uuid();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await context.params;
    const setId = setIdSchema.parse(id);
    const input = saleAnalysisSetUpdateSchema.parse(await request.json());
    const response = await updateSaleAnalysisSet({ auth, setId, input });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mise à jour d'analyse impossible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservée")
        ? 403
        : 400;
    return NextResponse.json({ set: null, error: message }, { status });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await context.params;
    const setId = setIdSchema.parse(id);
    const response = await deleteSaleAnalysisSet({ auth, setId });

    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Suppression d'analyse impossible";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
