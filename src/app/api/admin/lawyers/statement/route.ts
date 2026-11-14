import { getAdminLawyerStatement } from "@/lib/admin-lawyer-statement";
import { adminRoute } from "@/lib/admin-route-deadline";
import { lawyerStatementMonthSchema } from "@/lib/lawyer-statement";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Relevé mensuel des avocats référencés (point 72) : `?month=AAAA-MM`, administrateur seulement,
 * jamais mis en cache. Des nombres par avocat, aucune donnée d'acquéreur.
 */
export const GET = adminRoute(
  { scope: "admin.lawyers.statement.read", fallbackMessage: "Relevé indisponible", guard: "admin" },
  async (request, { authToken }) => {
    const month = lawyerStatementMonthSchema.parse(new URL(request.url).searchParams.get("month"));
    return getAdminLawyerStatement(authToken, month);
  },
);
