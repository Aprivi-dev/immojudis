import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { requireAdmin } from "@/lib/admin-auth.server";
import { getEmailAddressesReport } from "@/lib/admin-emails/addresses";
import { buildAddressesView } from "@/lib/admin-emails/views";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Expéditeurs, secrets (booléens), domaines, DNS et webhooks, déjà mis en forme pour l'affichage.
 * `?refresh=1` : revérifier maintenant.
 */
async function handleGET(request: Request) {
  try {
    await requireAdmin(bearerTokenFromRequest(request));
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const report = await getEmailAddressesReport({ refresh });
    return NextResponse.json(buildAddressesView(report), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
