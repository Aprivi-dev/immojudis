import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleUnlockStatus } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforce: vi.fn(),
  getStatus: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/sale-unlocks.server", () => ({
  getSaleUnlockStatus: mocks.getStatus,
  listUnlockedSales: mocks.list,
}));

import { GET } from "./route";

const auth = { userId: "user-1" };
const status: SaleUnlockStatus = {
  saleId: null,
  unlocked: false,
  unlockable: true,
  analysisAccess: false,
  limit: 3,
  used: 2,
  remaining: 1,
  periodStart: "2026-09-30T22:00:00.000Z",
  resetsAt: "2026-10-31T23:00:00.000Z",
};
const get = () => GET(new Request("https://example.test/api/sale-unlocks"));

describe("GET /api/sale-unlocks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.enforce.mockResolvedValue(1);
  });

  it("answers the month so far and the unlocked sales, privately, consuming nothing", async () => {
    const sales = [{ id: "s1", title: "Appartement" }];
    mocks.getStatus.mockResolvedValue(status);
    mocks.list.mockResolvedValue(sales);

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("authorization");
    expect(await response.json()).toEqual({ status, sales });
    // No sale id: the account counter only.
    expect(mocks.getStatus).toHaveBeenCalledWith(auth);
    expect(mocks.list).toHaveBeenCalledWith(auth);
  });

  it("requires a signed-in account before reading anything", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await get();

    expect(response.status).toBe(401);
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("is rate limited per account", async () => {
    mocks.getStatus.mockResolvedValue(status);
    mocks.list.mockResolvedValue([]);

    await get();

    expect(mocks.enforce).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", bucketKey: "sale-unlocks-overview" }),
    );
  });

  it("reports a database failure as an unavailable service, without its detail", async () => {
    mocks.getStatus.mockRejectedValue(new Error("select * from secret"));
    mocks.list.mockResolvedValue([]);

    const response = await get();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
