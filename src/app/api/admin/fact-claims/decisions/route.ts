import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import {
  adminFactClaimDecisionQuerySchema,
  adminFactClaimDecisionSchema,
  decideAdminFactClaim,
  listAdminFactClaimDecisions,
} from "@/lib/admin-fact-claim-decisions";
import { adminRoute } from "@/lib/admin-route-deadline";
import { translateFactClaimDatabaseError } from "@/lib/fact-claim-database-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const NO_REFERRER = { "referrer-policy": "no-referrer" };

/**
 * Registre des pièces, écran de décision. Comme les autres routes d'administration, l'appelant
 * s'identifie par un jeton porteur dans l'en-tête `Authorization`, jamais par un cookie : une
 * page d'un autre site ne peut pas faire partir une décision à la place de l'administrateur.
 * Le jeton et le rôle sont vérifiés avant toute lecture du corps et avant tout appel à la base.
 */
export const GET = adminRoute(
  {
    scope: "admin.fact-claims.decisions",
    fallbackMessage: "Liste des observations indisponible.",
  },
  async (request) => {
    try {
      await assertAdminAuth(bearerTokenFromRequest(request));
      const input = adminFactClaimDecisionQuerySchema.parse(
        Object.fromEntries(new URL(request.url).searchParams.entries()),
      );
      const response = await listAdminFactClaimDecisions(input);
      return NextResponse.json(response, { headers: NO_REFERRER });
    } catch (error) {
      throw translateFactClaimDatabaseError(error);
    }
  },
);

export const POST = adminRoute(
  {
    scope: "admin.fact-claims.decisions",
    fallbackMessage: "La décision n'a pas pu être enregistrée.",
  },
  async (request) => {
    try {
      const auth = await assertAdminAuth(bearerTokenFromRequest(request));
      const input = adminFactClaimDecisionSchema.parse(await request.json());
      const response = await decideAdminFactClaim({ auth, input });
      return NextResponse.json(response, { headers: NO_REFERRER });
    } catch (error) {
      throw translateFactClaimDatabaseError(error);
    }
  },
);
