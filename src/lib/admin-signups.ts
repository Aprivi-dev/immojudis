import "server-only";
import { z } from "zod";
import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  ADMIN_SIGNUP_ACCESS,
  TRIAL_EXTENSION_MAX_ACCOUNTS,
  TRIAL_EXTENSION_MAX_DAYS,
  type AdminSignupAccess,
} from "@/lib/admin-signups-format";
import { assertAdminAuth, withManualGrant } from "@/lib/admin-subscriptions";
import { signupTrialDateLabel } from "@/lib/launch-offer";
import { readLaunchOfferState } from "@/lib/launch-offer.server";
import { isPlanPeriodActive, TRIAL_EXTENSION_SOURCE } from "@/lib/plans";
import { isMissingRpcError } from "@/lib/postgrest-errors";

/**
 * Vue admin « Inscriptions » : tous les comptes créés (gratuits compris), avec leur date
 * d'inscription, leur ancienneté et l'accès dont ils bénéficient à cet instant, et la prolongation
 * de l'essai gratuit pour des comptes choisis.
 *
 * Même protection que les autres routes admin (`assertAdminAuth` : rôle administrateur et double
 * authentification), puis lecture avec le client de service. Les comptes administrateurs ne sont
 * pas listés (comme dans le pilotage).
 *
 * Prolonger un essai, c'est écrire dans `user_subscriptions` une ligne d'ESSAI (statut « Essai », fin de
 * période à la date choisie, source `admin_trial_extension`, aucun abonnement Stripe) : la base et
 * l'application la traitent comme l'essai qu'elle prolonge (migration 20261108130000), et l'accès se
 * ferme seul à la date dite. Garde-fous : compte confirmé, jamais un abonné Stripe (identifiant
 * présent) ni un compte premium, jamais une fin antérieure à la fin naturelle de l'essai ni à un
 * accès plus long, 90 jours et 25 comptes au plus par appel, motif obligatoire. Le motif est
 * enregistré dans `app_private.trial_extension_notes` (jamais lisible par le compte) ; la ligne ne
 * garde que l'attribution et un historique de 10 entrées.
 */

export {
  ADMIN_SIGNUP_ACCESS,
  TRIAL_EXTENSION_MAX_ACCOUNTS,
  TRIAL_EXTENSION_MAX_DAYS,
  TRIAL_EXTENSION_SOURCE,
  type AdminSignupAccess,
};

/**
 * Usage d'un compte (`admin_signup_usage`, migration 20261108180300) : de quoi voir qui a essayé sans
 * rien faire. Aucune vente, aucun contenu.
 */
export type AdminSignupUsage = {
  /** Ventes débloquées (l'essai n'en consomme aucun). */
  unlocks: number;
  /** Plafonds enregistrés dans « Mon dossier » : le travail délibéré. */
  ceilings: number;
  favorites: number;
  /** Ventes dont la valeur de référence a été servie au compte (90 jours seulement). */
  sheetsServed: number;
};

/** Un compte sans la moindre trace d'usage. */
export function isIdleUsage(usage: AdminSignupUsage): boolean {
  return usage.unlocks + usage.ceilings + usage.favorites + usage.sheetsServed === 0;
}

export type AdminSignupAccount = {
  userId: string;
  email: string | null;
  fullName: string | null;
  accountType: "b2c" | "b2b" | null;
  createdAt: string;
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
  access: AdminSignupAccess;
  /** Fin de l'accès en cours (essai, prolongation, période) ; `null` : Découverte ou sans fin. */
  accessEndsAt: string | null;
  /** Fin de l'essai de 7 jours, même passée ; `null` : le compte n'y a pas droit. */
  trialEndsAt: string | null;
  /** Faux pour un compte premium ou un abonnement Stripe en cours : rien à prolonger ici. */
  extendable: boolean;
  /** Usage du compte ; `null` : non mesuré (migration pas encore appliquée, panne). */
  usage: AdminSignupUsage | null;
};

export type AdminSignupSummary = {
  total: number;
  confirmed: number;
  last7Days: number;
  last30Days: number;
  byAccess: Record<AdminSignupAccess, number>;
  /** Comptes en Découverte dont l'essai est fini sans aucune activité ; `null` : usage non mesuré. */
  trialEndedIdle: number | null;
};

