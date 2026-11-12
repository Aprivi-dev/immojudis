import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { buildTemplatesView } from "@/lib/admin-emails/views";
import { adminRoute } from "@/lib/admin-route-deadline";
import { EMAIL_TEMPLATES, summarizeEmailTemplate } from "@/lib/email-templates/registry";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Liste des modèles avec leur niveau d'édition. Lecture seule : rien n'est modifiable aux lots 1-2. */
export const GET = adminRoute(
  { scope: "admin.emails.templates.read", fallbackMessage: "Modèles d'emails indisponibles" },
  async (request) => {
    await assertAdminAuth(bearerTokenFromRequest(request));
    return buildTemplatesView(EMAIL_TEMPLATES.map(summarizeEmailTemplate));
  },
);
