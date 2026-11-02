import { runMonitoredCron } from "@/lib/cron-jobs";
import { runInformationAgentAutopilot } from "@/lib/information-agent-autopilot";

export const maxDuration = 300;

/**
 * Pilote automatique de l'agent d'information, appelé par pg_cron toutes les 10 minutes (et seulement si le
 * mode n'est pas « off »). Seule exception nommée du verrou `information-agent-no-automatic-send.test.ts`.
 */
export async function GET(request: Request) {
  // Jamais de rejeu automatique d'un passage qui peut avoir envoyé : le passage suivant (10 minutes) reprend.
  return runMonitoredCron(
    request,
    "information-agent-autopilot",
    async () => {
      const summary = await runInformationAgentAutopilot();
      return { ...summary };
    },
    { retryDelaysMs: [] },
  );
}
