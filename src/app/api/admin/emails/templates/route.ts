import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { requireAdmin } from "@/lib/admin-auth.server";
import { buildTemplatesView } from "@/lib/admin-emails/views";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { EMAIL_TEMPLATES, summarizeEmailTemplate } from "@/lib/email-templates/registry";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Liste des modèles avec leur niveau d'édition. Lecture seule : rien n'est modifiable aux lots 1-2. */
async function handleGET(request: Request) {
  try {
    await requireAdmin(bearerTokenFromRequest(request));
    return NextResponse.json(buildTemplatesView(EMAIL_TEMPLATES.map(summarizeEmailTemplate)), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
