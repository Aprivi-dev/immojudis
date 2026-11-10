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
      throw new Error(`Inbound queue failed for ${result.failed} message(s).`);
    }
    return { ...result, evidenceDispatch };
  });
}
