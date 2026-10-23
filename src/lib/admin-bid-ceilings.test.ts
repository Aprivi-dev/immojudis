import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  getAdminBidCeilings,
  parseBidCeilings,
  unavailableBidCeilings,
} from "./admin-bid-ceilings";

const raw = {
  generated_at: "2026-11-10T12:00:00Z",
  windows: [
    { days: 7, accounts: 12, sales: 9, occurrences: 40 },
    { days: 30, accounts: 31, sales: 22, occurrences: 140 },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("parseBidCeilings", () => {
  it("reads the 7 and 30 day windows", () => {
    expect(parseBidCeilings(raw)).toEqual({
      generatedAt: "2026-11-10T12:00:00Z",
      windows: [
        { days: 7, accounts: 12, sales: 9, occurrences: 40 },
        { days: 30, accounts: 31, sales: 22, occurrences: 140 },
      ],
    });
  });

  it("keeps zero as zero and anything missing as « non mesuré »", () => {
    const parsed = parseBidCeilings({
      windows: [{ days: 7, accounts: 0, sales: 0, occurrences: 0 }],
    });
    expect(parsed.windows[0]).toEqual({ days: 7, accounts: 0, sales: 0, occurrences: 0 });
    expect(parsed.windows[1]).toEqual({ days: 30, accounts: null, sales: null, occurrences: null });
  });

  it("rejects a malformed answer", () => {
    expect(() => parseBidCeilings({ windows: "x" })).toThrow();
  });
});

describe("getAdminBidCeilings", () => {
  it("refuses a non-administrator without reading anything", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false });
    await expect(getAdminBidCeilings("token")).rejects.toThrow(/accès administrateur/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reads the indicator with the service client", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: raw, error: null });
    const now = new Date("2026-11-10T12:00:00Z");

    const result = await getAdminBidCeilings("token", now);

    expect(mocks.requireAuth).toHaveBeenCalledWith("token");
    expect(mocks.rpc).toHaveBeenCalledWith("admin_pilotage_bid_ceilings", {
      p_now: "2026-11-10T12:00:00.000Z",
    });
    expect(result.windows[0]?.accounts).toBe(12);
  });

  it("says « non mesuré » while the migration is not applied", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect(await getAdminBidCeilings("token")).toEqual(unavailableBidCeilings());
  });

  it("lets another database error through", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("boom") });
    await expect(getAdminBidCeilings("token")).rejects.toThrow("boom");
  });
});
