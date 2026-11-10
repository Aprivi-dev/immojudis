import { runInformationAgentInboundQueue } from "@/lib/information-agent-inbound";
import { dispatchPendingInformationAgentEvidence } from "@/lib/information-agent-evidence-dispatch.server";
import { runMonitoredCron } from "@/lib/cron-jobs";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "information-agent-inbound", async () => {
    const result = await runInformationAgentInboundQueue({ limit: 5 });
    // Lance l'analyse par l'IA sans attendre l'horaire GitHub ; ne lève jamais (voir le module).
    const evidenceDispatch = await dispatchPendingInformationAgentEvidence();
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
    return { ...result, evidenceDispatch };
  });
}
