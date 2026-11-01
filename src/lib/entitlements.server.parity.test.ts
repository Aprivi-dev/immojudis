import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

/**
 * Parité TypeScript / SQL de l'accès Analyse (n° 42).
 *
 * Les droits d'un compte sont calculés deux fois : par `resolvePlanEntitlements` (TypeScript) et par
 * `app_private.has_active_analysis_access` / `has_standing_analysis_access` (SQL, qui ouvre les
 * lignes et les fonctions de la base). Ce test rejoue ici les cas des tests pgTAP 740, 774, 775 et 850
 * (`supabase/tests/`) contre la fonction TypeScript, avec les mêmes dates et les mêmes lignes
 * d'abonnement. Chaque cas cite la phrase du test pgTAP dont il reprend le verdict : si cette phrase
 * disparaît ou change, le test échoue et force à revoir les deux côtés ensemble.
 *
 * Seule la lecture de l'essai à l'inscription est simulée (`readSignupTrial` interroge la base) ; sa
 * règle est celle de `app_private.signup_trial_ends_at` : 7 jours après la confirmation de l'adresse,
 * interrupteur coupé = seuls les comptes confirmés avant la coupure gardent leur essai.
 */

const DAY = 86_400_000;
const now = Date.now();
const daysFromNow = (days: number) => new Date(now + days * DAY).toISOString();

type TrialState = {
  /** Date de confirmation de l'adresse (null : non confirmée). */
  confirmedAt: string | null;
  /** L'interrupteur de l'essai est-il ouvert ? */
  switchOpen: boolean;
  /** Date de coupure de l'interrupteur, quand il est fermé. */
  closedAt?: string;
};

const mocks = vi.hoisted(() => ({ trialState: { current: null as unknown } }));

