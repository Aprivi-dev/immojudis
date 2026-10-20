import { runMonitoredCron } from "@/lib/cron-jobs";
import { assertWeeklyDigestComplete, runWeeklyDigest } from "@/lib/weekly-digest";
import { createSupabaseWeeklyDigestStore } from "@/lib/weekly-digest-store";

// Une personne = quelques lectures ; les passages longs s'arrêtent d'eux-mêmes après 50 s
// (`PROCESSING_BUDGET_MS` de `weekly-digest.ts`) puis échouent pour être vus. Next.js veut un littéral
// ici.
export const maxDuration = 60;

/**
 * Récapitulatif hebdomadaire « Ma semaine ». Passe chaque jour à 11:30 UTC (plan Hobby : dans l'heure
 * qui suit), après les envois d'alertes (07:30, rattrapage 09:30), les rappels d'audience (07:15,
 * 09:15) et les alertes de résultat (10:15) : la règle « au plus un email par compte et par jour »
 * repose sur cet ordre (voir `weekly-digest.ts`). Sans `WEEKLY_DIGEST_MODE` (défaut `off`), le passage
 * réussit sans rien lire ni envoyer.
 *
 * Un passage dont un envoi est dû mais Resend non configuré, dont des envois ont échoué ou que le
 * délai a interrompu, échoue : la supervision le voit, et le passage du lendemain reprend les envois
 * encore dus (jusqu'à deux jours après le jour choisi), le journal empêchant tout doublon.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "weekly-digest", async () => {
    const summary = await runWeeklyDigest({ store: createSupabaseWeeklyDigestStore() });
    assertWeeklyDigestComplete(summary);
    return { ...summary };
  });
}
