import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Result<T> = { data: T | null; error: { message?: string } | null };
type StorageItem = { id: string; bucket: string; object_path: string };
/** `lock_busy` : un autre passage tenait le verrou, la purge des ventes n'a pas (ou pas tout) tourné. */
type SalePurgeStatus = "completed" | "lock_busy";
type SalePurgeResult = { deleted: number; remaining: number | null; busy: boolean };
type RetentionClient = {
  rpc(
    name: "purge_expired_auction_sales" | "enqueue_orphan_information_agent_portal_uploads",
    args: Record<string, unknown>,
  ): Promise<Result<SalePurgeResult | number>>;
  from(name: string): {
    select(columns: string): {
      order(column: string): { limit(count: number): Promise<Result<StorageItem[]>> };
    };
    delete(): { in(column: string, values: string[]): Promise<Result<unknown>> };
  };
  storage: { from(bucket: string): { remove(paths: string[]): Promise<Result<unknown>> } };
};

const RETENTION_BUCKETS = [
  "information-agent-evidence",
  "information-agent-approved",
  "sale-photos",
];

type RetentionStep = "purge" | "orphans" | "storage";
type StepFailure = { step: RetentionStep; message: string };

/** Échec d'au moins une étape : les autres se sont exécutées, `summary` dit ce qui a été fait. */
export class SaleRetentionError extends Error {
  constructor(
    readonly failures: StepFailure[],
    readonly summary: Record<string, unknown>,
  ) {
    super(`Sale retention: ${failures.map((f) => `${f.step}: ${f.message}`).join(" ; ")}.`);
    this.name = "SaleRetentionError";
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const { message } = error as { message?: unknown };
    if (typeof message === "string" && message) return message;
  }
  return "Unknown failure";
}

/**
 * Bounded transactions; the durable outbox survives Storage API failures. Three independent steps
 * — purge of the expired sales, queueing of orphan portal uploads, draining of the Storage queue —
 * each run and report their own error: a failing purge no longer leaves the orphans queued and the
 * files already committed for removal waiting for the next run. The job fails (the error is
 * thrown, after all three ran) as soon as one step failed.
 */
export async function runSaleRetention(
  now = new Date(),
  client = supabaseAdmin as unknown as RetentionClient,
): Promise<Record<string, unknown>> {
  const failures: StepFailure[] = [];
  const purge = { deleted: 0, remaining: null as number | null, busy: false };
  let orphanUploadsQueued: number | null = null;

  try {
    await purgeExpiredSales(now, client, purge);
  } catch (error) {
    failures.push({ step: "purge", message: failureMessage(error) });
  }
  try {
    orphanUploadsQueued = await queueOrphanUploads(now, client);
  } catch (error) {
    failures.push({ step: "orphans", message: failureMessage(error) });
  }
  const storage = await drainStorageQueue(client);
  const { filesDeleted } = storage;
  failures.push(...storage.failures);

  const { deleted, remaining, busy } = purge;
  // Un verrou tenu par un autre passage n'est pas un succès : la purge n'a pas (ou pas tout) tourné. Le
  // champ `purgeStatus` le dit explicitement dans le résumé du job, et une ligne de journal l'avertit.
  const purgeStatus: SalePurgeStatus = busy ? "lock_busy" : "completed";
  if (busy) {
    console.warn(
      JSON.stringify({ scope: "sale-retention", event: "purge_lock_busy", deleted, remaining }),
    );
  }
  const summary = { deleted, remaining, busy, purgeStatus, orphanUploadsQueued, filesDeleted };
  if (failures.length) {
    for (const failure of failures) {
      console.error(
        JSON.stringify({ scope: "sale-retention", event: "step_failed", ...failure, ...summary }),
      );
    }
    throw new SaleRetentionError(failures, summary);
  }
  return summary;
}

async function purgeExpiredSales(
  now: Date,
  client: RetentionClient,
  progress: { deleted: number; remaining: number | null; busy: boolean },
): Promise<void> {
  const started = Date.now();
  for (let batch = 0; batch < 12 && Date.now() - started < 180_000; batch++) {
    const result = await client.rpc("purge_expired_auction_sales", {
      p_now: now.toISOString(),
      p_limit: 25,
    });
    if (result.error || !result.data || typeof result.data === "number")
      throw new Error(result.error?.message || "Missing retention result");
    progress.deleted += result.data.deleted;
    progress.remaining = result.data.remaining;
    progress.busy = result.data.busy;
    if (progress.busy || !progress.remaining || !result.data.deleted) break;
  }
}

async function queueOrphanUploads(now: Date, client: RetentionClient): Promise<number> {
  const orphanQueue = await client.rpc("enqueue_orphan_information_agent_portal_uploads", {
    p_now: now.toISOString(),
    p_limit: 100,
  });
  if (orphanQueue.error || typeof orphanQueue.data !== "number") {
    throw new Error(orphanQueue.error?.message || "Portal upload cleanup unavailable");
  }
  return orphanQueue.data;
}

async function drainStorageQueue(
  client: RetentionClient,
): Promise<{ filesDeleted: number; failures: StepFailure[] }> {
  const failures: StepFailure[] = [];
  const removedIds: string[] = [];
  try {
    const queue = await client
      .from("sale_retention_storage_queue")
      .select("id,bucket,object_path")
      .order("created_at")
      .limit(100);
    if (queue.error) throw new Error(queue.error.message || "Storage retention queue unavailable");
    // One Storage call per bucket, then a single acknowledgement for every object
    // that was really removed. Removing an already-deleted object is a no-op, so
    // a retry after a partial failure is safe.
    const byBucket = new Map<string, StorageItem[]>();
    for (const item of queue.data ?? []) {
      byBucket.set(item.bucket, [...(byBucket.get(item.bucket) ?? []), item]);
    }
    for (const [bucket, items] of byBucket) {
      if (!RETENTION_BUCKETS.includes(bucket)) {
        failures.push({ step: "storage", message: "Unexpected retention bucket" });
        break;
      }
      const removal = await client.storage
        .from(bucket)
        .remove(items.map((item) => item.object_path));
      if (removal.error) {
        failures.push({
          step: "storage",
          message: removal.error.message || "Storage retention failed",
        });
        break;
      }
      removedIds.push(...items.map((item) => item.id));
    }
  } catch (error) {
    failures.push({ step: "storage", message: failureMessage(error) });
  }
  // Acknowledge what was removed even when a later bucket failed, so only the
  // failed work stays queued for the next run.
  let filesDeleted = 0;
  if (removedIds.length) {
    try {
      const ack = await client.from("sale_retention_storage_queue").delete().in("id", removedIds);
      if (ack.error)
        throw new Error(ack.error.message || "Storage retention acknowledgement failed");
      filesDeleted = removedIds.length;
    } catch (error) {
      failures.push({ step: "storage", message: failureMessage(error) });
    }
  }
  return { filesDeleted, failures };
}
