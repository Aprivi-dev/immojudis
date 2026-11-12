import type { AdminScrollMode, AdminScrollSource, AuctionRun } from "@/lib/admin.server";

export type AdminRunRequest = {
  source: AdminScrollSource;
  mode: AdminScrollMode;
  limit?: number;
};

/** Sources que l'administration lance ou relance (`all` : toutes) ; `admin.server.ts` valide avec. */
export const SCROLL_SOURCES = [
  "all",
  "avoventes",
  "licitor",
  "info_encheres",
  "encheres_publiques",
  "cessions_etat",
  "agrasc",
  "encheres_immobilieres",
  "notaires",
] as const;

const collectionSources = new Set<string>(SCROLL_SOURCES);

export function adminRunRestartRequest(run: AuctionRun): AdminRunRequest | null {
  if (run.status === "queued" || run.status === "running") return null;
  // A former AI description backfill run (mode "llm_backfill") is never restarted: the backfill was removed.
  if (run.summary.mode && run.summary.mode !== "collect") return null;
  if (!run.source || !collectionSources.has(run.source)) return null;
  return { source: run.source as AdminScrollSource, mode: "collect" };
}
