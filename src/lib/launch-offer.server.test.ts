import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUserById: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, auth: { admin: { getUserById: mocks.getUserById } } },
}));

import {
  hasConfirmedEmail,
  isLaunchOfferActive,
  resetLaunchOfferCache,
} from "@/lib/launch-offer.server";

describe("état de l'offre de lancement côté serveur", () => {
  beforeEach(() => {
    resetLaunchOfferCache();
    mocks.rpc.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("lit l'état dans la base par le RPC, sans variable d'environnement", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    await expect(isLaunchOfferActive()).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("get_launch_offer_status");
  });

  it("garde la lecture 30 s, puis la relit : une coupure se voit en moins d'une minute", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    const start = Date.now();
    await expect(isLaunchOfferActive(start)).resolves.toBe(true);
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(isLaunchOfferActive(start + 29_000)).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await expect(isLaunchOfferActive(start + 31_000)).resolves.toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("partage une lecture en cours entre appels simultanés", async () => {
    let release: (value: { data: boolean; error: null }) => void = () => undefined;
    mocks.rpc.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const reads = [isLaunchOfferActive(), isLaunchOfferActive(), isLaunchOfferActive()];
    release({ data: true, error: null });
    await expect(Promise.all(reads)).resolves.toEqual([true, true, true]);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("reste fermée si la base ne répond pas, et retente vite", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error("base indisponible") });
    const start = Date.now();
    await expect(isLaunchOfferActive(start)).resolves.toBe(false);
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    await expect(isLaunchOfferActive(start + 1_000)).resolves.toBe(false);
    await expect(isLaunchOfferActive(start + 6_000)).resolves.toBe(true);
  });

  it("ne traite que `true` comme une offre active", async () => {
    mocks.rpc.mockResolvedValue({ data: "true", error: null });
    await expect(isLaunchOfferActive()).resolves.toBe(false);
  });

  it("oublie sa lecture quand on le lui demande (après un changement de l'administrateur)", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    await isLaunchOfferActive();
    resetLaunchOfferCache();
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(isLaunchOfferActive()).resolves.toBe(false);
  });
});

describe("email confirmé exigé par l'offre de lancement", () => {
  const confirmedUser = {
    data: { user: { email_confirmed_at: "2026-10-19T08:00:00Z" } },
    error: null,
  };
  const unconfirmedUser = { data: { user: { email_confirmed_at: null } }, error: null };

  beforeEach(() => {
    resetLaunchOfferCache();
    mocks.getUserById.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("lit email_confirmed_at du compte dans Auth", async () => {
    mocks.getUserById.mockResolvedValue(confirmedUser);
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(true);
    expect(mocks.getUserById).toHaveBeenCalledWith("user-1");
  });

  it("refuse un compte dont l'email n'est pas confirmé, et le relit à chaque fois", async () => {
    mocks.getUserById.mockResolvedValue(unconfirmedUser);
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(false);
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(false);
    expect(mocks.getUserById).toHaveBeenCalledTimes(2);
    // Le compte confirme : l'offre s'ouvre à la lecture suivante.
    mocks.getUserById.mockResolvedValue(confirmedUser);
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(true);
  });

  it("garde une confirmation 10 minutes, puis la relit", async () => {
    mocks.getUserById.mockResolvedValue(confirmedUser);
    const start = Date.now();
    await hasConfirmedEmail("user-1", start);
    await expect(hasConfirmedEmail("user-1", start + 9 * 60_000)).resolves.toBe(true);
    expect(mocks.getUserById).toHaveBeenCalledTimes(1);
    await hasConfirmedEmail("user-1", start + 11 * 60_000);
    expect(mocks.getUserById).toHaveBeenCalledTimes(2);
  });

  it("reste fermé si Auth ne répond pas, sans mémoriser l'échec", async () => {
    mocks.getUserById.mockResolvedValueOnce({ data: null, error: new Error("auth indisponible") });
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(false);
    mocks.getUserById.mockRejectedValueOnce(new Error("réseau"));
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(false);
    mocks.getUserById.mockResolvedValue(confirmedUser);
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(true);
  });
});
