import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));

import { claimCronLease, releaseCronLease } from "./cron-lease.server";

beforeEach(() => {
  mocks.rpc.mockReset();
});

describe("claimCronLease", () => {
  it("prend le bail nommé et rend son jeton", async () => {
    mocks.rpc.mockResolvedValue({ data: "token-1", error: null });

    expect(await claimCronLease("sale-pepites", 360)).toEqual({ kind: "held", token: "token-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_cron_lease", {
      p_name: "sale-pepites",
      p_ttl_seconds: 360,
    });
  });

  it("bail tenu par une autre passe : « busy »", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await claimCronLease("sale-pepites", 360)).toEqual({ kind: "busy" });
  });

  it.each(["PGRST202", "42883", "PGRST205", "42P01"])(
    "fonction absente (%s) : « unavailable », le traitement continue sans verrou",
    async (code) => {
      mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "absente" } });
      expect(await claimCronLease("sale-pepites", 360)).toEqual({ kind: "unavailable" });
    },
  );

  it("une autre erreur lève, avec le code seul", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "secret détail" } });
    await expect(claimCronLease("sale-pepites", 360)).rejects.toThrow(
      "Bail sale-pepites refusé (code XX000)",
    );
  });
});

describe("releaseCronLease", () => {
  it("rend le bail avec son nom et son jeton", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    await releaseCronLease("sale-pepites", "token-1");
    expect(mocks.rpc).toHaveBeenCalledWith("release_cron_lease", {
      p_name: "sale-pepites",
      p_token: "token-1",
    });
  });

  it("ne fait jamais échouer la passe", async () => {
    mocks.rpc.mockRejectedValue(new Error("réseau coupé"));
    await expect(releaseCronLease("sale-pepites", "token-1")).resolves.toBeUndefined();
  });
});
