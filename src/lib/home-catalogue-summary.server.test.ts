import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  loadInitialCatalogue: vi.fn(),
  loadPublicTribunalActivity: vi.fn(),
}));

vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: mocks.createClient,
}));
vi.mock("@/lib/public-catalogue.server", () => ({
  loadInitialCatalogue: mocks.loadInitialCatalogue,
}));
vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: mocks.loadPublicTribunalActivity,
}));

import {
  loadHomeCatalogueSummary,
  loadHomeTribunalCount,
  usableVerifiedAt,
  type HomeCatalogueSummaryDependencies,
} from "@/lib/home-catalogue-summary.server";

import type { PublicTribunalActivity } from "@/lib/public-tribunal-activity";

const NOW = new Date("2026-10-19T12:00:00Z");

const catalogue = (count: number) => async () => ({ signature: "", items: [], count });

function run(dependencies: HomeCatalogueSummaryDependencies) {
  return loadHomeCatalogueSummary({ now: NOW, ...dependencies });
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.createClient.mockReset();
  mocks.loadInitialCatalogue.mockReset();
  mocks.loadPublicTribunalActivity.mockReset();
});

describe("loadHomeCatalogueSummary", () => {
  it("takes the total of /sales and the date of the last successful collection", async () => {
    const summary = await run({
      catalogue: catalogue(1753),
      verifiedAt: async () => "2026-10-19T06:30:00+00:00",
    });

    expect(summary).toEqual({ count: 1753, verifiedAt: "2026-10-19T06:30:00.000Z" });
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

  it("keeps the total alone when the date cannot be read, is missing or does not make sense", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const failing = await run({
      catalogue: catalogue(12),
      verifiedAt: async () => {
        throw new Error("fonction absente");
      },
    });
    const none = await run({ catalogue: catalogue(12), verifiedAt: async () => null });
    const slow = await run({
      catalogue: catalogue(12),
      verifiedAt: () => new Promise(() => undefined),
      timeoutMs: 5,
    });

    expect(failing).toEqual({ count: 12, verifiedAt: null });
    expect(none).toEqual({ count: 12, verifiedAt: null });
    expect(slow).toEqual({ count: 12, verifiedAt: null });
  });

  it("never reads the sales again to date the line", async () => {
    // Only the total of the first page is read; the date comes from one aggregated value.
    mocks.loadInitialCatalogue.mockResolvedValue({ signature: "[]", items: [], count: 1753 });
    const rpc = vi.fn().mockResolvedValue({ data: "2026-10-19T06:30:00+00:00", error: null });
    mocks.createClient.mockReturnValue({ rpc });

    const summary = await loadHomeCatalogueSummary({ now: NOW });

    expect(summary).toEqual({ count: 1753, verifiedAt: "2026-10-19T06:30:00.000Z" });
    expect(mocks.loadInitialCatalogue).toHaveBeenCalledTimes(1);
    expect(mocks.loadInitialCatalogue).toHaveBeenCalledWith({});
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("get_public_catalogue_verified_at");
  });

  it("shows the total alone when the database function is not deployed yet", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.loadInitialCatalogue.mockResolvedValue({ signature: "[]", items: [], count: 40 });
    mocks.createClient.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "PGRST202", message: "Could not find the function" },
      }),
    });

    expect(await loadHomeCatalogueSummary({ now: NOW })).toEqual({ count: 40, verifiedAt: null });
  });

  it("shows the total alone when no collection has succeeded or the database is not configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.loadInitialCatalogue.mockResolvedValue({ signature: "[]", items: [], count: 40 });
    mocks.createClient.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    expect(await loadHomeCatalogueSummary({ now: NOW })).toEqual({ count: 40, verifiedAt: null });

    mocks.createClient.mockReturnValue(null);
    expect(await loadHomeCatalogueSummary({ now: NOW })).toEqual({ count: 40, verifiedAt: null });
  });
});

describe("usableVerifiedAt", () => {
  it("ignores unreadable dates, dates in the future and empty values", () => {
    expect(usableVerifiedAt("pas une date", NOW)).toBeNull();
    expect(usableVerifiedAt("2026-12-31T00:00:00Z", NOW)).toBeNull();
    expect(usableVerifiedAt(null, NOW)).toBeNull();
    expect(usableVerifiedAt(undefined, NOW)).toBeNull();
    expect(usableVerifiedAt("", NOW)).toBeNull();
  });

  it("normalises a readable date and tolerates a small clock gap", () => {
    expect(usableVerifiedAt("2026-10-10T06:00:00+02:00", NOW)).toBe("2026-10-10T04:00:00.000Z");
    expect(usableVerifiedAt("2026-10-20T06:00:00Z", NOW)).toBe("2026-10-20T06:00:00.000Z");
  });
});

describe("loadHomeTribunalCount", () => {
  const court = (upcomingCount: number) => ({ upcomingCount }) as PublicTribunalActivity;

  it("counts the courts of /tribunaux that have at least one upcoming sale", async () => {
    mocks.loadPublicTribunalActivity.mockResolvedValue({
      status: "ok",
      items: [court(12), court(0), court(1)],
    });

    expect(await loadHomeTribunalCount()).toBe(2);
    expect(mocks.loadPublicTribunalActivity).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the list is empty, unavailable, slow or throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      await loadHomeTribunalCount({ activity: async () => ({ status: "ok", items: [court(0)] }) }),
    ).toBeNull();
    expect(await loadHomeTribunalCount({ activity: async () => ({ status: "error" }) })).toBeNull();
    expect(
      await loadHomeTribunalCount({ activity: () => new Promise(() => undefined), timeoutMs: 5 }),
    ).toBeNull();
    expect(
      await loadHomeTribunalCount({
        activity: async () => {
          throw new Error("base indisponible");
        },
      }),
    ).toBeNull();
  });
});
