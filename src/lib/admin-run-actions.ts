import type { AdminScrollMode, AdminScrollSource, AuctionRun } from "@/lib/admin.server";

export type AdminRunRequest = {
  source: AdminScrollSource;
  mode: AdminScrollMode;
  limit?: number;
};

const collectionSources = new Set<AdminScrollSource>([
  "all",
  "avoventes",
  "licitor",
  "info_encheres",
  "encheres_publiques",
  "cessions_etat",
  "agrasc",
  "encheres_immobilieres",
  "notaires",
]);

export function adminRunRestartRequest(run: AuctionRun): AdminRunRequest | null {
  if (run.status === "queued" || run.status === "running") return null;
  // A former AI description backfill run (mode "llm_backfill") is never restarted: the backfill was removed.
  if (run.summary.mode && run.summary.mode !== "collect") return null;
  if (!collectionSources.has(run.source as AdminScrollSource)) return null;
  return { source: run.source as AdminScrollSource, mode: "collect" };
}
