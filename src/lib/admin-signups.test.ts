import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  listUsers: vi.fn(),
  getUserById: vi.fn(),
  launchOffer: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: { admin: { listUsers: mocks.listUsers, getUserById: mocks.getUserById } },
  },
}));
vi.mock("@/lib/launch-offer.server", () => ({ readLaunchOfferState: mocks.launchOffer }));

import {
  adminSignupListQuerySchema,
  adminTrialExtensionInputSchema,
  extendAdminSignupTrials,
  extensionRefusal,
  listAdminSignups,
  resolveSignupAccess,
  TRIAL_EXTENSION_SOURCE,
} from "@/lib/admin-signups";
import { endOfDayInDays, formatAccountSeniority } from "@/lib/admin-signups-format";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const ADMIN_ID = "3f1a1d80-8163-46b8-84de-fcfef5875652";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Row = Record<string, unknown>;

/**
 * Table factice : `.select().order().range()` (lecture paginée) ou `.select().in()`, puis les écritures
 * `.insert()` et `.update().eq().eq().select()` de la prolongation.
 */
function tables(
  rows: Record<string, Row[]>,
  {
    updated = [{ user_id: "écrit" }] as Row[],
    writeError = null as { message: string } | null,
  } = {},
) {
  const writes = {
    selected: [] as string[],
    insert: vi.fn(async (_row: Row) => ({ error: writeError })),
    update: vi.fn((_row: Row) => {
      const chain = {
        eq: (_column: string, _value: unknown) => chain,
        select: async () => ({ data: writeError ? null : updated, error: writeError }),
      };
      return chain;
    }),
  };
  mocks.from.mockImplementation((table: string) => {
    const data = rows[table] ?? [];
    return {
      select: (columns: string) => {
        writes.selected.push(columns);
        return {
          order: () => ({ range: async () => ({ data, error: null }) }),
          in: async (_column: string, ids: string[]) => ({
            data: data.filter((row) => ids.includes(row.user_id as string)),
            error: null,
          }),
        };
      },
      insert: writes.insert,
      update: writes.update,
    };
  });
  return writes;
}

/** `get_signup_trial` : la fin de l'essai de chaque compte, et si l'essai est ouvert pour lui. */
function trialRpc(
  trials: Record<string, { endsAt: string | null; gateOpen?: boolean }> = {},
  recordError: { message: string } | null = null,
) {
  mocks.rpc.mockImplementation(async (name: string, args: { p_user_id: string }) => {
    if (name === "record_trial_extension") {
      return recordError ? { data: null, error: recordError } : { data: "note-1", error: null };
    }
    const trial = trials[args.p_user_id];
    return {
      data: trial ? [{ ends_at: trial.endsAt, gate_open: trial.gateOpen ?? true }] : [],
      error: null,
    };
  });
}

function authUser(n: number, createdDaysAgo: number, confirmed = true) {
  const createdAt = new Date(NOW.getTime() - createdDaysAgo * 86_400_000).toISOString();
  return {
    id: id(n),
    email: `compte${n}@exemple.fr`,
    created_at: createdAt,
    email_confirmed_at: confirmed ? createdAt : undefined,
    last_sign_in_at: createdAt,
  };
}

beforeEach(() => {
  mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: ADMIN_ID });
  mocks.launchOffer.mockResolvedValue({ active: true, degraded: false });
});
afterEach(() => vi.resetAllMocks());

