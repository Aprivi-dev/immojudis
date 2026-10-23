import { describe, expect, it, vi } from "vitest";
import { SaleRetentionError, runSaleRetention } from "./sale-retention";

type QueueItem = { id: string; bucket: string; object_path: string };
const DEFAULT_QUEUE: QueueItem[] = [
  { id: "job", bucket: "information-agent-evidence", object_path: "sale/file.pdf" },
];

function clientFor(removeError: string | null = null, queue: QueueItem[] = DEFAULT_QUEUE) {
  const rpc = vi.fn(
    async (
      name: string,
    ): Promise<{
      data: number | { deleted: number; remaining: number | null; busy: boolean } | null;
      error: { message: string } | null;
    }> =>
      name === "enqueue_orphan_information_agent_portal_uploads"
        ? { data: 1, error: null }
        : { data: { deleted: 1, remaining: 0, busy: false }, error: null },
  );
  const ack = vi.fn().mockResolvedValue({ error: null, data: null });
  const remove = vi
    .fn()
    .mockResolvedValue({ error: removeError ? { message: removeError } : null, data: [] });
  const client = {
    rpc,
    from: vi.fn(() => ({
      select: () => ({
        order: () => ({
          limit: async () => ({ error: null, data: queue }),
        }),
      }),
      delete: () => ({ in: ack }),
    })),
    storage: { from: vi.fn(() => ({ remove })) },
  };
  return { client, rpc, ack, remove };
}
describe("sale retention", () => {
  it("removes storage then acknowledges durable work", async () => {
    const { client, rpc, ack, remove } = clientFor();
    expect(await runSaleRetention(new Date("2026-09-11T12:00:00Z"), client)).toMatchObject({
      deleted: 1,
      busy: false,
      purgeStatus: "completed",
      orphanUploadsQueued: 1,
      filesDeleted: 1,
    });
    expect(rpc).toHaveBeenCalledWith("enqueue_orphan_information_agent_portal_uploads", {
      p_now: "2026-09-11T12:00:00.000Z",
      p_limit: 100,
    });
    expect(remove).toHaveBeenCalledWith(["sale/file.pdf"]);
    expect(ack).toHaveBeenCalledWith("id", ["job"]);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]);
  });
  it("groups removals by bucket and acknowledges all objects with a single delete", async () => {
    const { client, ack, remove } = clientFor(null, [
      { id: "a", bucket: "information-agent-evidence", object_path: "sale/a.pdf" },
      { id: "b", bucket: "information-agent-approved", object_path: "sale/b.pdf" },
      { id: "c", bucket: "information-agent-evidence", object_path: "sale/c.pdf" },
    ]);
    expect(await runSaleRetention(new Date(), client)).toMatchObject({ filesDeleted: 3 });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenNthCalledWith(1, ["sale/a.pdf", "sale/c.pdf"]);
    expect(remove).toHaveBeenNthCalledWith(2, ["sale/b.pdf"]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith("id", ["a", "c", "b"]);
  });
  it("removes mirrored sale photos, a narrow original's single file included", async () => {
    const { client, ack, remove } = clientFor(null, [
      { id: "p1", bucket: "sale-photos", object_path: "sale/0123456789abcdef-640.webp" },
      { id: "p2", bucket: "sale-photos", object_path: "sale/0123456789abcdef-1600.webp" },
    ]);
    expect(await runSaleRetention(new Date(), client)).toMatchObject({ filesDeleted: 2 });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([
      "sale/0123456789abcdef-640.webp",
      "sale/0123456789abcdef-1600.webp",
    ]);
    expect(ack).toHaveBeenCalledWith("id", ["p1", "p2"]);
  });
  it("acknowledges buckets already removed when a later bucket fails", async () => {
    const { client, ack, remove } = clientFor(null, [
      { id: "a", bucket: "information-agent-evidence", object_path: "sale/a.pdf" },
      { id: "b", bucket: "information-agent-approved", object_path: "sale/b.pdf" },
    ]);
    remove
      .mockResolvedValueOnce({ error: null, data: [] })
      .mockResolvedValueOnce({ error: { message: "second bucket down" }, data: null });
    await expect(runSaleRetention(new Date(), client)).rejects.toThrow("second bucket down");
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith("id", ["a"]);
  });
  it("rejects an unexpected bucket without touching storage or the queue", async () => {
    const { client, ack, remove } = clientFor(null, [
      { id: "x", bucket: "public-assets", object_path: "sale/x.pdf" },
    ]);
    await expect(runSaleRetention(new Date(), client)).rejects.toThrow(
      "Unexpected retention bucket",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });
  it("keeps retry work when storage fails", async () => {
    const { client, ack } = clientFor("unavailable");
    await expect(runSaleRetention(new Date(), client)).rejects.toThrow("unavailable");
    expect(ack).not.toHaveBeenCalled();
  });
  it("a failing sale purge no longer stops the orphan queue nor the Storage drain", async () => {
    const { client, rpc, ack, remove } = clientFor();
    rpc.mockResolvedValueOnce({ data: null, error: { message: "bridge failed" } });
    const error = await runSaleRetention(new Date(), client).catch((caught) => caught);
    // The job fails, with the step and its message...
    expect(error).toBeInstanceOf(SaleRetentionError);
    expect(error.message).toContain("purge: bridge failed");
    expect(error.failures).toEqual([{ step: "purge", message: "bridge failed" }]);
    // ... but the other two steps ran to the end.
    expect(rpc).toHaveBeenCalledWith("enqueue_orphan_information_agent_portal_uploads", {
      p_now: expect.any(String),
      p_limit: 100,
    });
    expect(remove).toHaveBeenCalledWith(["sale/file.pdf"]);
    expect(ack).toHaveBeenCalledWith("id", ["job"]);
    expect(error.summary).toMatchObject({ orphanUploadsQueued: 1, filesDeleted: 1 });
  });
  it("reports the orphan step error and still drains the Storage queue", async () => {
    const { client, rpc, remove } = clientFor();
    rpc.mockImplementation(async (name: string) =>
      name === "enqueue_orphan_information_agent_portal_uploads"
        ? { data: null, error: { message: "orphans unavailable" } }
        : { data: { deleted: 2, remaining: 0, busy: false }, error: null },
    );
    const error = await runSaleRetention(new Date(), client).catch((caught) => caught);
    expect(error.failures).toEqual([{ step: "orphans", message: "orphans unavailable" }]);
    expect(error.summary).toMatchObject({ deleted: 2, filesDeleted: 1 });
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("reports every failing step together", async () => {
    const { client, rpc } = clientFor("storage down");
    rpc.mockImplementation(async (name: string) =>
      name === "enqueue_orphan_information_agent_portal_uploads"
        ? { data: null, error: { message: "orphans unavailable" } }
        : { data: null, error: { message: "purge down" } },
    );
    const error = await runSaleRetention(new Date(), client).catch((caught) => caught);
    expect(error.failures.map((failure: { step: string }) => failure.step)).toEqual([
      "purge",
      "orphans",
      "storage",
    ]);
    expect(error.message).toContain("purge: purge down");
    expect(error.message).toContain("orphans: orphans unavailable");
    expect(error.message).toContain("storage: storage down");
  });
  it("keeps the purge deletions counted before a later batch fails", async () => {
    const { client, rpc } = clientFor();
    rpc
      .mockResolvedValueOnce({ data: { deleted: 25, remaining: 10, busy: false }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "timeout" } });
    const error = await runSaleRetention(new Date(), client).catch((caught) => caught);
    expect(error.summary).toMatchObject({ deleted: 25, remaining: 10 });
  });
  it("stops on concurrent purge and still drains committed file removals", async () => {
    const { client, rpc } = clientFor();
    rpc.mockResolvedValueOnce({ data: { deleted: 0, remaining: null, busy: true }, error: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runSaleRetention(new Date(), client)).toMatchObject({
      busy: true,
      purgeStatus: "lock_busy",
      filesDeleted: 1,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("purge_lock_busy"));
    warn.mockRestore();
  });
});
