import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  adminFactClaimDecisionQuerySchema,
  adminFactClaimDecisionSchema,
  decideAdminFactClaim,
  listAdminFactClaimDecisions,
  requireAdminContext,
} from "@/lib/admin-fact-claim-decisions";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { translateFactClaimDatabaseError } from "@/lib/fact-claim-database-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};

/**
 * Registre des pièces, écran de décision. Comme les autres routes d'administration, l'appelant
 * s'identifie par un jeton porteur dans l'en-tête `Authorization`, jamais par un cookie : une
 * page d'un autre site ne peut pas faire partir une décision à la place de l'administrateur.
 * Le jeton et le rôle sont vérifiés avant toute lecture du corps et avant tout appel à la base.
 */
async function handleGET(request: Request): Promise<Response> {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    requireAdminContext(auth);
    const input = adminFactClaimDecisionQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const response = await listAdminFactClaimDecisions({ auth, input });
    return NextResponse.json(response, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return decisionErrorResponse(error, request, "Liste des observations indisponible.");
  }
}

async function handlePOST(request: Request): Promise<Response> {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    requireAdminContext(auth);
    const input = adminFactClaimDecisionSchema.parse(await request.json());
    const response = await decideAdminFactClaim({ auth, input });
    return NextResponse.json(response, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return decisionErrorResponse(error, request, "La décision n'a pas pu être enregistrée.");
  }
}

function decisionErrorResponse(error: unknown, request: Request, fallbackMessage: string) {
  return apiRouteError(
    translateFactClaimDatabaseError(error),
    request,
    "admin.fact-claims.decisions",
    { fallbackMessage },
  );
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