describe("resolveSignupAccess", () => {
  const base = {
    profile: { account_tier: "free" },
    subscription: null,
    trialEndsAt: null,
    trialOpen: true,
    now: NOW,
  };

  it("classe un compte dans ses 7 premiers jours en essai, jusqu'à la fin lue en base", () => {
    expect(resolveSignupAccess({ ...base, trialEndsAt: "2026-10-30T10:00:00.000Z" })).toEqual({
      access: "trial",
      accessEndsAt: "2026-10-30T10:00:00.000Z",
    });
  });

  it("met en Découverte un essai terminé, ou un essai en cours que la base dit fermé pour ce compte", () => {
    expect(resolveSignupAccess({ ...base, trialEndsAt: "2026-10-20T10:00:00.000Z" }).access).toBe(
      "decouverte",
    );
    expect(
      resolveSignupAccess({
        ...base,
        trialEndsAt: "2026-10-30T10:00:00.000Z",
        trialOpen: false,
      }).access,
    ).toBe("decouverte");
  });

  it("distingue l'essai prolongé, l'abonnement payant et l'attribution manuelle", () => {
    const end = "2026-11-15T22:59:00.000Z";
    const subscription = {
      plan_code: "analyse",
      status: "trialing",
      current_period_end: end,
      stripe_subscription_id: null,
      metadata: { manual_grant: { source: TRIAL_EXTENSION_SOURCE, current_period_end: end } },
    };
    expect(resolveSignupAccess({ ...base, subscription })).toEqual({
      access: "trial_extended",
      accessEndsAt: end,
    });
    expect(
      resolveSignupAccess({
        ...base,
        subscription: { ...subscription, status: "active", stripe_subscription_id: "sub_1" },
      }).access,
    ).toBe("analyse_paid");
    expect(
      resolveSignupAccess({
        ...base,
        subscription: { ...subscription, metadata: { manual_grant: { source: "admin" } } },
      }).access,
    ).toBe("analyse_manual");
  });

  it("ignore un abonnement Analyse expiré et place le compte premium au-dessus de tout", () => {
    expect(
      resolveSignupAccess({
        ...base,
        subscription: {
          plan_code: "analyse",
          status: "trialing",
          current_period_end: "2026-10-01T00:00:00.000Z",
          stripe_subscription_id: null,
          metadata: {},
        },
      }).access,
    ).toBe("decouverte");
    expect(resolveSignupAccess({ ...base, profile: { account_tier: "premium" } }).access).toBe(
      "premium",
    );
  });
});

