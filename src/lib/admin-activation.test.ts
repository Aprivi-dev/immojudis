import { AdminRequiredError } from "@/lib/api-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  getAdminActivation,
  parseActivationWindows,
  parseUnlockThreshold,
  unavailableActivation,
} from "./admin-activation";

const activationRaw = {
  generated_at: "2026-11-10T12:00:00Z",
  windows: [
    {
      days: 7,
      signups: 20,
      confirmed: 16,
      activated: 9,
      opened_detail: 6,
      added_favorite: 4,
      created_alert: 3,
    },
    {
      days: 30,
      signups: 80,
      confirmed: 61,
      activated: 33,
      opened_detail: 25,
      added_favorite: 14,
      created_alert: 10,
    },
  ],
};

const thresholdRaw = {
  generated_at: "2026-11-10T12:00:00Z",
  discovery_accounts: 120,
  months: [
    { month_start: "2026-10-31T23:00:00Z", partial: true, unlocked_one: 18, reached_three: 6 },
    { month_start: "2026-09-30T22:00:00Z", partial: false, unlocked_one: 30, reached_three: 11 },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("parseActivationWindows", () => {
  it("reads the 7 and 30 day windows", () => {
    expect(parseActivationWindows(activationRaw).windows).toEqual([
      {
        days: 7,
        signups: 20,
        confirmed: 16,
        activated: 9,
        openedDetail: 6,
        addedFavorite: 4,
        createdAlert: 3,
      },
      {
        days: 30,
        signups: 80,
        confirmed: 61,
        activated: 33,
        openedDetail: 25,
        addedFavorite: 14,
        createdAlert: 10,
      },
    ]);
  });

  it("keeps zero as zero and a missing window as « non mesuré »", () => {
    const parsed = parseActivationWindows({
      windows: [{ days: 7, signups: 0, activated: 0 }],
    });
    expect(parsed.windows[0]).toMatchObject({ days: 7, signups: 0, activated: 0, confirmed: null });
    expect(parsed.windows[1]).toMatchObject({ days: 30, signups: null, activated: null });
  });

  it("rejects a malformed answer", () => {
    expect(() => parseActivationWindows({ windows: "x" })).toThrow();
  });
});

describe("parseUnlockThreshold", () => {
  it("reads the current month then the previous one", () => {
    expect(parseUnlockThreshold(thresholdRaw)).toEqual({
      discoveryAccounts: 120,
      months: [
        { monthStart: "2026-10-31T23:00:00Z", partial: true, unlockedOne: 18, reachedThree: 6 },
        { monthStart: "2026-09-30T22:00:00Z", partial: false, unlockedOne: 30, reachedThree: 11 },
      ],
    });
  });

  it("says « non mesuré » for a month the database did not answer", () => {
    const parsed = parseUnlockThreshold({ discovery_accounts: 0, months: [] });
    expect(parsed.discoveryAccounts).toBe(0);
    expect(parsed.months[0]).toEqual({
      monthStart: null,
      partial: true,
      unlockedOne: null,
      reachedThree: null,
    });
    expect(parsed.months[1].partial).toBe(false);
  });
});

describe("getAdminActivation", () => {
  it("refuses a non-administrator without reading anything", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false });
    await expect(getAdminActivation("token")).rejects.toThrow(AdminRequiredError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reads both indicators with the service client", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "admin_pilotage_activation" ? activationRaw : thresholdRaw,
      error: null,
    }));
    const now = new Date("2026-11-10T12:00:00Z");
    const result = await getAdminActivation("token", now);
    expect(mocks.rpc).toHaveBeenCalledWith("admin_pilotage_activation", {
      p_now: now.toISOString(),
    });
    expect(mocks.rpc).toHaveBeenCalledWith("admin_pilotage_unlock_threshold", {
      p_now: now.toISOString(),
    });
    expect(result.windows[0].activated).toBe(9);
    expect(result.unlockThreshold.months[0].reachedThree).toBe(6);
  });

  it("says « non mesuré » while the migration is not applied", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    expect(await getAdminActivation("token")).toEqual(unavailableActivation());
  });

  it("keeps one indicator when the other is missing, and rethrows any other failure", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true });
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "admin_pilotage_activation"
        ? { data: activationRaw, error: null }
        : { data: null, error: { code: "42883" } },
    );
    const partial = await getAdminActivation("token");
    expect(partial.windows[1].activated).toBe(33);
    expect(partial.unlockThreshold.discoveryAccounts).toBeNull();

    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(getAdminActivation("token")).rejects.toMatchObject({ code: "XX000" });
  });
});
