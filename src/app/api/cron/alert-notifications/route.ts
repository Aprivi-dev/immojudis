import {
  assertAlertNotificationDispatchComplete,
  dispatchDueAlertNotifications,
} from "@/lib/alert-notifications";
import { retryFailedCommercialConfirmations } from "@/lib/commercial-acceptance";
import { positiveNumberFromEnv, runMonitoredCron } from "@/lib/cron-jobs";

// Envois par lots (e-mails Resend un à un) : même plafond que `smart-alerts`, qui les prépare.
// Next.js veut un littéral ici.
export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "alert-notifications", async () => {
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
  });
}
