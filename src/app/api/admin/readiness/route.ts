import { getAdminOperationalReadiness } from "@/lib/admin-readiness";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  { scope: "admin.readiness.read", fallbackMessage: "Diagnostic indisponible", guard: "admin" },
  async (_request, { authToken }) => getAdminOperationalReadiness(authToken),
);
