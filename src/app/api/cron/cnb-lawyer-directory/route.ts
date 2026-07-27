import { syncCnbLawyerDirectory } from "@/lib/cnb-directory-sync";
import { runMonitoredCron } from "@/lib/cron-jobs";

export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "cnb-lawyer-directory", () => syncCnbLawyerDirectory());
}
