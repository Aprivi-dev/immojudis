import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { requireAdmin } from "@/lib/admin-auth.server";
import { getEmailDesigns } from "@/lib/admin-emails/designs";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Galerie des aperçus (`?theme=dark` : règles du mode sombre appliquées). Lecture seule. */
async function handleGET(request: Request) {
  try {
    await requireAdmin(bearerTokenFromRequest(request));
    const dark = new URL(request.url).searchParams.get("theme") === "dark";
    return NextResponse.json(await getEmailDesigns({ dark }), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
