import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { adminSignupListQuerySchema, listAdminSignups } from "@/lib/admin-signups";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Liste et recherche des inscrits. En POST : la recherche (adresse ou nom) voyage dans le corps JSON,
 * jamais dans l'URL, que les journaux de requêtes de l'hébergeur conservent.
 */
async function handlePOST(request: Request) {
  try {
    // Le jeton d'abord : sans session, la réponse est 401, que le corps soit valide ou non.
    const authToken = bearerTokenFromRequest(request);
    const query = adminSignupListQuerySchema.parse(await request.json());
    const response = await listAdminSignups(authToken, query);
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Erreur admin inscriptions" });
  }
}

export const POST = withAdminDeadline(handlePOST);
