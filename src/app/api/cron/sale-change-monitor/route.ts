import { runMonitoredCron } from "@/lib/cron-jobs";
import { serverEnv } from "@/lib/env";
import { runSaleChangeMonitorBatch } from "@/lib/sale-change-monitor";

// Une dizaine de lectures par compte, tous les comptes ayant consenti aux rappels d'audience étant
// examinés chaque jour en plus du lot tourné. Next.js veut un littéral ici.
export const maxDuration = 300;

export async function GET(request: Request) {
  return runMonitoredCron(request, "sale-change-monitor", () =>
    runSaleChangeMonitorBatch({
      userLimit: serverEnv().batchLimits.saleChangeUsers,
    }),
  );
}
