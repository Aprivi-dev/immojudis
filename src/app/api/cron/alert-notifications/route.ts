import {
  assertAlertNotificationDispatchComplete,
  dispatchDueAlertNotifications,
} from "@/lib/alert-notifications";
import { retryFailedCommercialConfirmations } from "@/lib/commercial-acceptance";
import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";

// Envois par lots (e-mails Resend un à un) : même plafond que `smart-alerts`, qui les prépare.
// Next.js veut un littéral ici.
export const maxDuration = 300;

/**
 * Passe une heure après `smart-alerts` (06:15, rattrapage 08:15) : sur le plan Hobby de Vercel un
 * cron tombe à n'importe quel moment de l'heure demandée, donc deux tâches de la même heure n'ont
 * aucun ordre garanti. Les notifications que `smart-alerts` crée sont prévues à 07:00 UTC
 * (`scheduledForFrequency`) : 07:30 les trouve échues, 06:30 ne le pouvait pas.
 */
const CATCH_UP_SCHEDULE = "30 9 * * *";

export async function GET(request: Request) {
  return runMonitoredCron(
    request,
    "alert-notifications",
    async () => {
      const [alerts, commercialConfirmations] = await Promise.all([
        dispatchDueAlertNotifications({
          limit: positiveNumberFromEnv("ALERT_NOTIFICATION_CRON_LIMIT"),
        }),
        retryFailedCommercialConfirmations({
          limit: positiveNumberFromEnv("COMMERCIAL_CONFIRMATION_CRON_LIMIT"),
        }),
      ]);
      // Les notifications dans l'application et les confirmations sont déjà parties : un e-mail
      // manquant ou en échec fait échouer le passage (le rattrapage reprend les envois en file).
      assertAlertNotificationDispatchComplete(alerts);
      return { ...alerts, commercialConfirmations };
    },
    { catchUpSchedule: CATCH_UP_SCHEDULE },
  );
}
