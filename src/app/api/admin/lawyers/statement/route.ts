import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { getAdminLawyerStatement } from "@/lib/admin-lawyer-statement";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { lawyerStatementMonthSchema } from "@/lib/lawyer-statement";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Relevé mensuel des avocats référencés (point 72) : `?month=AAAA-MM`, administrateur seulement,
 * jamais mis en cache. Des nombres par avocat, aucune donnée d'acquéreur.
 */
async function handleGET(request: Request) {
  try {
    const month = lawyerStatementMonthSchema.parse(new URL(request.url).searchParams.get("month"));
    const statement = await getAdminLawyerStatement(bearerTokenFromRequest(request), month);
    return NextResponse.json(statement, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Relevé indisponible" });
  }
}

export const GET = withAdminDeadline(handleGET);
