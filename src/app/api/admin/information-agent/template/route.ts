import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentEmailTemplateActionSchema,
  getAdminInformationAgentEmailTemplateWorkspace,
  runAdminInformationAgentEmailTemplateAction,
} from "@/lib/admin-information-agent-email-template";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.information-agent.template.read",
    fallbackMessage: "Modèle d'email indisponible",
  },
  async (request) =>
    getAdminInformationAgentEmailTemplateWorkspace(bearerTokenFromRequest(request)),
);

export const POST = adminRoute(
  {
    scope: "admin.information-agent.template.write",
    fallbackMessage: "Modèle d'email non modifié",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const input = adminInformationAgentEmailTemplateActionSchema.parse(await request.json());
    return runAdminInformationAgentEmailTemplateAction({ authToken, input });
  },
);
