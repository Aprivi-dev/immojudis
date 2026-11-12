import { runMonitoredCron } from "@/lib/cron-jobs";
import { evaluateOperationalHealth } from "@/lib/operational-health-job";
import { dispatchDuePipeline } from "@/lib/pipeline-dispatch";

export async function GET(request: Request) {
  return runMonitoredCron(request, "operational-health", async () => {
    const [health, pipeline] = await Promise.allSettled([
      evaluateOperationalHealth(),
      dispatchDuePipeline(),
    ]);
    if (health.status === "rejected") throw health.reason;
    if (pipeline.status === "rejected") throw pipeline.reason;
    return { ...health.value, dispatch: pipeline.value };
  });
}
