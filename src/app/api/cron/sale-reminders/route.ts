import { runMonitoredCron } from "@/lib/cron-jobs";
import { runSaleReminders } from "@/lib/sale-reminders";
import { createSupabaseSaleReminderStore } from "@/lib/sale-reminders-store";

// Une personne = quelques lectures ; les passages longs s'arrêtent d'eux-mêmes après 50 s
// (`PROCESSING_BUDGET_MS` de `sale-reminders.ts`) et reprennent le lendemain. Next.js veut un
// littéral ici.
export const maxDuration = 60;

/**
 * Rappels d'audience (J-7, J-1) et avertissements graves sur les ventes suivies. Passe après le
 * suivi des changements (`sale-change-monitor`, 06:45) dont il lit les événements. Sans
 * `SALE_REMINDERS_MODE` (défaut `off`), le passage réussit sans rien lire ni envoyer.
 */
export async function GET(request: Request) {
  return runMonitoredCron(
    request,
    "sale-reminders",
    async () => ({ ...(await runSaleReminders({ store: createSupabaseSaleReminderStore() })) }),
    { catchUpSchedule: "15 9 * * *" },
  );
}
