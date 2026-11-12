import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminPublicationQuerySchema,
  adminPublicationReviewInputSchema,
  listAdminPublicationRequests,
  reviewAdminPublicationRequest,
} from "@/lib/admin-publication-requests";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.publications.read",
    fallbackMessage: "Demandes de publication indisponibles.",
  },
  async (request) => {
    const url = new URL(request.url);
    const input = adminPublicationQuerySchema.parse({
      status: url.searchParams.get("status") ?? undefined,
      search: url.searchParams.get("search") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return listAdminPublicationRequests({ authToken: bearerTokenFromRequest(request), input });
  },
);

export const PATCH = adminRoute(
  {
    scope: "admin.publications.review",
    fallbackMessage: "Mise à jour de la publication impossible.",
  },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminPublicationReviewInputSchema.parse(await request.json());
    return reviewAdminPublicationRequest({ authToken, input });
  },
);
