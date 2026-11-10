import { runInformationAgentInboundQueue } from "@/lib/information-agent-inbound";
import { dispatchPendingInformationAgentEvidence } from "@/lib/information-agent-evidence-dispatch.server";
import { runAutoPublicationSimulationForCron } from "@/lib/information-agent/auto-publication-store";
import { runMonitoredCron } from "@/lib/cron-jobs";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "information-agent-inbound", async () => {
    const result = await runInformationAgentInboundQueue({ limit: 5 });
    // Lance l'analyse par l'IA sans attendre l'horaire GitHub ; ne lève jamais (voir le module).
    const evidenceDispatch = await dispatchPendingInformationAgentEvidence();
    // Moteur « publier ou relire » : en mode simulation seulement, journalise sans rien publier. Son échec
    // n'empêche pas la passe des réponses ; il fait échouer le cron ci-dessous (signalé, jamais avalé).
    const autoPublication = await runAutoPublicationSimulationForCron();
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
    if (
      autoPublication.status === "failed" ||
      (autoPublication.status === "done" && autoPublication.recordFailed > 0)
    ) {
      throw new Error(
        `Auto-publication simulation failed: ${
          autoPublication.status === "failed"
            ? `code ${autoPublication.code}`
            : `${autoPublication.recordFailed} decision(s) not recorded`
        }.`,
      );
    }
    return { ...result, evidenceDispatch, autoPublication };
  });
}
