import { readEmailMessage } from "@/lib/admin-emails/history";
import { adminRoute } from "@/lib/admin-route-deadline";
import { NotFoundError } from "@/lib/api-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Un message de l'historique (`log:`, `case:` ou `unrouted:` puis l'identifiant). Contenu d'un email envoyé
 * lu chez Resend à la demande ; email reçu en texte seul. Liens d'action masqués. Consultation tracée.
 */
export const GET = adminRoute<{ id: string }>(
  {
    scope: "admin.emails.history.message.read",
    fallbackMessage: "Message indisponible",
    guard: "admin",
  },
  async (_request, { params, auth }) => {
    // Next décode déjà le segment : aucun second décodage.
    const message = await readEmailMessage({ adminUserId: auth.userId, id: params.id });
    if (!message) throw new NotFoundError("Message introuvable.");
    return message;
  },
);