vi.mock("@/lib/launch-offer.server", () => ({
  hasActiveSignupTrial: vi.fn(),
  readSignupTrial: async () => {
    const state = mocks.trialState.current as TrialState;
    if (!state.confirmedAt) return { active: false, endsAt: null };
    const endsAt = new Date(Date.parse(state.confirmedAt) + 7 * DAY).toISOString();
    const confirmedBeforeClose =
      state.switchOpen ||
      (state.closedAt && Date.parse(state.confirmedAt) <= Date.parse(state.closedAt));
    return { active: Boolean(confirmedBeforeClose) && Date.parse(endsAt) > now, endsAt };
  },
}));
vi.mock("@/lib/sale-unlocks.server", () => ({ hasUnlockedSale: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { hasStandingAnalysisAccess } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/entitlements.server";

type Subscription = {
  plan_code: string;
  status: string;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  metadata: Record<string, unknown>;
};

type ParityCase = {
  name: string;
  /** Fichier pgTAP et phrase de l'assertion dont le verdict est repris. */
  pgtap: Array<{ file: string; description: string }>;
  trial: TrialState;
  subscription?: Subscription;
  /** `app_private.has_active_analysis_access` */
  access: boolean;
  /** `app_private.has_standing_analysis_access` (omis : non vérifié par le test pgTAP) */
  standing?: boolean;
};

const TRIAL_740 = "740_signup_trial_seven_days.sql";
const EXTENSION_774 = "774_trial_extension_is_a_trial.sql";
const CLOSE_775 = "775_launch_offer_close_keeps_running_trials.sql";
const PERIOD_END_850 = "850_subscription_access_requires_period_end.sql";

const open2DaysAgo: TrialState = { confirmedAt: daysFromNow(-2), switchOpen: true };
const open8DaysAgo: TrialState = { confirmedAt: daysFromNow(-8), switchOpen: true };
const open20DaysAgo: TrialState = { confirmedAt: daysFromNow(-20), switchOpen: true };

const subscriber = (overrides: Partial<Subscription> = {}): Subscription => ({
  plan_code: "analyse",
  status: "active",
  current_period_end: daysFromNow(30),
  stripe_customer_id: null,
  stripe_subscription_id: null,
  metadata: {},
  ...overrides,
});
const extensionMeta = { manual_grant: { source: "admin_trial_extension" } };

const CASES: ParityCase[] = [
  // 740 : essai de 7 jours à l'inscription
  {
    name: "740 : confirmé il y a 2 jours, dans son essai",
    pgtap: [
      { file: TRIAL_740, description: "the trial opens the Analyse access" },
      {
        file: TRIAL_740,
        description: "the trial is not a standing access (separate global caps still apply)",
      },
    ],
    trial: open2DaysAgo,
    access: true,
    standing: false,
  },
  {
    name: "740 : confirmé il y a 8 jours, essai terminé",
    pgtap: [{ file: TRIAL_740, description: "after the trial the account is back to Découverte" }],
    trial: open8DaysAgo,
    access: false,
  },
  {
    name: "740 : confirmé il y a 8 jours, abonné Analyse",
    pgtap: [
      { file: TRIAL_740, description: "a subscriber keeps the Analyse access after the trial" },
    ],
    trial: open8DaysAgo,
    subscription: subscriber(),
    access: true,
    standing: true,
  },
  {
    name: "740 : interrupteur coupé, essai déjà en cours",
    pgtap: [
      {
        file: TRIAL_740,
        description: "cutting the switch keeps a trial that was already running (20261108130100)",
      },
    ],
    trial: { confirmedAt: daysFromNow(-2), switchOpen: false, closedAt: daysFromNow(-1) },
    access: true,
  },
  // 774 : prolongation d'essai par l'administrateur
  {
    name: "774 : essai prolongé (sans abonnement Stripe)",
    pgtap: [
      {
        file: EXTENSION_774,
        description: "the extended account has the Analyse access until the chosen end",
      },
      { file: EXTENSION_774, description: "the extended account has no standing access" },
    ],
    trial: open20DaysAgo,
    subscription: subscriber({ status: "trialing", metadata: extensionMeta }),
    access: true,
    standing: false,
  },
  {
    name: "774 : prolongation devenue abonnement Stripe",
    pgtap: [
      {
        file: EXTENSION_774,
        description: "an extension that became a Stripe subscription is a standing access",
      },
    ],
    trial: open20DaysAgo,
    subscription: subscriber({ stripe_subscription_id: "sub_ext770", metadata: extensionMeta }),
    access: true,
    standing: true,
  },
  {
    name: "774 : attribution manuelle ordinaire",
    pgtap: [
      { file: EXTENSION_774, description: "an ordinary manual grant keeps the standing access" },
    ],
    trial: open20DaysAgo,
    subscription: subscriber({ metadata: { manual_grant: { source: "admin" } } }),
    access: true,
    standing: true,
  },
  {
    name: "774 : abonné Stripe",
    pgtap: [{ file: EXTENSION_774, description: "a subscriber keeps the standing access" }],
    trial: open20DaysAgo,
    subscription: subscriber({ stripe_subscription_id: "sub_ext770_2" }),
    access: true,
    standing: true,
  },
  {
    name: "774 : prolongation échue",
    pgtap: [
      {
        file: EXTENSION_774,
        description: "an expired extension (and an expired trial) opens nothing",
      },
    ],
    trial: open20DaysAgo,
    subscription: subscriber({
      status: "trialing",
      current_period_end: daysFromNow(-1),
      metadata: extensionMeta,
    }),
    access: false,
  },
  // 775 : coupure de l'interrupteur
  {
    name: "775 : interrupteur ouvert, essai en cours",
    pgtap: [
      { file: CLOSE_775, description: "open switch: the running trial has the Analyse access" },
    ],
    trial: open2DaysAgo,
    access: true,
  },
  {
    name: "775 : interrupteur ouvert, essai terminé",
    pgtap: [{ file: CLOSE_775, description: "open switch: the ended trial has none" }],
    trial: open8DaysAgo,
    access: false,
  },
  {
    name: "775 : interrupteur coupé, confirmé avant la coupure",
    pgtap: [
      {
        file: CLOSE_775,
        description: "cut switch: an account confirmed before the cut keeps its running trial",
      },
    ],
    trial: { confirmedAt: daysFromNow(-2), switchOpen: false, closedAt: daysFromNow(-0.5) },
    access: true,
  },
  {
    name: "775 : interrupteur coupé, essai déjà terminé",
    pgtap: [
      { file: CLOSE_775, description: "cut switch: the trial that already ended stays ended" },
    ],
    trial: { confirmedAt: daysFromNow(-8), switchOpen: false, closedAt: daysFromNow(-0.5) },
    access: false,
  },
  {
    name: "775 : interrupteur coupé, adresse non confirmée",
    pgtap: [
      { file: CLOSE_775, description: "cut switch: an account still unconfirmed has nothing" },
    ],
    trial: { confirmedAt: null, switchOpen: false, closedAt: daysFromNow(-0.5) },
    access: false,
  },
  {
    name: "775 : interrupteur coupé, confirmé après la coupure",
    pgtap: [
      {
        file: CLOSE_775,
        description: "cut switch: an account that confirms after the cut gets no trial",
      },
    ],
    trial: {
      confirmedAt: new Date(now + 60_000).toISOString(),
      switchOpen: false,
      closedAt: daysFromNow(-0.5),
    },
    access: false,
  },
  {
    name: "775 : interrupteur rétabli, confirmé pendant la fermeture",
    pgtap: [
      {
        file: CLOSE_775,
        description: "reopened: the account confirmed during the closure now has its trial",
      },
    ],
    trial: { confirmedAt: daysFromNow(-1), switchOpen: true },
    access: true,
  },
  // 850 : un statut d'accès sans fin de période n'ouvre rien (n° 47)
  {
    name: "850 : abonnement actif sans fin de période",
    pgtap: [
      {
        file: PERIOD_END_850,
        description: "a subscription row without a period end gives no Analyse access",
      },
    ],
    trial: open20DaysAgo,
    subscription: subscriber({ current_period_end: null }),
    access: false,
  },
  {
    name: "850 : essai « trialing » sans fin de période",
    pgtap: [
      {
        file: PERIOD_END_850,
        description: "a trialing row without a period end gives no Analyse access",
      },
    ],
    trial: open20DaysAgo,
    subscription: subscriber({ status: "trialing", current_period_end: null }),
    access: false,
  },
  {
    name: "850 : abonnement actif avec une fin de période future",
    pgtap: [
      {
        file: PERIOD_END_850,
        description: "a subscription with a future period end keeps the Analyse access",
      },
    ],
    trial: open20DaysAgo,
    subscription: subscriber(),
    access: true,
    standing: true,
  },
  {
    name: "850 : renouvellement échoué, dans la grâce de sept jours",
    pgtap: [
      {
        file: PERIOD_END_850,
        description: "a failed renewal keeps the access during the grace",
      },
    ],
    trial: open20DaysAgo,
    subscription: subscriber({ status: "past_due", current_period_end: daysFromNow(-3) }),
    access: true,
  },
];

function account(subscription: Subscription | undefined): SupabaseAuthContext {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: subscription ?? null, error: null }),
  };
  return {
    userId: "user-1",
    claims: {},
    accountTier: "free",
    userRole: "user",
    isAdmin: false,
    hasProfile: true,
    supabase: { from: () => query },
  } as unknown as SupabaseAuthContext;
}

function pgtapSource(file: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/tests", file), "utf8");
}

describe("parité TypeScript / SQL de l'accès Analyse (pgTAP 740, 774, 775, 850)", () => {
  beforeEach(() => {
    mocks.trialState.current = null;
  });

  it.each(CASES)("$name", async ({ trial, subscription, access, standing }) => {
    mocks.trialState.current = trial;
    const plan = await resolvePlanEntitlements(account(subscription));
    expect(plan.hasAnalysisAccess, "has_active_analysis_access").toBe(access);
    if (standing !== undefined) {
      expect(hasStandingAnalysisAccess(plan), "has_standing_analysis_access").toBe(standing);
    }
  });

  it("chaque verdict repris existe encore dans le test pgTAP correspondant", () => {
    for (const testCase of CASES) {
      for (const { file, description } of testCase.pgtap) {
        expect(pgtapSource(file), `${file} : « ${description} »`).toContain(`'${description}'`);
      }
    }
  });
});
