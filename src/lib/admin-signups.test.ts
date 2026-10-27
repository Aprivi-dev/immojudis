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

/** Table factice : `.select().order().range()` (lecture paginée) ou `.select().in()`, et `.upsert()`. */
function tables(rows: Record<string, Row[]>, upsert = vi.fn(async () => ({ error: null }))) {
  mocks.from.mockImplementation((table: string) => {
    const data = rows[table] ?? [];
    return {
      select: () => ({
        order: () => ({ range: async () => ({ data, error: null }) }),
        in: async (_column: string, ids: string[]) => ({
          data: data.filter((row) => ids.includes(row.user_id as string)),
          error: null,
        }),
      }),
      upsert,
    };
  });
  return upsert;
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
    launchOfferActive: true,
    now: NOW,
  };

  it("classe un compte dans ses 7 premiers jours en essai, jusqu'à la fin lue en base", () => {
    expect(resolveSignupAccess({ ...base, trialEndsAt: "2026-10-30T10:00:00.000Z" })).toEqual({
      access: "trial",
      accessEndsAt: "2026-10-30T10:00:00.000Z",
    });
  });

  it("met en Découverte un essai terminé, ou en cours quand l'essai à l'inscription est coupé", () => {
    expect(resolveSignupAccess({ ...base, trialEndsAt: "2026-10-20T10:00:00.000Z" }).access).toBe(
      "decouverte",
    );
    expect(
      resolveSignupAccess({
        ...base,
        trialEndsAt: "2026-10-30T10:00:00.000Z",
        launchOfferActive: false,
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

  it("accepte un compte gratuit et refuse premium, administrateur et abonnement Stripe vivant", () => {
    const profile = { account_tier: "free", user_role: "user" };
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
        subscription: {
          user_id: user.id,
          plan_code: "analyse",
          status: "past_due",
          current_period_end: "2026-10-20T00:00:00.000Z",
          stripe_customer_id: "cus_1",
          stripe_subscription_id: "sub_1",
          metadata: {},
        },
        endsAt,
        now: NOW,
      }),
    ).toMatch(/Stripe/);
    expect(extensionRefusal({ user: null, profile, subscription: null, endsAt, now: NOW })).toMatch(
      /introuvable/,
    );
  });

  it("ne raccourcit jamais un accès Analyse plus long", () => {
    const subscription = {
      user_id: user.id,
      plan_code: "analyse",
      status: "trialing",
      current_period_end: "2026-12-01T00:00:00.000Z",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      metadata: {},
    };
    expect(extensionRefusal({ user, profile: null, subscription, endsAt, now: NOW })).toMatch(
      /au-delà/,
    );
    expect(
      extensionRefusal({
        user,
        profile: null,
        subscription: { ...subscription, current_period_end: "2026-11-01T00:00:00.000Z" },
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
    mocks.rpc.mockImplementation(async (_name: string, { p_user_id }: { p_user_id: string }) => ({
      data:
        p_user_id === id(2)
          ? "2026-11-01T12:00:00.000Z"
          : p_user_id === id(1)
            ? "2026-09-24T12:00:00.000Z"
            : null,
      error: null,
    }));

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
    mocks.rpc.mockResolvedValue({ data: null, error: null });

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
});

describe("extendAdminSignupTrials", () => {
  it("valide l'entrée : identifiants UUID et date lisible", () => {
    expect(() =>
      adminTrialExtensionInputSchema.parse({ userIds: ["pas-un-uuid"], endsAt: "2026-11-15" }),
    ).toThrow();
    expect(() =>
      adminTrialExtensionInputSchema.parse({ userIds: [id(1)], endsAt: "pas une date" }),
    ).toThrow(/date valide/);
  });

  it("refuse une date passée ou trop lointaine", async () => {
    tables({});
    await expect(
      extendAdminSignupTrials({
        authToken: "token",
        input: adminTrialExtensionInputSchema.parse({
          userIds: [id(1)],
          endsAt: "2026-10-01T00:00:00.000Z",
        }),
        now: NOW,
      }),
    ).rejects.toThrow(/futur/);
    await expect(
      extendAdminSignupTrials({
        authToken: "token",
        input: adminTrialExtensionInputSchema.parse({
          userIds: [id(1)],
          endsAt: "2028-01-01T00:00:00.000Z",
        }),
        now: NOW,
      }),
    ).rejects.toThrow(/366 jours/);
  });

  it("attribue l'essai Analyse jusqu'à la date choisie et écarte un compte premium", async () => {
    const upsert = tables({
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
          account_tier: "premium",
          user_role: "user",
          account_type: "b2c",
          full_name: null,
        },
      ],
      user_subscriptions: [],
    });
    mocks.getUserById.mockImplementation(async (userId: string) => ({
      data: { user: { ...authUser(Number(userId.slice(-1)), 5), id: userId } },
      error: null,
    }));

    const response = await extendAdminSignupTrials({
      authToken: "token",
      input: adminTrialExtensionInputSchema.parse({
        userIds: [id(1), id(2)],
        endsAt: "2026-11-15T22:59:00.000Z",
        note: "Bêta-testeur",
      }),
      now: NOW,
    });

    expect(response.results).toEqual([
      { userId: id(1), email: "compte1@exemple.fr", outcome: "extended", reason: null },
      {
        userId: id(2),
        email: "compte2@exemple.fr",
        outcome: "skipped",
        reason: "Compte premium : accès complet sans fin.",
      },
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: id(1),
        plan_code: "analyse",
        status: "trialing",
        current_period_end: "2026-11-15T22:59:00.000Z",
        metadata: expect.objectContaining({
          manual_grant: expect.objectContaining({
            source: TRIAL_EXTENSION_SOURCE,
            granted_by: ADMIN_ID,
            current_period_end: "2026-11-15T22:59:00.000Z",
            note: "Bêta-testeur",
          }),
        }),
      }),
      { onConflict: "user_id" },
    );
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