export type AdminSignupListResponse = {
  accounts: AdminSignupAccount[];
  summary: AdminSignupSummary;
  /** Comptes qui répondent à la recherche et au filtre. */
  filteredCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** L'essai à l'inscription est ouvert (interrupteur de l'offre de lancement). */
  launchOfferActive: boolean;
  /** Vrai si la lecture des comptes a atteint sa limite : la liste est incomplète. */
  truncated: boolean;
  /** Faux : l'usage par compte n'a pas pu être lu (colonnes « non mesuré », filtre vide). */
  usageAvailable: boolean;
  generatedAt: string;
};

export const adminSignupListQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(320).default(""),
  access: z.enum(["all", ...ADMIN_SIGNUP_ACCESS]).default("all"),
  /** `trial_ended_idle` : essai fini sans activité (Découverte, aucun déblocage, plafond, favori ni fiche). */
  activity: z.enum(["all", "trial_ended_idle"]).default("all"),
});
export type AdminSignupListQuery = z.input<typeof adminSignupListQuerySchema>;

export const adminTrialExtensionInputSchema = z.object({
  userIds: z.array(z.string().guid()).min(1).max(TRIAL_EXTENSION_MAX_ACCOUNTS),
  endsAt: z
    .string()
    .trim()
    .refine((value) => Number.isFinite(new Date(value).getTime()), {
      message: "La nouvelle date de fin doit être une date valide.",
    })
    .transform((value) => new Date(value).toISOString()),
  /** Motif de la prolongation : obligatoire, gardé hors de la ligne lisible par le compte. */
  note: z
    .string()
    .trim()
    .min(3, "Indiquez le motif de la prolongation (3 caractères au moins).")
    .max(500),
});
export type AdminTrialExtensionInput = z.input<typeof adminTrialExtensionInputSchema>;
export type AdminTrialExtensionPayload = z.output<typeof adminTrialExtensionInputSchema>;

export type AdminTrialExtensionResult = {
  userId: string;
  email: string | null;
  outcome: "extended" | "skipped";
  /** Raison d'un refus, lisible par l'administrateur. */
  reason: string | null;
};

export type AdminTrialExtensionResponse = {
  endsAt: string;
  results: AdminTrialExtensionResult[];
};

type ProfileRow = Pick<
  Database["public"]["Tables"]["user_profiles"]["Row"],
  "user_id" | "account_tier" | "user_role" | "account_type" | "full_name"
>;
type SubscriptionRow = Pick<
  Database["public"]["Tables"]["user_subscriptions"]["Row"],
  | "user_id"
  | "plan_code"
  | "status"
  | "current_period_end"
  | "stripe_subscription_id"
  | "metadata"
  | "updated_at"
>;
type AuthAccount = Pick<
  User,
  "id" | "email" | "created_at" | "email_confirmed_at" | "last_sign_in_at"
>;

const AUTH_PAGE_SIZE = 1000;
const AUTH_MAX_PAGES = 20;
const TABLE_PAGE_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Seuls les comptes confirmés depuis moins de 8 jours peuvent être en essai (7 jours + marge). */
const TRIAL_CANDIDATE_MS = 8 * DAY_MS;
const TRIAL_READ_CONCURRENCY = 8;
/** Statuts Stripe d'un abonnement encore vivant, que la prolongation ne doit pas écraser. */
const LIVE_STRIPE_STATUSES: readonly string[] = ["trialing", "active", "past_due", "paused"];

