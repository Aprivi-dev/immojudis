import { runMonitoredCron } from "@/lib/cron-jobs";
import { assertTrialEndNoticesComplete, runTrialEndNotices } from "@/lib/trial-end-notices";

// Quelques lectures et un envoi Resend par compte ; le passage s'arrête de lui-même après 50 s
// (`TRIAL_END_BUDGET_MS`) puis échoue pour être vu. Next.js veut un littéral ici.
export const maxDuration = 60;

/**
 * Rattrapage du second passage : 14:30 UTC, deux heures après le passage de 12:30. Il ne fait rien quand
 * la tâche a déjà réussi dans les 20 dernières heures (`runMonitoredCron`) ; il ne repart donc que si le
 * passage de 12:30 a échoué, et reprend alors les envois en échec le MÊME jour. Le lendemain serait trop
 * tard : la file ne reprend un envoi que dans les 23 heures du premier essai, car la clé d'idempotence de
 * Resend ne protège d'un doublon que pendant 24 heures.
 */

/**
 * Email unique de fin d'essai gratuit (J+5). Passe chaque jour à 12:30 UTC, après les envois d'alertes
 * (07:30, rattrapage 09:30), les rappels d'audience (07:15, 09:15), les alertes de résultat (10:15) et le
 * récapitulatif hebdomadaire (11:30), puis une seconde fois à 14:30 si le premier passage a échoué. Sans
 * `TRIAL_END_EMAIL_MODE` (défaut `off`), le passage réussit sans rien lire ni envoyer.
 *
 * Un passage dont un envoi est dû mais Resend non configuré, dont des envois ont échoué ou que le délai a
 * interrompu, échoue : la supervision le voit, et le rattrapage de 14:30 reprend les envois encore dus
 * (le journal `launch_offer_end_notices` empêche tout doublon). Un envoi qui échoue encore au rattrapage
 * n'est pas rejoué le lendemain (hors des 23 heures de reprise) : il reste en `failed` dans le journal,
 * compté dans `needsReview` du compte rendu, pour une reprise à la main.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "trial-end-email", async () => {
    const summary = await runTrialEndNotices();
    assertTrialEndNoticesComplete(summary);
    return { ...summary };
  });
}
