import { runMonitoredCron } from "@/lib/cron-jobs";
import {
  assertRepliesReviewDigestComplete,
  runRepliesReviewDigest,
} from "@/lib/replies-review-digest";

// Deux lectures de comptage et, au plus, trois envois Resend de 15 s au plus. Next.js veut un littéral ici.
export const maxDuration = 60;

/**
 * Résumé quotidien « N réponses à relire » (réponses de l'agent en relecture et messages non rattachés)
 * pour l'exploitation, envoyé aux adresses de `OPERATIONS_ALERT_EMAIL_TO`. Passe chaque jour à 07:05 UTC.
 * Sans `REPLIES_REVIEW_DIGEST_MODE` (défaut `off`), le passage réussit sans rien lire ni envoyer ; en
 * `preview`, il compte sans envoyer ; en `on`, il n'envoie rien quand il n'y a rien à relire. Un seul
 * passage par jour, sans rattrapage : la clé d'idempotence de Resend empêche tout doublon, et un passage
 * qui échoue est vu par la supervision et relancé à la main (le lendemain, le résumé couvre le tout).
 *
 * Ce n'est PAS un message de l'agent d'information : il n'écrit jamais à l'expéditeur d'un message et
 * n'accuse réception de rien.
 */
export async function GET(request: Request) {
  return runMonitoredCron(request, "replies-review-digest", async () => {
    const summary = await runRepliesReviewDigest();
    assertRepliesReviewDigestComplete(summary);
    return { ...summary };
  });
}
