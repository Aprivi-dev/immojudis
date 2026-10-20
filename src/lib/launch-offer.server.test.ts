import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  hasConfirmedEmail,
  isLaunchOfferActive,
  readLaunchOfferState,
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

  it("signale une valeur issue d'une erreur, et pas une valeur lue dans la base", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error("base indisponible") });
    const start = Date.now();
    await expect(readLaunchOfferState(start)).resolves.toEqual({ active: false, degraded: true });
    // Pendant les 5 s de retente, la valeur d'erreur reste signalée.
    await expect(readLaunchOfferState(start + 1_000)).resolves.toEqual({
      active: false,
      degraded: true,
    });
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(readLaunchOfferState(start + 6_000)).resolves.toEqual({
      active: false,
      degraded: false,
    });
  });

  it("une lecture déjà en vol n'écrase pas la valeur qui suit un reset", async () => {
    let releaseOld: (value: { data: boolean; error: null }) => void = () => undefined;
    mocks.rpc.mockReturnValueOnce(new Promise((resolve) => (releaseOld = resolve)));
    const oldRead = isLaunchOfferActive();
    // L'administrateur coupe l'offre : la lecture suivante voit la nouvelle valeur.
    resetLaunchOfferCache();
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(isLaunchOfferActive()).resolves.toBe(false);
    // La vieille lecture se termine après coup, avec l'ancienne valeur.
    releaseOld({ data: true, error: null });
    await expect(oldRead).resolves.toBe(true);
    // Elle n'a rien écrit dans le cache : pas de nouvel appel, et la valeur reste `false`.
    await expect(isLaunchOfferActive()).resolves.toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
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

describe("éligibilité du compte à l'offre de lancement (email confirmé, adresse canonique)", () => {
  const eligible = { data: true, error: null };
  const notEligible = { data: false, error: null };

  beforeEach(() => {
    resetLaunchOfferCache();
    mocks.rpc.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("lit la règle de la base (RPC), sans interroger l'API Auth d'administration", async () => {
    mocks.rpc.mockResolvedValue(eligible);
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("get_launch_offer_account_eligibility", {
      p_user_id: "user-1",
    });
  });

  it("ne traite que `true` comme une éligibilité", async () => {
    mocks.rpc.mockResolvedValue({ data: "true", error: null });
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(false);
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(hasConfirmedEmail("user-2")).resolves.toBe(false);
  });

  it("garde un refus 30 s (cache négatif), puis relit : le compte peut confirmer à tout moment", async () => {
    mocks.rpc.mockResolvedValue(notEligible);
    const start = Date.now();
    await expect(hasConfirmedEmail("user-1", start)).resolves.toBe(false);
    await expect(hasConfirmedEmail("user-1", start + 29_000)).resolves.toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    // Le compte confirme : l'offre s'ouvre à la lecture qui suit l'expiration du cache négatif.
    mocks.rpc.mockResolvedValue(eligible);
    await expect(hasConfirmedEmail("user-1", start + 31_000)).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("garde une éligibilité 10 minutes, puis la relit", async () => {
    mocks.rpc.mockResolvedValue(eligible);
    const start = Date.now();
    await hasConfirmedEmail("user-1", start);
    await expect(hasConfirmedEmail("user-1", start + 9 * 60_000)).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await hasConfirmedEmail("user-1", start + 11 * 60_000);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("reste fermé si la base ne répond pas, sans mémoriser l'échec", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: new Error("base indisponible") });
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(false);
    mocks.rpc.mockRejectedValueOnce(new Error("réseau"));
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(false);
    mocks.rpc.mockResolvedValue(eligible);
    await expect(hasConfirmedEmail("user-1")).resolves.toBe(true);
  });

  it("évince la plus ancienne lecture quand la mémoire est pleine, sans tout oublier", async () => {
    mocks.rpc.mockResolvedValue(eligible);
    const start = Date.now();
    for (let index = 0; index < 1_000; index += 1) {
      await hasConfirmedEmail(`user-${index}`, start);
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(1_000);
    // Une 1 001e entrée chasse la plus ancienne (user-0), pas les autres.
    await hasConfirmedEmail("user-new", start);
    expect(mocks.rpc).toHaveBeenCalledTimes(1_001);
    await hasConfirmedEmail("user-999", start);
    await hasConfirmedEmail("user-1", start);
    expect(mocks.rpc).toHaveBeenCalledTimes(1_001);
    await hasConfirmedEmail("user-0", start);
    expect(mocks.rpc).toHaveBeenCalledTimes(1_002);
  });
});
