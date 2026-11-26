import { runMonitoredCron } from "@/lib/cron-jobs";
import {
  assertOnboardingEmailsComplete,
  runOnboardingEmails,
} from "@/lib/onboarding-email-notices";

// Quelques lectures et un envoi Resend par compte ; le passage s'arrête de lui-même après 50 s
// (`EMAIL_PASS_BUDGET_MS`) puis échoue pour être vu. Next.js veut un littéral ici.
export const maxDuration = 60;

/**
 * Email unique de prise en main, le lendemain de l'inscription. Passe chaque jour à 13:30 UTC, puis une
 * seconde fois à 15:30 (rattrapage, `scheduled-jobs.ts`) seulement si le premier passage a échoué : la
 * file ne reprend un envoi que dans les 23 heures de son premier essai, car la clé d'idempotence de
 * Resend ne protège d'un doublon que 24 heures. Sans `ONBOARDING_EMAIL_MODE` (défaut `off`), le passage
 * réussit sans rien lire ni envoyer.
 *
 * Un passage dont un envoi est dû mais Resend non configuré, dont des envois ont échoué ou que le délai a
 * interrompu, échoue : la supervision le voit, et le rattrapage reprend les envois encore dus (le
 * journal `onboarding_email_notices`, clé = le compte, empêche tout doublon). Un envoi qui échoue encore
 * au rattrapage n'est plus rejoué : il reste en `failed`, compté dans `needsReview` du compte rendu.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "onboarding-email", async () => {
    const summary = await runOnboardingEmails();
    assertOnboardingEmailsComplete(summary);
    return { ...summary };
  });
}