export async function listAdminSignups(
  authToken: string,
  query: z.output<typeof adminSignupListQuerySchema>,
  now: Date = new Date(),
): Promise<AdminSignupListResponse> {
  const auth = await assertAdminAuth(authToken);
  const [{ users, truncated }, profiles, subscriptions, launchOffer, usageRows] = await Promise.all(
    [
      listAuthAccounts(),
      readAllProfiles(),
      readAllSubscriptions(),
      readLaunchOfferState(now.getTime()),
      readSignupUsage(),
    ],
  );
  const profileByUser = new Map(profiles.map((row) => [row.user_id, row]));
  const subscriptionByUser = new Map(subscriptions.map((row) => [row.user_id, row]));

  const accounts = users
    .filter((user) => profileByUser.get(user.id)?.user_role !== "admin")
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));

  // L'essai n'est lu en base (règle unique `get_signup_trial_end`) que pour les comptes qui peuvent
  // encore y être, puis pour les lignes affichées.
  const trialEnds = await readTrialEnds(
    accounts
      .filter(
        (user) =>
          user.email_confirmed_at &&
          now.getTime() - Date.parse(user.email_confirmed_at) < TRIAL_CANDIDATE_MS,
      )
      .map((user) => user.id),
  );

  // La fin d'essai de chaque compte vient aussi de la lecture d'usage (même règle en base) : les comptes
  // dont l'essai est fini depuis plus de 8 jours n'ont pas à être relus un par un.
  if (usageRows) {
    for (const [userId, row] of usageRows) {
      if (!trialEnds.has(userId))
        trialEnds.set(userId, { endsAt: row.trialEndsAt, gateOpen: null });
    }
  }

  const classify = (user: AuthAccount): AdminSignupAccount => {
    const trial = trialEnds.get(user.id);
    return toSignupAccount({
      user,
      profile: profileByUser.get(user.id) ?? null,
      subscription: subscriptionByUser.get(user.id) ?? null,
      trialEndsAt: trial?.endsAt ?? null,
      // L'essai est ouvert pour ce compte : interrupteur actif, ou adresse confirmée avant la coupure
      // (la base le dit ; avant la migration 20261108130100, l'interrupteur seul).
      trialOpen: trial?.gateOpen ?? launchOffer.active,
      usage: usageRows ? (usageRows.get(user.id)?.usage ?? EMPTY_USAGE) : null,
      now,
    });
  };

  const classified = accounts.map(classify);
  const summary = summarize(classified, now);
  const search = query.q.toLowerCase();
  const filtered = classified.filter(
    (account) =>
      (query.access === "all" || account.access === query.access) &&
      (query.activity === "all" || isTrialEndedIdle(account, now)) &&
      (!search ||
        (account.email ?? "").toLowerCase().includes(search) ||
        (account.fullName ?? "").toLowerCase().includes(search)),
  );
  const page = filtered.slice(query.offset, query.offset + query.limit);

  // Fin d'essai passée des lignes affichées (« essai terminé le … »).
  const missing = page.filter((account) => !trialEnds.has(account.userId));
  if (missing.length) {
    const more = await readTrialEnds(missing.map((account) => account.userId));
    for (const [userId, trial] of more) trialEnds.set(userId, trial);
  }
  const userById = new Map(accounts.map((user) => [user.id, user]));

  // Trace de la consultation : qui, combien de lignes. Jamais d'adresse, de nom ni de recherche.
  console.info(
    JSON.stringify({ scope: "admin.signups.view", adminId: auth.userId, rows: page.length }),
  );

  return {
    accounts: page.map((account) => classify(userById.get(account.userId)!)),
    summary,
    filteredCount: filtered.length,
    offset: query.offset,
    limit: query.limit,
    hasMore: query.offset + page.length < filtered.length,
    launchOfferActive: launchOffer.active,
    truncated,
    usageAvailable: usageRows !== null,
    generatedAt: now.toISOString(),
  };
}

