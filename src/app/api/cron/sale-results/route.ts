import { runMonitoredCron } from "@/lib/cron-jobs";
import { assertSaleResultsComplete, runSaleResults } from "@/lib/sale-results";
import { createSupabaseSaleResultStore } from "@/lib/sale-results-store";

// Une personne = quelques lectures ; les passages longs s'arrêtent d'eux-mêmes après 50 s
// (`PROCESSING_BUDGET_MS` de `sale-results.ts`) puis échouent pour être vus. Next.js veut un littéral
// ici.
export const maxDuration = 60;

/**
 * Alerte de résultat ou de remise en vente d'une vente suivie. Passe chaque jour à 10:15 UTC (plan
 * Hobby : dans l'heure qui suit), après le suivi des changements (06:45, rattrapage 08:45) dont elle
 * lit les événements et après les rappels d'audience (07:15, rattrapage 09:15), dont elle ne répète
 * pas les avertissements. Sans `SALE_RESULTS_MODE` (défaut `off`), le passage réussit sans rien lire ni
 * envoyer.
 *
 * Un passage dont une alerte est due mais Resend non configuré, dont des envois ont échoué ou que le
 * délai a interrompu, échoue : la supervision le voit, et le passage du lendemain reprend les envois en
 * échec (trois essais) tant que l'instantané ou l'événement est dans sa fenêtre de relecture, le
 * journal empêchant tout doublon.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "sale-results", async () => {
    const summary = await runSaleResults({ store: createSupabaseSaleResultStore() });
    assertSaleResultsComplete(summary);
    return { ...summary };
  });
}
