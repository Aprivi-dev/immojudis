import { runBillingReconciliationJob } from "@/lib/billing-reconciliation";
import { runMonitoredCron } from "@/lib/cron-jobs";

// Lecture paginée des abonnements Stripe (100 par page, 50 pages au plus) : même plafond que les autres
// tâches longues. Next.js veut un littéral ici.
export const maxDuration = 300;

/**
 * Rapprochement quotidien entre les abonnements Stripe et les droits en base (n° 48). Lecture seule :
 * il ne corrige rien, il ouvre une alerte opérationnelle dès qu'un écart apparaît. Sans Stripe
 * configuré, il ne fait rien. Même protection que les autres routes planifiées : jeton `CRON_SECRET`,
 * supervision par `runMonitoredCron`, reprise sur erreur réseau.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "billing-reconciliation", () => runBillingReconciliationJob());
}
