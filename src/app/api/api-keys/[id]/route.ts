import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { revokeUserApiKey } from "@/lib/api-keys";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { id } = await params;
    const response = await revokeUserApiKey({ auth, keyId: id });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Révocation impossible";
    const status = message.startsWith("Unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
