import { runDataRetention, runMonitoredCron } from "@/lib/cron-jobs";

export async function GET(request: Request) {
  return runMonitoredCron(request, "data-retention", () => runDataRetention());
}
