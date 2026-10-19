import { runMonitoredCron } from "@/lib/cron-jobs";
import { assertSaleRemindersComplete, runSaleReminders } from "@/lib/sale-reminders";
import { createSupabaseSaleReminderStore } from "@/lib/sale-reminders-store";

// Une personne = quelques lectures ; les passages longs s'arrêtent d'eux-mêmes après 50 s
// (`PROCESSING_BUDGET_MS` de `sale-reminders.ts`) puis échouent pour que le rattrapage reprenne.
// Next.js veut un littéral ici.
export const maxDuration = 60;

const CATCH_UP_SCHEDULE = "15 9 * * *";

/**
 * Rappels d'audience (J-7, J-1) et avertissements graves sur les ventes suivies. Passe après le
 * suivi des changements (`sale-change-monitor`, 06:45) dont il lit les événements. Sans
 * `SALE_REMINDERS_MODE` (défaut `off`), le passage réussit sans rien lire ni envoyer.
 *
 * Un passage interrompu par le délai, ou dont des envois ont échoué, échoue : la supervision le
 * voit et le rattrapage (09:15) reprend, en rejouant les envois en échec et les réservations
 * orphelines (voir `claim_sale_reminder`) et en partant de l'autre moitié des destinataires.
 */
export async function GET(request: Request) {
  const catchUp = request.headers.get("x-vercel-cron-schedule") === CATCH_UP_SCHEDULE;
  return runMonitoredCron(
    request,
    "sale-reminders",
    async () => {
      const summary = await runSaleReminders({
        store: createSupabaseSaleReminderStore(),
        catchUp,
      });
      assertSaleRemindersComplete(summary);
      return { ...summary };
    },
    { catchUpSchedule: CATCH_UP_SCHEDULE },
  );
}
