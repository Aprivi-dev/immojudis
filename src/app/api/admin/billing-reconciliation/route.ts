import { adminRoute } from "@/lib/admin-route-deadline";
import { reconcileBillingReadOnly } from "@/lib/billing-reconciliation";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Rapprochement Stripe / base, en lecture seule : liste les écarts, ne corrige rien.
 */
export const GET = adminRoute(
  {
    scope: "admin.billing-reconciliation.read",
    fallbackMessage: "Rapprochement indisponible",
    guard: "admin",
  },
  async (_request, { authToken }) => reconcileBillingReadOnly(authToken),
);
