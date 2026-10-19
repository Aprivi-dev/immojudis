import { afterEach, describe, expect, it, vi } from "vitest";
import {
  latestUpdate,
  loadHomeCatalogueSummary,
  type HomeCatalogueSummaryDependencies,
} from "@/lib/home-catalogue-summary.server";

const NOW = new Date("2026-10-15T12:00:00Z");

const catalogue = (count: number) => async () => ({ signature: "", items: [], count });

function run(dependencies: HomeCatalogueSummaryDependencies) {
  return loadHomeCatalogueSummary({ now: NOW, ...dependencies });
}

afterEach(() => vi.restoreAllMocks());

describe("loadHomeCatalogueSummary", () => {
  it("takes the total of /sales and the latest update of the public sales", async () => {
    const summary = await run({
      catalogue: catalogue(1753),
      sales: async () => [
        { id: "a", lastModified: "2026-10-14T08:00:00Z" },
        { id: "b", lastModified: "2026-10-15T07:30:00Z" },
        { id: "c", lastModified: null },
      ],
    });

    expect(summary).toEqual({ count: 1753, updatedAt: "2026-10-15T07:30:00.000Z" });
  });

  it("shows nothing when the catalogue is unavailable or empty, and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await run({ catalogue: async () => null })).toBeNull();
    expect(await run({ catalogue: catalogue(0) })).toBeNull();
    expect(await run({ catalogue: catalogue(Number.NaN) })).toBeNull();
    expect(
      await run({
        catalogue: async () => {
          throw new Error("base indisponible");
        },
      }),
    ).toBeNull();
  });

  it("gives up after the timeout instead of delaying the home page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const summary = await run({
      catalogue: () => new Promise(() => undefined),
      timeoutMs: 5,
    });

    expect(summary).toBeNull();
  });

  it("keeps the total alone when the date cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const failing = await run({
      catalogue: catalogue(12),
      sales: async () => {
        throw new Error("rpc absente");
      },
    });
    const withoutDates = await run({
      catalogue: catalogue(12),
      sales: async () => [{ id: "a", lastModified: null }],
    });

    expect(failing).toEqual({ count: 12, updatedAt: null });
    expect(withoutDates).toEqual({ count: 12, updatedAt: null });
  });
});

describe("latestUpdate", () => {
  it("ignores unreadable dates and dates in the future", () => {
    expect(
      latestUpdate(
        [
          { id: "a", lastModified: "pas une date" },
          { id: "b", lastModified: "2026-12-31T00:00:00Z" },
          { id: "c", lastModified: "2026-10-10T00:00:00Z" },
        ],
        NOW,
      ),
    ).toBe("2026-10-10T00:00:00.000Z");
    expect(latestUpdate([], NOW)).toBeNull();
  });
});
