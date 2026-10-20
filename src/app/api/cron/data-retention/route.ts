import { runDataRetention, runMonitoredCron } from "@/lib/cron-jobs";

// Purges isolées en base (chacune a son propre délai) : même plafond que les autres tâches longues.
// Next.js veut un littéral ici.
export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "data-retention", () => runDataRetention());
}
