import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminInformationAgentMessageActionSchema,
  adminInformationAgentReviewQuerySchema,
  adminInformationAgentReviewSchema,
  listAdminInformationAgentReview,
  reviewAdminInformationAgentFact,
  runAdminInformationAgentMessageAction,
} from "@/lib/admin-information-agent";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.information-agent.read",
    fallbackMessage: "Relecture de l'agent d'information indisponible",
  },
  async (request) => {
    // `offset` / `limit` (50 par défaut, 100 au plus) bornent les deux listes ; le total est renvoyé.
    const input = adminInformationAgentReviewQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return listAdminInformationAgentReview(bearerTokenFromRequest(request), input);
  },
);

export const PATCH = adminRoute(
  {
    scope: "admin.information-agent.review",
    fallbackMessage: "Relecture non enregistrée",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminInformationAgentReviewSchema.parse(await request.json());
    return reviewAdminInformationAgentFact({ authToken, input });
  },
);

/** Action sur une réponse reçue : opposition du professionnel ou réponse traitée. */
export const POST = adminRoute(
  {
    scope: "admin.information-agent.message-action",
    fallbackMessage: "Action sur la réponse impossible",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminInformationAgentMessageActionSchema.parse(await request.json());
    return runAdminInformationAgentMessageAction({ authToken, input });
  },
);
