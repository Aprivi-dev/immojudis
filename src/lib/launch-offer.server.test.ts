import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), getUserById: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc, auth: { admin: { getUserById: mocks.getUserById } } },
}));

import {
  hasActiveSignupTrial,
  isLaunchOfferActive,
  readLaunchOfferState,
  readSignupTrial,
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

describe("essai gratuit du compte (7 jours après la confirmation, une fois par personne)", () => {
  const DAY = 24 * 60 * 60_000;
  const now = Date.parse("2026-10-25T10:00:00.000Z");
  const inTrial = new Date(now + 3 * DAY).toISOString();
  const ended = new Date(now - DAY).toISOString();
  const missing = (name: string, code = "PGRST202") => ({
    data: null,
    error: { code, message: `Could not find the function ${name}` },
  });
  const ok = (data: unknown) => ({ data, error: null });
  const calls = (name: string) => mocks.rpc.mock.calls.filter(([called]) => called === name);

  /** Réponse de `get_signup_trial` : la fin de l'essai et « l'essai est ouvert pour ce compte ». */
  const database = (endsAt: string | null, gateOpen = true) =>
    mocks.rpc.mockImplementation(async () => ok([{ ends_at: endsAt, gate_open: gateOpen }]));

  beforeEach(() => {
    resetLaunchOfferCache();
    mocks.rpc.mockReset();
    mocks.getUserById.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("lit la fin de l'essai dans la base (RPC), sans interroger l'API Auth d'administration", async () => {
    database(inTrial);
    await expect(readSignupTrial("user-1", now)).resolves.toEqual({
      active: true,
      endsAt: inTrial,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("get_signup_trial", { p_user_id: "user-1" });
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });

  it("garde la date d'un essai terminé, sans l'ouvrir", async () => {
    database(ended);
    await expect(readSignupTrial("user-1", now)).resolves.toEqual({ active: false, endsAt: ended });
    await expect(hasActiveSignupTrial("user-2", now)).resolves.toBe(false);
  });

  it("distingue un refus explicite de la base d'une réponse illisible", async () => {
    // La base a répondu « pas d'essai pour ce compte » : refus explicite, à la différence d'une erreur.
    database(null);
    await expect(readSignupTrial("user-1", now)).resolves.toEqual({
      active: false,
      endsAt: null,
      denied: true,
    });
    // Aucune ligne : rien n'est ouvert, et rien n'est affirmé non plus.
    mocks.rpc.mockImplementation(async () => ok([]));
    await expect(readSignupTrial("user-2", now)).resolves.toEqual({ active: false, endsAt: null });
  });

  it("couper l'interrupteur ne ferme que les nouveaux essais", async () => {
    // Confirmé avant la coupure : la base garde l'essai ouvert.
    database(inTrial, true);
    await expect(readSignupTrial("running", now)).resolves.toEqual({
      active: true,
      endsAt: inTrial,
    });
    // Confirmé après la coupure : pas d'essai, et pas de « refus » non plus (rien à dire au compte).
    database(inTrial, false);
    await expect(readSignupTrial("late", now)).resolves.toEqual({ active: false, endsAt: null });
    await expect(hasActiveSignupTrial("late", now)).resolves.toBe(false);
    expect(calls("get_launch_offer_status")).toHaveLength(0);
  });

  it("ne garde que 30 s une lecture « essai fermé pour ce compte » : rétablir l'essai se voit vite", async () => {
    database(inTrial, false);
    await expect(hasActiveSignupTrial("late", now)).resolves.toBe(false);
    database(inTrial, true);
    await expect(hasActiveSignupTrial("late", now + 29_000)).resolves.toBe(false);
    await expect(hasActiveSignupTrial("late", now + 31_000)).resolves.toBe(true);
  });

  it("ferme l'essai à l'heure dite, même si la lecture est encore gardée", async () => {
    database(new Date(now + 5 * 60_000).toISOString());
    await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(true);
    await expect(hasActiveSignupTrial("user-1", now + 6 * 60_000)).resolves.toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("garde un compte sans essai 30 s (cache négatif), puis relit : il peut confirmer à tout moment", async () => {
    database(null);
    await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(false);
    await expect(hasActiveSignupTrial("user-1", now + 29_000)).resolves.toBe(false);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    // Le compte confirme : l'essai s'ouvre à la lecture qui suit l'expiration du cache négatif.
    database(inTrial);
    await expect(hasActiveSignupTrial("user-1", now + 31_000)).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("garde une date de fin 10 minutes, puis la relit", async () => {
    database(inTrial);
    await readSignupTrial("user-1", now);
    await expect(hasActiveSignupTrial("user-1", now + 9 * 60_000)).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await readSignupTrial("user-1", now + 11 * 60_000);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("reste fermé si la base ne répond pas, sans mémoriser l'échec", async () => {
    mocks.rpc.mockImplementation(async () => ({
      data: null,
      error: { code: "XX000", message: "base indisponible" },
    }));
    await expect(readSignupTrial("user-1", now)).resolves.toEqual({ active: false, endsAt: null });
    mocks.rpc.mockRejectedValueOnce(new Error("réseau"));
    await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(false);
    database(inTrial);
    await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(true);
  });

  describe("ordre de déploiement : les migrations de l'essai ne sont pas encore appliquées", () => {
    const authUser = (confirmedAt: string | null) =>
      mocks.getUserById.mockResolvedValue({
        data: { user: { id: "user-1", email_confirmed_at: confirmedAt } },
        error: null,
      });
    /**
     * Base d'avant 20261108130100 : `get_signup_trial` manque ; l'interrupteur global (`switchOn`)
     * ferme alors tous les essais, et `get_signup_trial_end` donne la date.
     */
    const olderDatabase = ({
      trialEnd,
      eligibility = ok(false),
      switchOn = true,
    }: {
      trialEnd: { data: unknown; error: unknown };
      eligibility?: { data: unknown; error: unknown };
      switchOn?: boolean;
    }) =>
      mocks.rpc.mockImplementation(async (name: string) => {
        if (name === "get_signup_trial") return missing(name);
        if (name === "get_launch_offer_status") return ok(switchOn);
        if (name === "get_signup_trial_end") return trialEnd;
        return eligibility;
      });

    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("lit la fin de l'essai par l'ancienne fonction, avec l'interrupteur global", async () => {
      olderDatabase({ trialEnd: ok(inTrial) });
      await expect(readSignupTrial("user-1", now)).resolves.toEqual({
        active: true,
        endsAt: inTrial,
      });
      resetLaunchOfferCache();
      olderDatabase({ trialEnd: ok(inTrial), switchOn: false });
      await expect(readSignupTrial("user-1", now)).resolves.toEqual({
        active: false,
        endsAt: null,
      });
    });

    it("applique l'interrupteur global à chaque appel, sans le mettre dans le cache du compte", async () => {
      const t = Date.now();
      const farTrial = new Date(t + 3 * DAY).toISOString();
      olderDatabase({ trialEnd: ok(farTrial) });
      await expect(hasActiveSignupTrial("user-1", t)).resolves.toBe(true);
      // 31 s plus tard, l'interrupteur global est coupé : la lecture du compte est gardée, pas l'interrupteur.
      olderDatabase({ trialEnd: ok(farTrial), switchOn: false });
      await expect(hasActiveSignupTrial("user-1", t + 31_000)).resolves.toBe(false);
      expect(calls("get_signup_trial_end")).toHaveLength(1);
    });

    it.each(["PGRST202", "42883"])(
      "lit l'ancienne éligibilité sans durée sur %s, comme la base l'applique encore",
      async (code) => {
        olderDatabase({
          trialEnd: missing("get_signup_trial_end", code),
          eligibility: ok(true),
        });
        await expect(readSignupTrial("user-1", now)).resolves.toEqual({
          active: true,
          endsAt: null,
        });
        expect(mocks.rpc).toHaveBeenCalledWith("get_launch_offer_account_eligibility", {
          p_user_id: "user-1",
        });
      },
    );

    it("n'ouvre rien à un compte que l'ancienne règle refuse", async () => {
      olderDatabase({ trialEnd: missing("get_signup_trial_end"), eligibility: ok(false) });
      await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(false);
    });

    it("revient à l'adresse confirmée (API Auth) quand l'ancienne fonction manque aussi", async () => {
      olderDatabase({
        trialEnd: missing("get_signup_trial_end"),
        eligibility: missing("get_launch_offer_account_eligibility"),
      });
      authUser("2026-10-01T00:00:00Z");
      await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(true);
      expect(mocks.getUserById).toHaveBeenCalledWith("user-1");
      resetLaunchOfferCache();
      authUser(null);
      await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(false);
    });

    it("ne se replie que sur l'absence de la fonction, jamais sur une autre erreur", async () => {
      mocks.rpc.mockImplementation(async (name: string) =>
        name === "get_signup_trial"
          ? { data: null, error: { code: "XX000", message: "boom" } }
          : ok(true),
      );
      await expect(hasActiveSignupTrial("user-1", now)).resolves.toBe(false);
      expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });

    it("garde 10 minutes une éligibilité lue par l'ancienne règle", async () => {
      olderDatabase({ trialEnd: missing("get_signup_trial_end"), eligibility: ok(true) });
      await hasActiveSignupTrial("user-1", now);
      await expect(hasActiveSignupTrial("user-1", now + 9 * 60_000)).resolves.toBe(true);
      expect(calls("get_launch_offer_account_eligibility")).toHaveLength(1);
    });

    it("signale une fois le repli sur l'API Auth, sans donnée personnelle", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      warn.mockClear();
      olderDatabase({
        trialEnd: missing("get_signup_trial_end"),
        eligibility: missing("get_launch_offer_account_eligibility"),
      });
      authUser("2026-10-01T00:00:00Z");
      await hasActiveSignupTrial("user-1", now);
      await hasActiveSignupTrial("user-2", now);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("user-1");
    });
  });

  it("évince la plus ancienne lecture quand la mémoire est pleine, sans tout oublier", async () => {
    database(inTrial);
    for (let index = 0; index < 1_000; index += 1) {
      await hasActiveSignupTrial(`user-${index}`, now);
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(1_000);
    // Une 1 001e entrée chasse la plus ancienne (user-0), pas les autres.
    await hasActiveSignupTrial("user-new", now);
    expect(mocks.rpc).toHaveBeenCalledTimes(1_001);
    await hasActiveSignupTrial("user-999", now);
    await hasActiveSignupTrial("user-1", now);
    expect(mocks.rpc).toHaveBeenCalledTimes(1_001);
    await hasActiveSignupTrial("user-0", now);
    expect(mocks.rpc).toHaveBeenCalledTimes(1_002);
  });
});
