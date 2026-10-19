import { describe, expect, it } from "vitest";
import { readPagedRows } from "./paged-read";

/** The reference: pages read one after the other until a short page or the limit. */
async function readInSeries<T>(
  pageSize: number,
  maxRows: number,
  readPage: (offset: number) => Promise<T[]>,
) {
  const rows: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await readPage(offset);
    rows.push(...page);
    if (page.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function dataset(size: number) {
  const all = Array.from({ length: size }, (_, index) => `row-${index}`);
  let inFlight = 0;
  let peak = 0;
  const offsets: number[] = [];
  const readPage = (pageSize: number) => async (offset: number) => {
    offsets.push(offset);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // Later pages answer faster: a wrong assembly order would show.
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, 12 - offset / pageSize)));
    inFlight -= 1;
    return all.slice(offset, offset + pageSize);
  };
  return { all, readPage, offsets, peak: () => peak };
}

describe("readPagedRows", () => {
  it.each([0, 1, 99, 100, 101, 250, 1753, 4000, 9899, 9900, 9999, 10000, 10001, 12345])(
    "returns the rows and the cut flag of a series read for %i rows, whatever the total says",
    async (size) => {
      const reference = await readInSeries(100, 10_000, dataset(size).readPage(100));
      const totals: (number | "unknown" | "fails")[] = [
        size,
        Math.max(0, size - 250), // too low
        size + 700, // too high
        0,
        "unknown",
        "fails",
      ];
      for (const total of totals) {
        const source = dataset(size);
        const result = await readPagedRows({
          pageSize: 100,
          maxRows: 10_000,
          readPage: source.readPage(100),
          countTotal:
            total === "unknown"
              ? undefined
              : total === "fails"
                ? () => Promise.reject(new Error("count unavailable"))
                : () => Promise.resolve(total),
        });
        expect(result.rows, `${size} rows, total ${total}`).toEqual(reference.rows);
        expect(result.truncated, `${size} rows, total ${total}`).toBe(reference.truncated);
        // Never more than four pages at a time, and never the same page twice.
        expect(source.peak()).toBeLessThanOrEqual(4);
        expect(new Set(source.offsets).size).toBe(source.offsets.length);
      }
    },
  );

  it("cuts a 1 000-row paging at 10 000 rows", async () => {
    const source = dataset(25_000);
    const result = await readPagedRows({
      pageSize: 1000,
      maxRows: 10_000,
      readPage: source.readPage(1000),
      countTotal: async () => 25_000,
    });
    expect(result.rows).toEqual(source.all.slice(0, 10_000));
    expect(result.truncated).toBe(true);
    expect(source.offsets).toHaveLength(10);
  });

  it("reads a short result in a single round trip, without a second page", async () => {
    const source = dataset(60);
    const result = await readPagedRows({
      pageSize: 100,
      maxRows: 10_000,
      readPage: source.readPage(100),
      countTotal: async () => 60,
    });
    expect(result.rows).toEqual(source.all);
    expect(source.offsets).toEqual([0]);
  });

  it("starts the first page and the total together, then reads the rest in parallel", async () => {
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    const gate = (name: string) =>
      new Promise<void>((resolve) => {
        started.push(name);
        release[name] = resolve;
      });
    const all = Array.from({ length: 900 }, (_, index) => index);
    const read = readPagedRows({
      pageSize: 100,
      maxRows: 10_000,
      concurrency: 4,
      countTotal: async () => {
        await gate("count");
        return 900;
      },
      readPage: async (offset) => {
        await gate(`page-${offset}`);
        return all.slice(offset, offset + 100);
      },
    });

    await Promise.resolve();
    expect(started).toEqual(["page-0", "count"]);
    release["page-0"]();
    release["count"]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 8 pages left, 4 at a time.
    expect(started.slice(2)).toEqual(["page-100", "page-200", "page-300", "page-400"]);
    release["page-100"]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(7);
    for (const name of Object.keys(release)) release[name]();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const name of Object.keys(release)) release[name]();
    }
    expect((await read).rows).toEqual(all);
  });

  it("stops reading once a short page is seen and drops the pages after it", async () => {
    // The total claims 1 000 rows but only 250 exist.
    const source = dataset(250);
    const result = await readPagedRows({
      pageSize: 100,
      maxRows: 10_000,
      readPage: source.readPage(100),
      countTotal: async () => 1000,
      concurrency: 2,
    });
    expect(result.rows).toEqual(source.all);
    expect(result.truncated).toBe(false);
    expect(Math.max(...source.offsets)).toBeLessThan(600);
  });

  it("rejects with the first error and starts no further page", async () => {
    const offsets: number[] = [];
    const failure = new Error("page 2 failed");
    await expect(
      readPagedRows({
        pageSize: 100,
        maxRows: 10_000,
        concurrency: 1,
        countTotal: async () => 1000,
        readPage: async (offset) => {
          offsets.push(offset);
          if (offset === 200) throw failure;
          return Array.from({ length: 100 }, () => offset);
        },
      }),
    ).rejects.toBe(failure);
    expect(offsets).toEqual([0, 100, 200]);
  });

  it("rejects when the first page fails, even if the total is still pending", async () => {
    const failure = new Error("first page failed");
    await expect(
      readPagedRows({
        pageSize: 100,
        maxRows: 10_000,
        countTotal: () => new Promise<number>(() => undefined),
        readPage: () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
  });
});
