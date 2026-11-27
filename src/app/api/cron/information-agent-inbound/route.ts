import { runInformationAgentInboundQueue } from "@/lib/information-agent-inbound";
import { dispatchPendingInformationAgentEvidence } from "@/lib/information-agent-evidence-dispatch.server";
import { runAutoPublicationPassForCron } from "@/lib/information-agent/auto-publication-store";
import { runMonitoredCron } from "@/lib/cron-jobs";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "information-agent-inbound", async () => {
    const result = await runInformationAgentInboundQueue({ limit: 5 });
    // Lance l'analyse par l'IA sans attendre l'horaire GitHub ; ne lève jamais (voir le module).
    const evidenceDispatch = await dispatchPendingInformationAgentEvidence();
    // Moteur « publier ou relire » (étape 6) : en simulation, journalise sans rien publier ; en mode automatique,
    // publie par la seule RPC de publication (verdict de Haiku rendu par le worker de l'analyse). Son échec
    // n'empêche pas la passe des réponses ; il fait échouer le cron ci-dessous (signalé, jamais avalé).
    const autoPublication = await runAutoPublicationPassForCron();
    if (Number(result.failed) > 0) {
      // Le résumé est perdu quand la passe échoue : le résultat du déclenchement reste dans le message.
      const dispatch =
        evidenceDispatch.status === "failed"
          ? `${evidenceDispatch.status} (${evidenceDispatch.reason})`
          : evidenceDispatch.status;
      throw new Error(
        `Inbound queue failed for ${result.failed} message(s); evidence dispatch: ${dispatch}.`,
      );
    }
    if (autoPublication.status === "failed") {
      throw new Error(`Auto-publication pass failed: code ${autoPublication.code}.`);
    }
    if ("recordFailed" in autoPublication && autoPublication.recordFailed > 0) {
      throw new Error(
        `Auto-publication pass failed: ${autoPublication.recordFailed} decision(s) not recorded.`,
      );
    }
    if ("publishFailed" in autoPublication && autoPublication.publishFailed > 0) {
      throw new Error(
        `Auto-publication pass failed: ${autoPublication.publishFailed} publication(s) failed and left for review.`,
      );
    }
    return { ...result, evidenceDispatch, autoPublication };
  });
}