export async function extendAdminSignupTrials({
  authToken,
  input,
  now = new Date(),
}: {
  authToken: string;
  input: AdminTrialExtensionPayload;
  now?: Date;
}): Promise<AdminTrialExtensionResponse> {
  const auth = await assertAdminAuth(authToken);
  const endsAt = Date.parse(input.endsAt);
  if (endsAt <= now.getTime()) {
    throw new Error("La nouvelle date de fin doit être dans le futur.");
  }
  if (endsAt > now.getTime() + TRIAL_EXTENSION_MAX_DAYS * DAY_MS) {
    throw new Error(`Une prolongation ne peut pas dépasser ${TRIAL_EXTENSION_MAX_DAYS} jours.`);
  }
  if (input.userIds.length > TRIAL_EXTENSION_MAX_ACCOUNTS) {
    throw new Error(`Une prolongation vise ${TRIAL_EXTENSION_MAX_ACCOUNTS} comptes au plus.`);
  }

  const userIds = Array.from(new Set(input.userIds));
  const [profiles, subscriptions, users, trialEnds] = await Promise.all([
    readProfiles(userIds),
    readSubscriptions(userIds),
    Promise.all(userIds.map(readAuthAccount)),
    readTrialEnds(userIds),
  ]);
  const profileByUser = new Map(profiles.map((row) => [row.user_id, row]));
  const subscriptionByUser = new Map(subscriptions.map((row) => [row.user_id, row]));

  const results: AdminTrialExtensionResult[] = [];
  for (const [index, userId] of userIds.entries()) {
    const user = users[index];
    const email = user?.email ?? null;
    const subscription = subscriptionByUser.get(userId) ?? null;
    const refusal = extensionRefusal({
      user,
      profile: profileByUser.get(userId) ?? null,
      subscription,
      trialEndsAt: trialEnds.get(userId)?.endsAt ?? null,
      endsAt,
      now,
    });
    if (refusal) {
      results.push({ userId, email, outcome: "skipped", reason: refusal });
      continue;
    }

    const written = await writeTrialExtension({
      adminId: auth.userId,
      userId,
      subscription,
      endsAt: input.endsAt,
      note: input.note,
      now,
    });
    if (written !== "written") {
      results.push({
        userId,
        email,
        outcome: "skipped",
        reason:
          written === "changed"
            ? "Le compte a changé pendant l’opération : relancez la prolongation."
            : "Écriture impossible.",
      });
      continue;
    }
    // Journal de chaque prolongation : qui, pour quel compte, jusqu'à quand. Ni adresse ni motif.
    console.info(
      JSON.stringify({
        scope: "admin.trial-extension",
        adminId: auth.userId,
        userId,
        endsAt: input.endsAt,
        hasNote: true,
      }),
    );
    results.push({ userId, email, outcome: "extended", reason: null });
  }

  return { endsAt: input.endsAt, results };
}

/**
 * Écrit une prolongation : le motif d'abord, dans la table privée (une prolongation sans motif ne
 * doit jamais exister), puis la ligne d'essai. La mise à jour d'une ligne existante est conditionnée
 * à son `updated_at` lu : un webhook Stripe arrivé entre la lecture et l'écriture n'est pas écrasé
 * (`changed`). L'insertion d'une première ligne échoue si une autre est apparue entre-temps.
 */
async function writeTrialExtension({
  adminId,
  userId,
  subscription,
  endsAt,
  note,
  now,
}: {
  adminId: string;
  userId: string;
  subscription: SubscriptionRow | null;
  endsAt: string;
  note: string;
  now: Date;
}): Promise<"written" | "changed" | "failed"> {
  const fail = (step: string, error: { message: string }) => {
    console.error(
      JSON.stringify({ scope: "admin.trial-extension", userId, step, error: error.message }),
    );
    return "failed" as const;
  };

  const recorded = await supabaseAdmin.rpc("record_trial_extension", {
    p_user_id: userId,
    p_granted_by: adminId,
    p_ends_at: endsAt,
    p_note: note,
  });
  if (recorded.error) return fail("note", recorded.error);

  const metadata = asJson(
    withManualGrant(subscription?.metadata, {
      source: TRIAL_EXTENSION_SOURCE,
      granted_by: adminId,
      granted_at: now.toISOString(),
      plan_code: "analyse",
      status: "trialing",
      current_period_end: endsAt,
      // Le motif n'est pas dans cette ligne, lisible par le compte : il est dans la table privée.
      note_recorded: true,
    }),
  );

  if (!subscription) {
    const { error } = await supabaseAdmin.from("user_subscriptions").insert({
      user_id: userId,
      plan_code: "analyse",
      status: "trialing",
      current_period_end: endsAt,
      metadata,
    });
    return error ? fail("insert", error) : "written";
  }

  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .update({ plan_code: "analyse", status: "trialing", current_period_end: endsAt, metadata })
    .eq("user_id", userId)
    .eq("updated_at", subscription.updated_at)
    .select("user_id");
  if (error) return fail("update", error);
  return data && data.length > 0 ? "written" : "changed";
}

