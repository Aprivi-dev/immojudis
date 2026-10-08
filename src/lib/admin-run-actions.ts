import type { AdminScrollMode, AdminScrollSource, AuctionRun } from "@/lib/admin.functions";

export type AdminRunRequest = {
  source: AdminScrollSource;
  mode: AdminScrollMode;
  limit?: number;
};

const collectionSources = new Set<AdminScrollSource>([
  "all",
  "avoventes",
  "licitor",
  "vench",
  "info_encheres",
  "encheres_publiques",
  "petites_affiches",
  "cessions_etat",
  "agrasc",
  "encheres_immobilieres",
  "notaires",
]);

export function adminRunRestartRequest(run: AuctionRun): AdminRunRequest | null {
  if (run.status === "queued" || run.status === "running") return null;
  if (
    run.source === "llm-description-backfill" ||
    run.summary.mode === "llm_backfill" ||
    run.summary.mode === "llm_description_backfill"
  ) {
    // Historical workers did not retain the requested batch size. Do not
    // silently start a larger AI batch when the original limit is unknown.
    const limit = Number(run.summary.limit);
    return Number.isInteger(limit) && limit >= 1 && limit <= 100
      ? { source: "all", mode: "llm_backfill", limit }
      : null;
  }
  if (run.summary.mode && run.summary.mode !== "collect") return null;
  if (!collectionSources.has(run.source as AdminScrollSource)) return null;
  return { source: run.source as AdminScrollSource, mode: "collect" };
}
