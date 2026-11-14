import { adminRoute } from "@/lib/admin-route-deadline";
import { getValuationAdminOverview } from "@/lib/valuation-admin";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.valuation-models.read",
    fallbackMessage: "Modèles de valorisation indisponibles",
    guard: "admin",
  },
  async (_request, { authToken }) => getValuationAdminOverview(authToken),
);
