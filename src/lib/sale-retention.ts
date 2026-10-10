import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

type Result<T> = { data: T | null; error: { message?: string } | null };
type StorageItem = { id: string; bucket: string; object_path: string };
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

/** Bounded transactions; the durable outbox survives Storage API failures. */
export async function runSaleRetention(
  now = new Date(),
  client = supabaseAdmin as unknown as RetentionClient,
): Promise<Record<string, unknown>> {
  let deleted = 0;
  let remaining: number | null = null;
  let busy = false;
  const started = Date.now();
  for (let batch = 0; batch < 12 && Date.now() - started < 180_000; batch++) {
    const result = await client.rpc("purge_expired_auction_sales", {
      p_now: now.toISOString(),
      p_limit: 25,
    });
    if (result.error || !result.data || typeof result.data === "number")
      throw new Error(result.error?.message || "Missing retention result");
    deleted += result.data.deleted;
    remaining = result.data.remaining;
    busy = result.data.busy;
    if (busy || !remaining || !result.data.deleted) break;
  }
  const orphanQueue = await client.rpc("enqueue_orphan_information_agent_portal_uploads", {
    p_now: now.toISOString(),
    p_limit: 100,
  });
  if (orphanQueue.error || typeof orphanQueue.data !== "number") {
    throw new Error(orphanQueue.error?.message || "Portal upload cleanup unavailable");
  }
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
  const removedIds: string[] = [];
  let removalFailure: Error | null = null;
  for (const [bucket, items] of byBucket) {
    if (!["information-agent-evidence", "information-agent-approved"].includes(bucket)) {
      removalFailure = new Error("Unexpected retention bucket");
      break;
    }
    const removal = await client.storage.from(bucket).remove(items.map((item) => item.object_path));
    if (removal.error) {
      removalFailure = new Error(removal.error.message || "Storage retention failed");
      break;
    }
    removedIds.push(...items.map((item) => item.id));
  }
  // Acknowledge what was removed even when a later bucket failed, so only the
  // failed work stays queued for the next run.
  if (removedIds.length) {
    const ack = await client.from("sale_retention_storage_queue").delete().in("id", removedIds);
    if (ack.error) throw new Error(ack.error.message || "Storage retention acknowledgement failed");
  }
  if (removalFailure) throw removalFailure;
  const filesDeleted = removedIds.length;
  return { deleted, remaining, busy, orphanUploadsQueued: orphanQueue.data, filesDeleted };
}
