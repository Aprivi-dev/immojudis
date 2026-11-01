import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { requireAdmin } from "@/lib/admin-auth.server";
import { readEmailMessage } from "@/lib/admin-emails/history";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Un message de l'historique (`log:`, `case:` ou `unrouted:` puis l'identifiant). Contenu d'un email envoyé
 * lu chez Resend à la demande ; email reçu en texte seul. Liens d'action masqués. Consultation tracée.
 */
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin(bearerTokenFromRequest(request));
    const { id } = await context.params;
    // Next décode déjà le segment : aucun second décodage.
    const message = await readEmailMessage({ adminUserId: auth.userId, id });
    if (!message) {
      return NextResponse.json(
        { error: "Message introuvable." },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    }
    return NextResponse.json(message, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