/** L'accès du compte à cet instant, avec la même priorité que les droits en base. */
export function resolveSignupAccess({
  profile,
  subscription,
  trialEndsAt,
  trialOpen,
  now,
}: {
  profile: Pick<ProfileRow, "account_tier"> | null;
  subscription: Pick<
    SubscriptionRow,
    "plan_code" | "status" | "current_period_end" | "stripe_subscription_id" | "metadata"
  > | null;
  trialEndsAt: string | null;
  /** L'essai est ouvert pour ce compte (interrupteur actif, ou adresse confirmée avant la coupure). */
  trialOpen: boolean;
  now: Date;
}): { access: AdminSignupAccess; accessEndsAt: string | null } {
  if (profile?.account_tier === "premium") return { access: "premium", accessEndsAt: null };
  if (
    subscription?.plan_code === "analyse" &&
    isPlanPeriodActive(subscription.status, subscription.current_period_end, now)
  ) {
    const accessEndsAt = subscription.current_period_end;
    if (isTrialExtension(subscription)) return { access: "trial_extended", accessEndsAt };
    if (subscription.stripe_subscription_id) return { access: "analyse_paid", accessEndsAt };
    return { access: "analyse_manual", accessEndsAt };
  }
  if (trialOpen && trialEndsAt && Date.parse(trialEndsAt) > now.getTime()) {
    return { access: "trial", accessEndsAt: trialEndsAt };
  }
  return { access: "decouverte", accessEndsAt: null };
}

/**
 * La ligne d'abonnement vient de la dernière prolongation d'essai : l'attribution porte la même
 * fin que la ligne (un webhook Stripe postérieur la changerait).
 */
function isTrialExtension(
  subscription: Pick<SubscriptionRow, "status" | "current_period_end" | "metadata">,
): boolean {
  const grant = jsonObject(jsonObject(subscription.metadata).manual_grant as Json);
  return (
    grant.source === TRIAL_EXTENSION_SOURCE &&
    subscription.status === "trialing" &&
    typeof grant.current_period_end === "string" &&
    subscription.current_period_end != null &&
    Date.parse(grant.current_period_end) === Date.parse(subscription.current_period_end)
  );
}

function hasLiveStripeSubscription(
  subscription: Pick<SubscriptionRow, "status" | "stripe_subscription_id"> | null,
): boolean {
  return Boolean(
    subscription?.stripe_subscription_id && LIVE_STRIPE_STATUSES.includes(subscription.status),
  );
}

export function extensionRefusal({
  user,
  profile,
  subscription,
  trialEndsAt,
  endsAt,
  now,
}: {
  user: AuthAccount | null;
  profile: Pick<ProfileRow, "account_tier" | "user_role"> | null;
  subscription: Pick<
    SubscriptionRow,
    "plan_code" | "status" | "current_period_end" | "stripe_subscription_id"
  > | null;
  /** Fin naturelle de l'essai du compte (même passée), `null` s'il n'y a pas droit. */
  trialEndsAt?: string | null;
  endsAt: number;
  now: Date;
}): string | null {
  if (!user) return "Compte introuvable.";
  if (profile?.user_role === "admin") return "Compte administrateur.";
  if (profile?.account_tier === "premium") return "Compte premium : accès complet sans fin.";
  if (!user.email_confirmed_at) return "Adresse email non confirmée : rien à prolonger.";
  if (hasLiveStripeSubscription(subscription)) {
    return "Abonnement Stripe en cours : à gérer depuis Stripe.";
  }
  if (subscription?.stripe_subscription_id) {
    return "Ancien abonné Stripe : utilisez l’attribution manuelle d’un accès, pas la prolongation d’essai.";
  }
  if (
    trialEndsAt &&
    Number.isFinite(Date.parse(trialEndsAt)) &&
    endsAt <= Date.parse(trialEndsAt)
  ) {
    return `Cette fin n’est pas postérieure à la fin naturelle de l’essai (${signupTrialDateLabel(trialEndsAt)}).`;
  }
  if (
    subscription?.plan_code === "analyse" &&
    isPlanPeriodActive(subscription.status, subscription.current_period_end, now)
  ) {
    if (subscription.current_period_end == null) return "Accès Analyse déjà sans date de fin.";
    if (Date.parse(subscription.current_period_end) >= endsAt) {
      return "Accès Analyse déjà ouvert au-delà de cette date.";
    }
  }
  return null;
}

