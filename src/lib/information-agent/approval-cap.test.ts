import { beforeEach, describe, expect, it, vi } from "vitest";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from } }));

import {
  adminDailyApprovalCap,
  adminDailyApprovalCapMessage,
  assertAdminDailyApprovalCap,
  DEFAULT_ADMIN_DAILY_APPROVAL_CAP,
} from "@/lib/information-agent/approval-cap";

function countingQuery(count: number | null, error: unknown = null) {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "gte"]) {
    chain[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return name === "gte" ? Promise.resolve({ count, error }) : chain;
    };
  }
  from.mockReturnValue(chain);
  return calls;
}

describe("plafond de validations par administrateur et par jour", () => {
  beforeEach(() => from.mockReset());

  it("vaut 30 par défaut et se règle par INFORMATION_AGENT_ADMIN_DAILY_APPROVAL_CAP", () => {
    expect(adminDailyApprovalCap({})).toBe(DEFAULT_ADMIN_DAILY_APPROVAL_CAP);
    expect(DEFAULT_ADMIN_DAILY_APPROVAL_CAP).toBe(30);
    expect(adminDailyApprovalCap({ INFORMATION_AGENT_ADMIN_DAILY_APPROVAL_CAP: "12" })).toBe(12);
    for (const bad of ["0", "-3", "abc", "1.5", ""]) {
      expect(adminDailyApprovalCap({ INFORMATION_AGENT_ADMIN_DAILY_APPROVAL_CAP: bad })).toBe(30);
    }
  });

  it("compte les validations de l'administrateur depuis minuit à Paris", async () => {
    const calls = countingQuery(3);
    await assertAdminDailyApprovalCap("admin-1", {
      env: {},
      now: new Date("2026-11-02T23:30:00Z"),
    });
    expect(calls).toContainEqual(["eq", ["user_id", "admin-1"]]);
    // 23 h 30 UTC le 2 novembre = 0 h 30 à Paris le 3 : le jour commence le 2 à 23 h UTC.
    expect(calls).toContainEqual(["gte", ["approved_at", "2026-11-02T23:00:00.000Z"]]);
  });

  it("refuse au plafond, accepte en dessous", async () => {
    countingQuery(29);
    await expect(assertAdminDailyApprovalCap("admin-1", { env: {} })).resolves.toBeUndefined();
    countingQuery(30);
    await expect(assertAdminDailyApprovalCap("admin-1", { env: {} })).rejects.toThrow(
      adminDailyApprovalCapMessage(30),
    );
    countingQuery(5);
    await expect(
      assertAdminDailyApprovalCap("admin-1", {
        env: { INFORMATION_AGENT_ADMIN_DAILY_APPROVAL_CAP: "5" },
      }),
    ).rejects.toThrow("Plafond de 5 validations");
  });

  it("remonte une erreur de lecture : jamais d'envoi sans compteur", async () => {
    countingQuery(null, new Error("base"));
    await expect(assertAdminDailyApprovalCap("admin-1", { env: {} })).rejects.toThrow("base");
  });
});
