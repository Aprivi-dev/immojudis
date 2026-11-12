import { runMonitoredCron } from "@/lib/cron-jobs";
import { runFactRegistryCheckJob } from "@/lib/fact-registry-check";

// Une lecture par vente qui tient ou mémorise un champ (500 au plus) : quelques secondes. Même plafond que
// les autres tâches de contrôle. Next.js veut un littéral ici.
export const maxDuration = 300;

/**
 * Contrôle quotidien du registre des pièces (lot R2a). Lecture seule côté fiches : il ne corrige rien,
 * il ouvre ou referme les alertes opérationnelles `fact_registry.*`. Même protection que les autres
 * routes planifiées : jeton `CRON_SECRET`, supervision par `runMonitoredCron`, reprise sur erreur réseau.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "fact-registry-check", () => runFactRegistryCheckJob());
}
