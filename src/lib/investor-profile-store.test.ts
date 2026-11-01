import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import {
  deleteInvestorProfile,
  getInvestorProfile,
  saveInvestorProfile,
} from "./investor-profile-store";

const row = {
  down_payment_eur: 40_000,
  target_margin_pct: 15,
  works_per_m2_eur: 800,
  strategy: "revendre",
};

let calls: Array<[string, unknown[]]> = [];
let results: Array<{ data: unknown; error: unknown }> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => {
      calls.push(["from", args]);
      return builder();
    },
  },
}));

function builder() {
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "update", "insert", "delete", "eq"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  const next = () => Promise.resolve(results.shift() ?? { data: null, error: null });
  builder.maybeSingle = next;
  builder.single = next;
  return builder;
}

function auth(): SupabaseAuthContext {
  return { userId: "user-1" } as unknown as SupabaseAuthContext;
}

beforeEach(() => {
  calls = [];
  results = [];
});

describe("getInvestorProfile", () => {
  it("lit le profil du compte seulement, avec le rôle de service filtré sur son identifiant", async () => {
    results = [{ data: row, error: null }];
    const response = await getInvestorProfile({ auth: auth() });
    expect(response.profile).toEqual({
      downPaymentEur: 40_000,
      targetMarginPct: 15,
      worksPerM2Eur: 800,
      strategy: "revendre",
    });
    expect(calls).toContainEqual(["from", ["user_investor_profiles"]]);
    expect(calls).toContainEqual(["eq", ["user_id", "user-1"]]);
  });

  it("rend null sans profil, et remonte une erreur de la base", async () => {
    results = [{ data: null, error: null }];
    expect((await getInvestorProfile({ auth: auth() })).profile).toBeNull();
    results = [{ data: null, error: new Error("boom") }];
    await expect(getInvestorProfile({ auth: auth() })).rejects.toThrow("boom");
  });
});

describe("saveInvestorProfile", () => {
  const input = {
    downPaymentEur: 40_000,
    targetMarginPct: 15,
    worksPerM2Eur: null,
    strategy: "revendre" as const,
  };

  it("met à jour la ligne du compte quand elle existe, sans jamais réécrire user_id", async () => {
    results = [{ data: row, error: null }];
    const response = await saveInvestorProfile({ auth: auth(), input });
    expect(response.profile?.strategy).toBe("revendre");
    const update = calls.find(([name]) => name === "update");
    expect(update?.[1]).toEqual([
      {
        down_payment_eur: 40_000,
        target_margin_pct: 15,
        works_per_m2_eur: null,
        strategy: "revendre",
      },
    ]);
    expect(calls.some(([name]) => name === "insert")).toBe(false);
  });

  it("crée la ligne du compte quand elle n'existe pas encore", async () => {
    results = [
      { data: null, error: null },
      { data: row, error: null },
    ];
    await saveInvestorProfile({ auth: auth(), input });
    const insert = calls.find(([name]) => name === "insert");
    expect(insert?.[1][0]).toMatchObject({ user_id: "user-1", strategy: "revendre" });
  });

  it("reprend la mise à jour quand un enregistrement simultané a créé la ligne entre-temps", async () => {
    results = [
      { data: null, error: null },
      { data: null, error: { code: "23505", message: "duplicate" } },
      { data: row, error: null },
    ];
    const response = await saveInvestorProfile({ auth: auth(), input });
    expect(response.profile?.downPaymentEur).toBe(40_000);
  });

  it("remonte toute autre erreur", async () => {
    results = [
      { data: null, error: null },
      { data: null, error: { code: "42501", message: "denied" } },
    ];
    await expect(saveInvestorProfile({ auth: auth(), input })).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("deleteInvestorProfile", () => {
  it("efface le profil du compte et dit s'il y en avait un", async () => {
    results = [{ data: { user_id: "user-1" }, error: null }];
    expect(await deleteInvestorProfile({ auth: auth() })).toEqual({ ok: true, removed: true });
    expect(calls).toContainEqual(["eq", ["user_id", "user-1"]]);
    results = [{ data: null, error: null }];
    expect(await deleteInvestorProfile({ auth: auth() })).toEqual({ ok: true, removed: false });
  });
});
