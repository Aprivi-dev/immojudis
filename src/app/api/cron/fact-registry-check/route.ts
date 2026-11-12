import { runMonitoredCron } from "@/lib/cron-jobs";
import { runFactRegistryCheckJob } from "@/lib/fact-registry-check";

// Des appels à la base bornés chacun à 120 s par la fonction appelée : la relance planifiée (30 ventes par
// passe, les passes s'enchaînent tant qu'il reste du temps pour le contrôle :
// `REPROJECTION_PASS_START_BUDGET_MS`), puis une lecture par vente du registre. Même plafond que les autres
// tâches de contrôle. Next.js veut un littéral ici.
export const maxDuration = 300;

/**
 * Contrôle quotidien du registre des pièces (lots R2a et R2b). Le contrôle est en lecture seule côté
 * fiches : il ouvre ou referme les alertes opérationnelles `fact_registry.*`. Avant lui, la relance
 * planifiée de la projection, fermée par défaut, réapplique aux fiches qui ont dérivé des décisions
 * humaines déjà acceptées (`docs/runbooks/registre-des-pieces-r2b.md`). Même protection que les autres
 * routes planifiées : jeton `CRON_SECRET`, supervision par `runMonitoredCron`, reprise sur erreur réseau
 * (la tâche classe la panne passagère avant de nettoyer le message de l'erreur).
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "fact-registry-check", () => runFactRegistryCheckJob());
}
