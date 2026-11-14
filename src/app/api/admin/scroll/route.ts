import { startAdminScroll } from "@/lib/admin.server";
import { PublicApiError } from "@/lib/api-errors";
import { isPublicErrorMessage } from "@/lib/api-error-detail";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const POST = adminRoute(
  {
    scope: "admin.scroll.start",
    fallbackMessage: "La collecte n'a pas pu être lancée.",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const result = await startAdminScroll(authToken, await request.json());
    if (!result.ok || !result.dispatched) {
      // The dispatch summary is composed by our own code, but never forward anything
      // that does not read like a user-facing message.
      const publicMessage = isPublicErrorMessage(result.message)
        ? result.message
        : "La collecte n'a pas pu être lancée.";
      throw new PublicApiError(publicMessage, 502);
    }
    return result;
  },
);
