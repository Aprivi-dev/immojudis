import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { requireAdmin } from "@/lib/admin-auth.server";
import { listEmailHistory } from "@/lib/admin-emails/history";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Liste de l'historique : `?box=sent|received`, `&cursor=` (page suivante), `&address=` (exacte ou préfixe),
 * `&refresh=1` (relit chez Resend l'état de 20 envois récents au plus). Chaque appel est tracé sans adresse.
 */
async function handleGET(request: Request) {
  try {
    const auth = await requireAdmin(bearerTokenFromRequest(request));
    const params = new URL(request.url).searchParams;
    const list = await listEmailHistory({
      adminUserId: auth.userId,
      box: params.get("box") === "received" ? "received" : "sent",
      cursor: params.get("cursor"),
      address: params.get("address"),
      refresh: params.get("refresh") === "1",
    });
    return NextResponse.json(list, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