function toSignupAccount({
  user,
  profile,
  subscription,
  trialEndsAt,
  trialOpen,
  usage,
  now,
}: {
  user: AuthAccount;
  profile: ProfileRow | null;
  subscription: SubscriptionRow | null;
  trialEndsAt: string | null;
  trialOpen: boolean;
  usage: AdminSignupUsage | null;
  now: Date;
}): AdminSignupAccount {
  const { access, accessEndsAt } = resolveSignupAccess({
    profile,
    subscription,
    trialEndsAt,
    trialOpen,
    now,
  });
  return {
    userId: user.id,
    email: user.email ?? null,
    fullName: profile?.full_name ?? null,
    accountType:
      profile?.account_type === "b2b" ? "b2b" : profile?.account_type === "b2c" ? "b2c" : null,
    createdAt: user.created_at,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    access,
    accessEndsAt,
    trialEndsAt,
    extendable: access !== "premium" && !hasLiveStripeSubscription(subscription),
    usage,
  };
}

const EMPTY_USAGE: AdminSignupUsage = { unlocks: 0, ceilings: 0, favorites: 0, sheetsServed: 0 };

/** Essai fini, compte revenu en Découverte, et aucune trace d'usage : un compte à appeler (avec son accord). */
export function isTrialEndedIdle(account: AdminSignupAccount, now: Date): boolean {
  return (
    account.access === "decouverte" &&
    account.usage != null &&
    account.trialEndsAt != null &&
    Date.parse(account.trialEndsAt) <= now.getTime() &&
    isIdleUsage(account.usage)
  );
}

export function summarize(accounts: AdminSignupAccount[], now: Date): AdminSignupSummary {
  const byAccess = Object.fromEntries(ADMIN_SIGNUP_ACCESS.map((access) => [access, 0])) as Record<
    AdminSignupAccess,
    number
  >;
  let confirmed = 0;
  let last7Days = 0;
  let last30Days = 0;
  for (const account of accounts) {
    byAccess[account.access] += 1;
    if (account.emailConfirmedAt) confirmed += 1;
    const age = now.getTime() - Date.parse(account.createdAt);
    if (age < 7 * DAY_MS) last7Days += 1;
    if (age < 30 * DAY_MS) last30Days += 1;
  }
  const trialEndedIdle = accounts.some((account) => account.usage == null)
    ? null
    : accounts.filter((account) => isTrialEndedIdle(account, now)).length;
  return { total: accounts.length, confirmed, last7Days, last30Days, byAccess, trialEndedIdle };
}

async function listAuthAccounts(): Promise<{ users: AuthAccount[]; truncated: boolean }> {
  const users: AuthAccount[] = [];
  for (let page = 1; page <= AUTH_MAX_PAGES; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: AUTH_PAGE_SIZE,
    });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < AUTH_PAGE_SIZE) return { users, truncated: false };
  }
  return { users, truncated: true };
}

async function readAuthAccount(userId: string): Promise<AuthAccount | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return data.user;
}

const PROFILE_COLUMNS = "user_id, account_tier, user_role, account_type, full_name";
// Pas de `stripe_customer_id` : ni la liste ni la prolongation n'en ont besoin.
const SUBSCRIPTION_COLUMNS =
  "user_id, plan_code, status, current_period_end, stripe_subscription_id, metadata, updated_at";

async function readAllProfiles(): Promise<ProfileRow[]> {
  return readAllPages<ProfileRow>((from, to) =>
    supabaseAdmin.from("user_profiles").select(PROFILE_COLUMNS).order("user_id").range(from, to),
  );
}

async function readAllSubscriptions(): Promise<SubscriptionRow[]> {
  return readAllPages<SubscriptionRow>((from, to) =>
    supabaseAdmin
      .from("user_subscriptions")
      .select(SUBSCRIPTION_COLUMNS)
      .order("user_id")
      .range(from, to),
  );
}

