import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("next/cache", () => ({
  // No data cache outside Next.js: every call reaches the mocked database.
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/supabase-public.server", () => ({
  createPublicSupabaseClient: () => ({ rpc: mocks.rpc }),
}));

const ROW = {
  tribunal_code: "pau",
  tribunal_name: "TJ Pau",
  tribunal_city: "Pau",
  department: "64",
  upcoming_count: 7,
  next_sale_date: "2026-10-16T00:00:00Z",
  median_starting_price_eur: "59000",
  house_count: 4,
  apartment_count: 3,
  other_count: 0,
};

describe("loadPublicTribunalActivity", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.rpc.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the courts read from the database", async () => {
    mocks.rpc.mockResolvedValue({ data: [ROW], error: null });
    const { loadPublicTribunalActivity } = await import("./public-tribunal-activity.server");

    const result = await loadPublicTribunalActivity(1_000);

    expect(result.status).toBe("ok");
    const items = result.status === "ok" ? result.items : [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ code: "pau", upcomingCount: 7 });
  });

  it("tells an empty list from a failed read", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const { loadPublicTribunalActivity } = await import("./public-tribunal-activity.server");
    expect(await loadPublicTribunalActivity(1_000)).toEqual({ status: "ok", items: [] });

    vi.resetModules();
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("database down") });
    const failing = await import("./public-tribunal-activity.server");
    expect(await failing.loadPublicTribunalActivity(1_000)).toEqual({ status: "error" });
  });

  it("remembers a failure for a few minutes instead of asking the database again", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("function does not exist") });
    const { loadPublicTribunalActivity, PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS } =
      await import("./public-tribunal-activity.server");

    expect(await loadPublicTribunalActivity(10_000)).toEqual({ status: "error" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    // Inside the window: no new call.
    expect(await loadPublicTribunalActivity(10_000 + 60_000)).toEqual({ status: "error" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    // After the window the database is asked again, and a success clears the memory.
    mocks.rpc.mockResolvedValue({ data: [ROW], error: null });
    const recovered = await loadPublicTribunalActivity(
      10_000 + PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS,
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(recovered.status).toBe("ok");
    expect(recovered.status === "ok" ? recovered.items : []).toHaveLength(1);
  });
});