describe("extensionRefusal", () => {
  const user = authUser(1, 3);
  const endsAt = Date.parse("2026-11-15T22:59:00.000Z");
  const profile = { account_tier: "free", user_role: "user" };
  const subscription = (
    overrides: Partial<Parameters<typeof extensionRefusal>[0]["subscription"] & object> = {},
  ) => ({
    plan_code: "analyse",
    status: "trialing",
    current_period_end: "2026-12-01T00:00:00.000Z",
    stripe_subscription_id: null as string | null,
    ...overrides,
  });

  it("accepte un compte gratuit confirmé et refuse premium, administrateur et abonnement Stripe vivant", () => {
    expect(extensionRefusal({ user, profile, subscription: null, endsAt, now: NOW })).toBeNull();
    expect(
      extensionRefusal({
        user,
        profile: { account_tier: "premium", user_role: "user" },
        subscription: null,
        endsAt,
        now: NOW,
      }),
    ).toMatch(/premium/);
    expect(
      extensionRefusal({
        user,
        profile: { account_tier: "free", user_role: "admin" },
        subscription: null,
        endsAt,
        now: NOW,
      }),
    ).toMatch(/administrateur/);
    expect(
      extensionRefusal({
        user,
        profile,
        subscription: subscription({ status: "past_due", stripe_subscription_id: "sub_1" }),
        endsAt,
        now: NOW,
      }),
    ).toMatch(/Abonnement Stripe en cours/);
    expect(extensionRefusal({ user: null, profile, subscription: null, endsAt, now: NOW })).toMatch(
      /introuvable/,
    );
  });

  it("refuse un compte dont l'adresse n'est pas confirmée", () => {
    const unconfirmed = { ...user, email_confirmed_at: undefined };
    expect(
      extensionRefusal({ user: unconfirmed, profile, subscription: null, endsAt, now: NOW }),
    ).toMatch(/non confirmée/);
  });

  it("refuse un ancien abonné Stripe, dès qu'un identifiant d'abonnement est présent", () => {
    expect(
      extensionRefusal({
        user,
        profile,
        subscription: subscription({
          status: "cancelled",
          current_period_end: "2026-09-01T00:00:00.000Z",
          stripe_subscription_id: "sub_old",
        }),
        endsAt,
        now: NOW,
      }),
    ).toMatch(/Ancien abonné Stripe/);
  });

  it("refuse une fin qui n'est pas postérieure à la fin naturelle de l'essai", () => {
    const trialEndsAt = "2026-11-01T12:00:00.000Z";
    const refuse = (end: string) =>
      extensionRefusal({
        user,
        profile,
        subscription: null,
        trialEndsAt,
        endsAt: Date.parse(end),
        now: NOW,
      });
    expect(refuse("2026-10-30T12:00:00.000Z")).toMatch(
      /fin naturelle de l’essai \(1er novembre 2026/,
    );
    expect(refuse(trialEndsAt)).toMatch(/fin naturelle/);
    expect(refuse("2026-11-01T12:00:00.001Z")).toBeNull();
    // Un compte sans droit à l'essai n'a pas de fin naturelle à respecter.
    expect(
      extensionRefusal({ user, profile, subscription: null, trialEndsAt: null, endsAt, now: NOW }),
    ).toBeNull();
  });

  it("ne raccourcit jamais un accès Analyse plus long", () => {
    expect(
      extensionRefusal({ user, profile: null, subscription: subscription(), endsAt, now: NOW }),
    ).toMatch(/au-delà/);
    expect(
      extensionRefusal({
        user,
        profile: null,
        subscription: subscription({ current_period_end: "2026-11-01T00:00:00.000Z" }),
        endsAt,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("listAdminSignups", () => {
  it("refuse un compte sans droits administrateur", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false, userId: id(9) });
    await expect(
      listAdminSignups("token", adminSignupListQuerySchema.parse({}), NOW),
    ).rejects.toThrow(/Forbidden/);
    expect(mocks.listUsers).not.toHaveBeenCalled();
  });

  it("liste les comptes du plus récent au plus ancien, sans les administrateurs, avec leur accès", async () => {
    mocks.listUsers.mockResolvedValue({
      data: { users: [authUser(1, 40), authUser(2, 2), authUser(3, 1, false), authUser(4, 0)] },
      error: null,
    });
    tables({
      user_profiles: [
        {
          user_id: id(1),
          account_tier: "free",
          user_role: "user",
          account_type: "b2c",
          full_name: null,
        },
        {
          user_id: id(2),
          account_tier: "free",
          user_role: "user",
          account_type: "b2b",
          full_name: "Me Martin",
        },
        {
          user_id: id(4),
          account_tier: "free",
          user_role: "admin",
          account_type: "b2c",
          full_name: null,
        },
      ],
      user_subscriptions: [],
    });
    trialRpc({
      [id(2)]: { endsAt: "2026-11-01T12:00:00.000Z" },
      [id(1)]: { endsAt: "2026-09-24T12:00:00.000Z" },
    });

    const response = await listAdminSignups("token", adminSignupListQuerySchema.parse({}), NOW);

    expect(response.accounts.map((account) => account.userId)).toEqual([id(3), id(2), id(1)]);
    expect(response.accounts.map((account) => account.access)).toEqual([
      "decouverte",
      "trial",
      "decouverte",
    ]);
    expect(response.accounts[1]).toMatchObject({
      fullName: "Me Martin",
      accountType: "b2b",
      accessEndsAt: "2026-11-01T12:00:00.000Z",
      extendable: true,
    });
    // Fin d'essai passée lue pour la ligne affichée, même hors de la fenêtre des 8 jours.
    expect(response.accounts[2].trialEndsAt).toBe("2026-09-24T12:00:00.000Z");
    expect(response.summary).toMatchObject({
      total: 3,
      confirmed: 2,
      last7Days: 2,
      last30Days: 2,
      byAccess: { trial: 1, decouverte: 2 },
    });
    expect(response.filteredCount).toBe(3);
    expect(response.launchOfferActive).toBe(true);
  });

  it("filtre par type d'accès et par email, puis pagine", async () => {
    mocks.listUsers.mockResolvedValue({
      data: { users: [authUser(1, 40), authUser(2, 20), authUser(3, 10)] },
      error: null,
    });
    tables({ user_profiles: [], user_subscriptions: [] });
    trialRpc();

    const bySearch = await listAdminSignups(
      "token",
      adminSignupListQuerySchema.parse({ q: "COMPTE2" }),
      NOW,
    );
    expect(bySearch.accounts.map((account) => account.userId)).toEqual([id(2)]);
    expect(bySearch.summary.total).toBe(3);

    const byAccess = await listAdminSignups(
      "token",
      adminSignupListQuerySchema.parse({ access: "trial" }),
      NOW,
    );
    expect(byAccess.accounts).toEqual([]);

    const paged = await listAdminSignups(
      "token",
      adminSignupListQuerySchema.parse({ limit: "2", offset: "0" }),
      NOW,
    );
    expect(paged.accounts).toHaveLength(2);
    expect(paged.hasMore).toBe(true);
  });

  it("ne lit pas l'identifiant client Stripe, que la liste n'affiche pas", async () => {
    mocks.listUsers.mockResolvedValue({ data: { users: [authUser(1, 2)] }, error: null });
    const writes = tables({ user_profiles: [], user_subscriptions: [] });
    trialRpc();

    const response = await listAdminSignups("token", adminSignupListQuerySchema.parse({}), NOW);

    expect(writes.selected.join(" ")).not.toContain("stripe_customer_id");
    expect(JSON.stringify(response)).not.toContain("stripe_customer_id");
  });

  it("journalise la consultation : l'administrateur et le nombre de lignes, jamais d'adresse ni de recherche", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocks.listUsers.mockResolvedValue({
      data: { users: [authUser(1, 40), authUser(2, 20)] },
      error: null,
    });
    tables({ user_profiles: [], user_subscriptions: [] });
    trialRpc();

    await listAdminSignups("token", adminSignupListQuerySchema.parse({ q: "compte2" }), NOW);

    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({ scope: "admin.signups.view", adminId: ADMIN_ID, rows: 1 });
    expect(line).not.toContain("compte2");
    expect(line).not.toContain("@");
  });

  it("garde en essai un compte confirmé avant la coupure de l'essai, comme la base", async () => {
    mocks.launchOffer.mockResolvedValue({ active: false, degraded: false });
    mocks.listUsers.mockResolvedValue({
      data: { users: [authUser(1, 2), authUser(2, 1)] },
      error: null,
    });
    tables({ user_profiles: [], user_subscriptions: [] });
    trialRpc({
      [id(1)]: { endsAt: "2026-11-01T12:00:00.000Z", gateOpen: true },
      [id(2)]: { endsAt: "2026-11-02T12:00:00.000Z", gateOpen: false },
    });

    const response = await listAdminSignups("token", adminSignupListQuerySchema.parse({}), NOW);

    expect(Object.fromEntries(response.accounts.map((a) => [a.userId, a.access]))).toEqual({
      [id(1)]: "trial",
      [id(2)]: "decouverte",
    });
    expect(response.launchOfferActive).toBe(false);
  });

  it("borne le décalage de la liste", () => {
    expect(() => adminSignupListQuerySchema.parse({ offset: "100001" })).toThrow();
    expect(adminSignupListQuerySchema.parse({ offset: "100000" }).offset).toBe(100_000);
    expect(() => adminSignupListQuerySchema.parse({ offset: "-1" })).toThrow();
    expect(() => adminSignupListQuerySchema.parse({ offset: "1.5" })).toThrow();
  });
});

describe("extendAdminSignupTrials", () => {
  const confirmedProfile = (n: number, overrides: Row = {}) => ({
    user_id: id(n),
    account_tier: "free",
    user_role: "user",
    account_type: "b2c",
    full_name: null,
    ...overrides,
  });
  const usersById = (overrides: Record<string, Record<string, unknown>> = {}) =>
    mocks.getUserById.mockImplementation(async (userId: string) => ({
      data: {
        user: { ...authUser(Number(userId.slice(-1)), 20), id: userId, ...overrides[userId] },
      },
      error: null,
    }));
  const input = (extra: Record<string, unknown> = {}) =>
    adminTrialExtensionInputSchema.parse({
      userIds: [id(1)],
      endsAt: "2026-11-15T22:59:00.000Z",
      note: "Bêta-testeur",
      ...extra,
    });
  const run = (extra: Record<string, unknown> = {}) =>
    extendAdminSignupTrials({ authToken: "token", input: input(extra), now: NOW });

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("valide l'entrée : identifiants GUID, date lisible, motif obligatoire, 25 comptes au plus", () => {
    const valid = { userIds: [id(1)], endsAt: "2026-11-15", note: "Motif" };
    expect(() =>
      adminTrialExtensionInputSchema.parse({ ...valid, userIds: ["pas-un-uuid"] }),
    ).toThrow();
    expect(() =>
      adminTrialExtensionInputSchema.parse({ ...valid, endsAt: "pas une date" }),
    ).toThrow(/date valide/);
    expect(() => adminTrialExtensionInputSchema.parse({ ...valid, note: undefined })).toThrow();
    expect(() => adminTrialExtensionInputSchema.parse({ ...valid, note: "  " })).toThrow(/motif/);
    expect(() => adminTrialExtensionInputSchema.parse({ ...valid, note: "ab" })).toThrow(/motif/);
    expect(() =>
      adminTrialExtensionInputSchema.parse({ ...valid, note: "x".repeat(501) }),
    ).toThrow();
    const many = (count: number) => Array.from({ length: count }, (_, n) => id(n + 1));
    expect(
      adminTrialExtensionInputSchema.parse({ ...valid, userIds: many(25) }).userIds,
    ).toHaveLength(25);
    expect(() => adminTrialExtensionInputSchema.parse({ ...valid, userIds: many(26) })).toThrow();
    expect(() => adminTrialExtensionInputSchema.parse({ ...valid, userIds: [] })).toThrow();
    // Un identifiant qui n'est pas de version RFC (zod 4 : uuid() strict) reste accepté par guid().
    expect(
      adminTrialExtensionInputSchema.parse({
        ...valid,
        userIds: ["11111111-1111-1111-1111-111111111111"],
      }).userIds,
    ).toHaveLength(1);
  });

  it("refuse une date passée ou au-delà de 90 jours", async () => {
    tables({});
    await expect(run({ endsAt: "2026-10-01T00:00:00.000Z" })).rejects.toThrow(/futur/);
    await expect(run({ endsAt: "2027-01-30T00:00:00.000Z" })).rejects.toThrow(/90 jours/);
    // 90 jours exactement à compter de NOW : accepté.
    tables({ user_profiles: [], user_subscriptions: [] });
    usersById();
    trialRpc();
    await expect(run({ endsAt: "2027-01-25T12:00:00.000Z" })).resolves.toBeDefined();
  });

  it("refuse sans droits administrateur, sans rien lire ni écrire", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: false, userId: id(9) });
    const writes = tables({});
    await expect(run()).rejects.toThrow(/Forbidden/);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
  });

  it("crée une ligne d'essai : motif en table privée, historique vide, ni note ni adresse dans la ligne", async () => {
    const writes = tables({ user_profiles: [confirmedProfile(1)], user_subscriptions: [] });
    usersById();
    trialRpc();

    const response = await run();

    expect(response.results).toEqual([
      { userId: id(1), email: "compte1@exemple.fr", outcome: "extended", reason: null },
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("record_trial_extension", {
      p_user_id: id(1),
      p_granted_by: ADMIN_ID,
      p_ends_at: "2026-11-15T22:59:00.000Z",
      p_note: "Bêta-testeur",
    });
    expect(writes.update).not.toHaveBeenCalled();
    expect(writes.insert).toHaveBeenCalledTimes(1);
    const row = writes.insert.mock.calls[0][0];
    expect(row).toMatchObject({
      user_id: id(1),
      plan_code: "analyse",
      status: "trialing",
      current_period_end: "2026-11-15T22:59:00.000Z",
      metadata: {
        manual_grant: {
          source: TRIAL_EXTENSION_SOURCE,
          granted_by: ADMIN_ID,
          current_period_end: "2026-11-15T22:59:00.000Z",
          note_recorded: true,
        },
        manual_grant_history: [],
      },
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("Bêta-testeur");
    expect(serialized).not.toContain("target_email");
    expect(serialized).not.toContain("compte1@exemple.fr");
  });

  it("ajoute à l'historique au lieu d'écraser, sans note ni adresse, 10 entrées au plus", async () => {
    const earlier = (n: number) => ({
      source: "admin",
      granted_by: ADMIN_ID,
      granted_at: `2026-0${(n % 9) + 1}-01T00:00:00.000Z`,
      current_period_end: `2026-0${(n % 9) + 1}-15T00:00:00.000Z`,
      note: `ancien motif ${n}`,
      target_email: "ancien@exemple.fr",
    });
    const history = Array.from({ length: 10 }, (_, n) => ({ ...earlier(n), note: undefined }));
    const writes = tables({
      user_profiles: [confirmedProfile(1)],
      user_subscriptions: [
        {
          user_id: id(1),
          plan_code: "decouverte",
          status: "expired",
          current_period_end: "2026-10-01T00:00:00.000Z",
          stripe_subscription_id: null,
          updated_at: "2026-10-02T00:00:00.000Z",
          metadata: {
            analyse_checkout_reservation_token: "garde-moi",
            manual_grant: earlier(99),
            manual_grant_history: history,
          },
        },
      ],
    });
    usersById();
    trialRpc();

    await run();

    expect(writes.insert).not.toHaveBeenCalled();
    const [update] = writes.update.mock.calls[0] as [{ metadata: Row }];
    const metadata = update.metadata as {
      manual_grant: Row;
      manual_grant_history: Row[];
      analyse_checkout_reservation_token: string;
    };
    expect(metadata.analyse_checkout_reservation_token).toBe("garde-moi");
    expect(metadata.manual_grant.source).toBe(TRIAL_EXTENSION_SOURCE);
    expect(metadata.manual_grant_history).toHaveLength(10);
    // La précédente attribution passe en tête, débarrassée de sa note et de l'adresse copiée.
    expect(metadata.manual_grant_history[0]).toMatchObject({ source: "admin" });
    expect(metadata.manual_grant_history[0]).not.toHaveProperty("note");
    expect(metadata.manual_grant_history[0]).not.toHaveProperty("target_email");
    expect(JSON.stringify(metadata)).not.toContain("ancien@exemple.fr");
    expect(JSON.stringify(metadata)).not.toContain("ancien motif");
  });

  it("ne remplace pas une ligne modifiée entre la lecture et l'écriture (webhook Stripe)", async () => {
    tables(
      {
        user_profiles: [confirmedProfile(1)],
        user_subscriptions: [
          {
            user_id: id(1),
            plan_code: "decouverte",
            status: "expired",
            current_period_end: null,
            stripe_subscription_id: null,
            updated_at: "2026-10-02T00:00:00.000Z",
            metadata: {},
          },
        ],
      },
      { updated: [] },
    );
    usersById();
    trialRpc();

    const response = await run();

    expect(response.results[0]).toMatchObject({
      outcome: "skipped",
      reason: expect.stringContaining("a changé"),
    });
  });

  it("refuse un compte non confirmé, un ancien abonné Stripe et une fin antérieure à l'essai, sans écrire", async () => {
    const writes = tables({
      user_profiles: [confirmedProfile(1), confirmedProfile(2), confirmedProfile(3)],
      user_subscriptions: [
        {
          user_id: id(2),
          plan_code: "analyse",
          status: "cancelled",
          current_period_end: "2026-08-01T00:00:00.000Z",
          stripe_subscription_id: "sub_old",
          updated_at: "2026-08-02T00:00:00.000Z",
          metadata: {},
        },
      ],
    });
    usersById({ [id(1)]: { email_confirmed_at: undefined } });
    trialRpc({ [id(3)]: { endsAt: "2026-11-20T00:00:00.000Z" } });

    const response = await run({ userIds: [id(1), id(2), id(3)] });

    expect(response.results.map((result) => [result.userId, result.outcome])).toEqual([
      [id(1), "skipped"],
      [id(2), "skipped"],
      [id(3), "skipped"],
    ]);
    expect(response.results[0].reason).toMatch(/non confirmée/);
    expect(response.results[1].reason).toMatch(/Ancien abonné Stripe/);
    expect(response.results[2].reason).toMatch(/fin naturelle/);
    expect(writes.insert).not.toHaveBeenCalled();
    expect(writes.update).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith("record_trial_extension", expect.anything());
  });

  it("écarte un compte premium et rapporte l'échec d'une écriture sans exposer la base", async () => {
    tables(
      {
        user_profiles: [confirmedProfile(1), confirmedProfile(2, { account_tier: "premium" })],
        user_subscriptions: [],
      },
      { writeError: { message: "duplicate key value violates unique constraint" } },
    );
    usersById();
    trialRpc();

    const response = await run({ userIds: [id(1), id(2)] });

    expect(response.results).toEqual([
      {
        userId: id(1),
        email: "compte1@exemple.fr",
        outcome: "skipped",
        reason: "Écriture impossible.",
      },
      {
        userId: id(2),
        email: "compte2@exemple.fr",
        outcome: "skipped",
        reason: "Compte premium : accès complet sans fin.",
      },
    ]);
  });

  it("n'écrit rien quand le motif n'a pas pu être enregistré", async () => {
    const writes = tables({ user_profiles: [confirmedProfile(1)], user_subscriptions: [] });
    usersById();
    trialRpc({}, { message: "boom" });

    const response = await run();

    expect(response.results[0]).toMatchObject({
      outcome: "skipped",
      reason: "Écriture impossible.",
    });
    expect(writes.insert).not.toHaveBeenCalled();
  });

  it("journalise chaque prolongation sans adresse ni motif", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    tables({ user_profiles: [confirmedProfile(1), confirmedProfile(2)], user_subscriptions: [] });
    usersById();
    trialRpc();

    await run({ userIds: [id(1), id(2)] });

    const lines = info.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      scope: "admin.trial-extension",
      adminId: ADMIN_ID,
      userId: id(1),
      endsAt: "2026-11-15T22:59:00.000Z",
      hasNote: true,
    });
    for (const line of lines) {
      expect(line).not.toContain("@");
      expect(line).not.toContain("Bêta-testeur");
    }
  });

  it("rejouer la même prolongation est refusé : pas de doublon au double clic", async () => {
    const writes = tables({
      user_profiles: [confirmedProfile(1)],
      user_subscriptions: [
        {
          user_id: id(1),
          plan_code: "analyse",
          status: "trialing",
          current_period_end: "2026-11-15T22:59:00.000Z",
          stripe_subscription_id: null,
          updated_at: "2026-10-27T11:00:00.000Z",
          metadata: { manual_grant: { source: TRIAL_EXTENSION_SOURCE } },
        },
      ],
    });
    usersById();
    trialRpc();

    const response = await run();

    expect(response.results[0].reason).toMatch(/au-delà/);
    expect(writes.update).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith("record_trial_extension", expect.anything());
  });
});

describe("format des inscriptions", () => {
  it("écrit l'ancienneté en jours, mois puis années", () => {
    const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    expect(formatAccountSeniority(ago(0), NOW)).toBe("aujourd’hui");
    expect(formatAccountSeniority(ago(1), NOW)).toBe("1 jour");
    expect(formatAccountSeniority(ago(12), NOW)).toBe("12 jours");
    expect(formatAccountSeniority(ago(95), NOW)).toBe("3 mois");
    expect(formatAccountSeniority(ago(430), NOW)).toBe("1 an et 2 mois");
  });

  it("place la fin de prolongation en fin de journée", () => {
    const end = endOfDayInDays(7, NOW);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getTime()).toBeGreaterThan(NOW.getTime() + 6 * 86_400_000);
  });
});