async function readProfiles(userIds: string[]): Promise<ProfileRow[]> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select(PROFILE_COLUMNS)
    .in("user_id", userIds);
  if (error) throw error;
  return data ?? [];
}

async function readSubscriptions(userIds: string[]): Promise<SubscriptionRow[]> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .in("user_id", userIds);
  if (error) throw error;
  return data ?? [];
}

/** Lit une table par pages (PostgREST plafonne chaque réponse). */
async function readAllPages<T>(
  read: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += TABLE_PAGE_SIZE) {
    const { data, error } = await read(from, from + TABLE_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < TABLE_PAGE_SIZE) return rows;
  }
}

type TrialInfo = {
  endsAt: string | null;
  /** L'essai est ouvert pour ce compte ; `null` : la base ne le dit pas (migration absente). */
  gateOpen: boolean | null;
};

/**
 * Fin de l'essai de chaque compte et « l'essai est ouvert pour lui » (`get_signup_trial`, même règle
 * que les droits en base ; avant la migration 20261108130100, `get_signup_trial_end` seule). Une
 * lecture en échec laisse le compte sans essai connu, sans faire échouer la page.
 */
async function readTrialEnds(userIds: string[]): Promise<Map<string, TrialInfo>> {
  const ends = new Map<string, TrialInfo>();
  for (let start = 0; start < userIds.length; start += TRIAL_READ_CONCURRENCY) {
    const batch = userIds.slice(start, start + TRIAL_READ_CONCURRENCY);
    const reads = await Promise.all(
      batch.map(async (userId) => [userId, await readTrialInfo(userId)] as const),
    );
    for (const [userId, trial] of reads) ends.set(userId, trial);
  }
  return ends;
}

async function readTrialInfo(userId: string): Promise<TrialInfo> {
  const unknown: TrialInfo = { endsAt: null, gateOpen: null };
  const trialWindow = await supabaseAdmin.rpc("get_signup_trial", { p_user_id: userId });
  if (!trialWindow.error) {
    const row = Array.isArray(trialWindow.data) ? trialWindow.data[0] : null;
    return { endsAt: row?.ends_at || null, gateOpen: row ? row.gate_open === true : null };
  }
  if (!isMissingRpcError(trialWindow.error)) {
    return logTrialReadError(userId, trialWindow.error, unknown);
  }

  const { data, error } = await supabaseAdmin.rpc("get_signup_trial_end", { p_user_id: userId });
  if (error) {
    return isMissingRpcError(error) ? unknown : logTrialReadError(userId, error, unknown);
  }
  return { endsAt: typeof data === "string" && data ? data : null, gateOpen: null };
}

function logTrialReadError(userId: string, error: { message: string }, fallback: TrialInfo) {
  console.error(JSON.stringify({ scope: "admin.signups.trial", userId, error: error.message }));
  return fallback;
}

/**
 * Usage et fin d'essai de chaque compte (`admin_signup_usage`, une lecture). Une lecture en échec, ou la
 * fonction absente (migration pas encore appliquée), rend `null` : les colonnes disent « non mesuré » et la
 * page reste utilisable.
 */
async function readSignupUsage(): Promise<Map<
  string,
  { usage: AdminSignupUsage; trialEndsAt: string | null }
> | null> {
  let result;
  try {
    result = await supabaseAdmin.rpc("admin_signup_usage");
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "admin.signups.usage",
        error: error instanceof Error ? error.message : "lecture impossible",
      }),
    );
    return null;
  }
  const { data, error } = result;
  if (error) {
    if (!isMissingRpcError(error)) {
      console.error(JSON.stringify({ scope: "admin.signups.usage", error: error.message }));
    }
    return null;
  }
  if (!Array.isArray(data)) return null;
  return new Map(
    data.map((row) => [
      row.user_id,
      {
        usage: {
          unlocks: row.unlocks,
          ceilings: row.ceilings,
          favorites: row.favorites,
          sheetsServed: row.sheets_served,
        },
        trialEndsAt: row.trial_ends_at ?? null,
      },
    ]),
  );
}

function jsonObject(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
