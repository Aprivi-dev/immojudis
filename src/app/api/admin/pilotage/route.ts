import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import {
  getAdminPilotage,
  getAdminSaleReminderAccuracy,
  unavailableSaleReminderAccuracy,
} from "@/lib/admin-pilotage";
import {
  getAdminSaleSignalFeedback,
  unavailableSaleSignalFeedback,
} from "@/lib/admin-sale-signal-feedback";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Agrégats de la page « Pilotage » : administrateur seulement, jamais mis en cache. */
async function handleGET(request: Request) {
  try {
    const token = bearerTokenFromRequest(request);
    const now = new Date();
    // La mesure des rappels ne doit pas faire tomber le reste du pilotage : en cas d'échec, elle vaut
    // « non mesuré » (le contrôle du rôle administrateur est fait par `getAdminPilotage`).
    const [pilotage, saleReminders, signalFeedback] = await Promise.all([
      getAdminPilotage(token, now),
      getAdminSaleReminderAccuracy(token, now).catch(() => {
        console.error("[admin-pilotage] mesure des fausses alertes des rappels indisponible");
        return unavailableSaleReminderAccuracy(now);
      }),
      // Même règle pour les retours « Utile » / « Pas pertinent » sur les signaux d'une vente.
      getAdminSaleSignalFeedback(token, now).catch(() => {
        console.error("[admin-pilotage] retours sur les signaux d'une vente indisponibles");
        return unavailableSaleSignalFeedback();
      }),
    ]);
    return NextResponse.json(
      { ...pilotage, saleReminders, signalFeedback },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return adminErrorResponse(error, {
      fallbackMessage: "Pilotage indisponible",
      fallbackStatus: 500,
    });
  }
}

export const GET = withAdminDeadline(handleGET);
