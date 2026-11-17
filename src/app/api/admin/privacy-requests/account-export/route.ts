import { z } from "zod";
import { adminRoute } from "@/lib/admin-route-deadline";
import { exportAccountPrivacyData } from "@/lib/privacy-account-export";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const querySchema = z.object({ requestId: z.string().guid() });

/**
 * Copie des données d'un titulaire de compte pour sa demande d'accès ou de portabilité : les tables de
 * l'effacement (`ERASURE_TABLES`), le compte et ses demandes, sans secret ni identifiant interne.
 */
export const GET = adminRoute(
  {
    scope: "api.admin.privacy_requests.account_export",
    fallbackMessage: "Export impossible.",
    guard: "admin",
  },
  async (request, { auth }) => {
    const { requestId } = querySchema.parse({
      requestId: new URL(request.url).searchParams.get("requestId"),
    });
    return exportAccountPrivacyData({ auth, requestId });
  },
);
