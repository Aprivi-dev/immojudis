import { NextResponse } from "next/server";
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

const saleIdSchema = z.string().uuid();

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const saleId = saleIdSchema.parse(url.searchParams.get("saleId"));
    const response = await getSaleWorkspace({ auth, saleId });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dossier de suivi indisponible";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ workspace: null, error: message }, { status });
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = saleWorkspaceInputSchema.parse(await request.json());
    const response = await upsertSaleWorkspace({ auth, input });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dossier de suivi impossible";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ workspace: null, error: message }, { status });
  }
}
