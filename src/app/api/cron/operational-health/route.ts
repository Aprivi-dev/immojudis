import { evaluateOperationalHealth, runMonitoredCron } from "@/lib/cron-jobs";

export async function GET(request: Request) {
  return runMonitoredCron(request, "operational-health", () => evaluateOperationalHealth());
}
