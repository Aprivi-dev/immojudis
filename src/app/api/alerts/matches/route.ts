import { z } from "zod";
import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import {
  evaluateUserAlertMatches,
  listUserAlertMatches,
  type PublicAlertEvaluationResponse,
} from "@/lib/alert-matches";

const evaluateBodySchema = z.object({
  saleLimit: z.number().int().positive().optional(),
  persist: z.boolean().optional(),
});

export const GET = apiRoute(
  { scope: "api.alerts.matches.list", fallbackMessage: "Matches d'alertes indisponibles" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const includeDismissed = url.searchParams.get("includeDismissed") === "true";
    return listUserAlertMatches({ auth, limit, includeDismissed });
  },
);

export const POST = apiRoute(
  { scope: "api.alerts.matches.evaluate", fallbackMessage: "Évaluation des alertes impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    // Corps facultatif : absent ou vide, les valeurs par défaut s'appliquent. Un JSON mal formé ou
    // `null` est une erreur de l'appelant (400), pas une panne.
    const rawBody = await request.text();
    const body = evaluateBodySchema.parse(rawBody.trim() ? JSON.parse(rawBody) : {});
    const response = await evaluateUserAlertMatches({
      auth,
      saleLimit: body.saleLimit,
      persist: body.persist ?? true,
    });

    // Every alert failed: not « 0 correspondance ». The reasons are already in the server logs.
    if (response.alertCount > 0 && response.failedAlertCount >= response.alertCount) {
      throw new PublicApiError(
        "L’évaluation de vos alertes est momentanément indisponible. Réessayez dans quelques minutes.",
        503,
      );
    }

    // The raw error of a failed alert (database message, details, hint) never reaches the browser.
    const publicResponse: PublicAlertEvaluationResponse = {
      ...response,
      alertFailures: response.alertFailures.map(({ alertId }) => ({
        alertId,
        code: "alert_evaluation_failed",
      })),
    };
    return publicResponse;
  },
);
