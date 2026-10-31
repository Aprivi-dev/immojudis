import { runMonitoredCron } from "@/lib/cron-jobs";
import { assertTrialEndNoticesComplete, runTrialEndNotices } from "@/lib/trial-end-notices";

// Quelques lectures et un envoi Resend par compte ; le passage s'arrête de lui-même après 50 s
// (`TRIAL_END_BUDGET_MS`) puis échoue pour être vu. Next.js veut un littéral ici.
export const maxDuration = 60;

/**
 * Email unique de fin d'essai gratuit (J+5). Passe chaque jour à 12:30 UTC, après les envois d'alertes
 * (07:30, rattrapage 09:30), les rappels d'audience (07:15, 09:15), les alertes de résultat (10:15) et le
 * récapitulatif hebdomadaire (11:30). Sans `TRIAL_END_EMAIL_MODE` (défaut `off`), le passage réussit sans
 * rien lire ni envoyer.
 *
 * Un passage dont un envoi est dû mais Resend non configuré, dont des envois ont échoué ou que le délai a
 * interrompu, échoue : la supervision le voit, et le passage du lendemain reprend les envois encore dus
 * (l'essai se termine deux jours après le passage de J+5), le journal `launch_offer_end_notices`
 * empêchant tout doublon.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "trial-end-email", async () => {
    const summary = await runTrialEndNotices();
    assertTrialEndNoticesComplete(summary);
    return { ...summary };
  });
}
