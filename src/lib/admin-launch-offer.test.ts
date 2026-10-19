import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  adminRpc: vi.fn(),
  userRpc: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.auth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.adminRpc },
}));
vi.mock("@/lib/launch-offer.server", () => ({ resetLaunchOfferCache: mocks.reset }));

import {
  adminLaunchOfferActionSchema,
  getAdminLaunchOffer,
  setAdminLaunchOffer,
} from "@/lib/admin-launch-offer";

const adminAuth = () => ({
  userId: "admin-1",
  isAdmin: true,
  supabase: { rpc: mocks.userRpc },
});

describe("interrupteur admin de l'offre de lancement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  it("n'accepte qu'un état explicite", () => {
    expect(adminLaunchOfferActionSchema.safeParse({ active: false }).success).toBe(true);
    expect(adminLaunchOfferActionSchema.safeParse({}).success).toBe(false);
    expect(adminLaunchOfferActionSchema.safeParse({ active: "non" }).success).toBe(false);
    expect(adminLaunchOfferActionSchema.safeParse({ active: true, extra: 1 }).success).toBe(false);
  });

  it("refuse un compte qui n'est pas administrateur, en lecture comme en écriture", async () => {
    mocks.auth.mockResolvedValue({ ...adminAuth(), isAdmin: false });
    await expect(getAdminLaunchOffer("token")).rejects.toThrow("Forbidden");
    await expect(
      setAdminLaunchOffer({ authToken: "token", input: { active: false } }),
    ).rejects.toThrow("Forbidden");
    expect(mocks.userRpc).not.toHaveBeenCalled();
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });

  it("refuse une session invalide", async () => {
    mocks.auth.mockRejectedValue(new Error("Unauthorized: Invalid token"));
    await expect(getAdminLaunchOffer("bad")).rejects.toThrow("Unauthorized");
  });

  it("lit l'état réel dans la base, sans le cache des pages", async () => {
    mocks.auth.mockResolvedValue(adminAuth());
    mocks.adminRpc.mockResolvedValue({ data: true, error: null });
    await expect(getAdminLaunchOffer("token")).resolves.toEqual({ active: true });
    expect(mocks.adminRpc).toHaveBeenCalledWith("get_launch_offer_status");
  });

  it("coupe l'offre avec le compte de l'administrateur (la base refuse tout autre) et vide le cache", async () => {
    mocks.auth.mockResolvedValue(adminAuth());
    mocks.userRpc.mockResolvedValue({ data: false, error: null });
    await expect(
      setAdminLaunchOffer({ authToken: "token", input: { active: false } }),
    ).resolves.toEqual({ active: false });
    expect(mocks.userRpc).toHaveBeenCalledWith("set_launch_offer", { p_active: false });
    expect(mocks.reset).toHaveBeenCalledTimes(1);
  });

  it("remonte le refus de la base sans vider le cache", async () => {
    mocks.auth.mockResolvedValue(adminAuth());
    mocks.userRpc.mockResolvedValue({ data: null, error: new Error("Admin access required.") });
    await expect(
      setAdminLaunchOffer({ authToken: "token", input: { active: true } }),
    ).rejects.toThrow("Admin access required.");
    expect(mocks.reset).not.toHaveBeenCalled();
  });
});
