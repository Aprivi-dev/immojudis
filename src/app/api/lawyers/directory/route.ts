import { NextResponse } from "next/server";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { lawyerDirectoryQuerySchema, listLawyerDirectory } from "@/lib/lawyer-directory";
import { assertFeatureEntitlement } from "@/lib/property-reports";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await assertFeatureEntitlement(
      auth,
      "lawyers.directory",
      "Annuaire d'avocats réservé au plan Analyse.",
    );
    const url = new URL(request.url);
    const query = lawyerDirectoryQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
      city: url.searchParams.get("city") ?? undefined,
      department: url.searchParams.get("department") ?? undefined,
    });
    return NextResponse.json(await listLawyerDirectory(query));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Annuaire indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.includes("réservé")
        ? 403
        : message.includes("introuvable")
          ? 404
          : 400;
    return NextResponse.json({ lawyers: [], sectorLabel: null, error: message }, { status });
  }
}
