import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LAUNCH_OFFER_CACHE_SECONDS } from "@/lib/launch-offer";
import { isMissingRpcError } from "@/lib/postgrest-errors";

/**
 * État de l'offre de lancement, lu dans la base (RPC `get_launch_offer_status`, rôle service_role)
 * et gardé en mémoire du processus `LAUNCH_OFFER_CACHE_SECONDS` secondes : une coupure se voit au
 * plus tard une minute plus tard (30 s de ce cache + 30 s du CDN sur `/api/launch-offer`).
 *
 * Fermé en cas d'erreur : si la base ne répond pas, personne n'est surclassé sur une supposition
 * (la base, elle, refuserait de toute façon l'accès aux données). L'échec n'est mémorisé que
 * `FAILURE_RETRY_MS`, pour que l'offre revienne dès que la base répond.
 */
const CACHE_MS = LAUNCH_OFFER_CACHE_SECONDS * 1000;
const FAILURE_RETRY_MS = 5_000;

/**
 * `degraded` : la valeur `false` vient d'une erreur de lecture et non de la base. La route publique
 * ne la laisse pas mettre en cache par le CDN (une erreur de 5 s y resterait 30 s).
 */
export type LaunchOfferState = { active: boolean; degraded: boolean };

type Cached = LaunchOfferState & { expiresAt: number };
let cached: Cached | null = null;
let inflight: Promise<LaunchOfferState> | null = null;
// Numéro de génération : `resetLaunchOfferCache` l'incrémente, et une lecture commencée avant ne
// peut plus écrire son résultat (sinon une lecture déjà en vol effacerait la valeur qui suit un
// changement de l'administrateur).
let generation = 0;

export async function readLaunchOfferState(now: number = Date.now()): Promise<LaunchOfferState> {
  if (cached && cached.expiresAt > now) {
    return { active: cached.active, degraded: cached.degraded };
  }
  if (!inflight) {
    const read = readLaunchOfferStatus().finally(() => {
      // Une lecture périmée ne doit pas effacer la lecture plus récente qui l'a remplacée.
      if (inflight === read) inflight = null;
    });
    inflight = read;
  }
  return inflight;
}

export async function isLaunchOfferActive(now: number = Date.now()): Promise<boolean> {
  return (await readLaunchOfferState(now)).active;
}

async function readLaunchOfferStatus(): Promise<LaunchOfferState> {
  const startedIn = generation;
  const remember = (state: LaunchOfferState, ttlMs: number) => {
    if (startedIn === generation) cached = { ...state, expiresAt: Date.now() + ttlMs };
  };
  try {
    const { data, error } = await supabaseAdmin.rpc("get_launch_offer_status");
    if (error) throw error;
    const state = { active: data === true, degraded: false };
    remember(state, CACHE_MS);
    return state;
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "launch-offer.status",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const state = { active: false, degraded: true };
    remember(state, FAILURE_RETRY_MS);
    return state;
  }
}

/** Oublie la lecture en mémoire (après un changement par l'administrateur, et dans les tests). */
export function resetLaunchOfferCache(): void {
  generation += 1;
  cached = null;
  inflight = null;
  eligibilityReads.clear();
  fallbackWarned = false;
}

/**
 * Essai gratuit de 7 jours à l'inscription (l'« offre de lancement » depuis le 25/10/2026 : mêmes
 * interrupteur et garde-fous, éligibilité limitée à 7 jours après la confirmation de l'adresse).
 *
 * `active` : l'essai du compte est en cours. `endsAt` : sa fin (ISO), même passée, ou `null` si le
 * compte n'a pas droit à l'essai (pas d'adresse confirmée, adresse jetable, ou un compte plus ancien
 * de la même adresse canonique l'a déjà eu). `denied` : la base a répondu « pas d'essai » (jamais
 * après une erreur ni par l'ancienne règle).
 */
export type SignupTrial = { active: boolean; endsAt: string | null; denied?: true };

/**
 * Durées de garde, par compte, de la dernière lecture :
 * - avec une date de fin, 10 minutes : la date ne bouge pas (la confirmation ne se défait pas), et
 *   « en cours » se recalcule à chaque appel contre l'heure, donc l'essai se ferme à l'heure dite ;
 * - sans essai, 30 secondes : le compte peut confirmer son adresse à tout moment, mais sans ce cache
 *   négatif un compte non confirmé ferait une lecture en base à chaque requête ;
 * - une erreur n'est jamais gardée.
 */
const ELIGIBLE_CACHE_MS = 10 * 60_000;
const NOT_ELIGIBLE_CACHE_MS = 30_000;
const ELIGIBILITY_CACHE_MAX = 1_000;
const eligibilityReads = new Map<string, { read: TrialRead; expiresAt: number }>();

/**
 * Lecture en base : `endsAt` (fonction `get_signup_trial_end`), ou, avant la migration
 * 20261103100000, l'ancienne éligibilité sans durée (`fallbackActive`).
 */
type TrialRead = { endsAt: string | null; fallbackActive?: boolean };

const NO_TRIAL: SignupTrial = { active: false, endsAt: null };

/**
 * L'essai du compte, lu dans la base (RPC `get_signup_trial_end`, rôle service_role), qui applique
 * la règle de `app_private.signup_trial_ends_at` : profil, adresse email confirmée, domaine non
 * jetable, plus ancien compte confirmé de son adresse canonique, et 7 jours à compter de la
 * confirmation. Les écrans et les droits en base répondent ainsi pareil, sans seconde copie de la
 * règle. Fermé en cas d'erreur : l'accès normal (abonnement, premium, administrateur) n'en dépend
 * pas.
 *
 * Ordre de déploiement : tant que la migration 20261103100000 n'est pas appliquée (`PGRST202` ou
 * `42883`), la base applique encore l'offre de lancement sans durée ; on lit alors la même règle
 * qu'elle (`get_launch_offer_account_eligibility`, puis l'adresse confirmée avant 20261029110000).
 * Le repli ne s'applique qu'à l'absence de la fonction, jamais à une autre erreur (qui reste fermée).
 */
export async function readSignupTrial(
  userId: string,
  now: number = Date.now(),
): Promise<SignupTrial> {
  const known = eligibilityReads.get(userId);
  if (known && known.expiresAt > now) return trialAt(known.read, now);
  try {
    const read = await readTrialFromDatabase(userId);
    rememberEligibility(userId, read, now);
    return trialAt(read, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "launch-offer.email-confirmation",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return NO_TRIAL;
  }
}

/** L'essai du compte est en cours (voir `readSignupTrial`). */
export async function hasActiveSignupTrial(
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (await readSignupTrial(userId, now)).active;
}

function trialAt(read: TrialRead, now: number): SignupTrial {
  if (read.endsAt) return { active: Date.parse(read.endsAt) > now, endsAt: read.endsAt };
  if (read.fallbackActive === undefined) return { active: false, endsAt: null, denied: true };
  return { active: read.fallbackActive, endsAt: null };
}

async function readTrialFromDatabase(userId: string): Promise<TrialRead> {
  const { data, error } = await supabaseAdmin.rpc("get_signup_trial_end", {
    p_user_id: userId,
  });
  if (!error) return { endsAt: typeof data === "string" && data ? data : null };
  if (!isMissingRpcError(error)) throw error;
  return { endsAt: null, fallbackActive: await readEligibility(userId) };
}

async function readEligibility(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("get_launch_offer_account_eligibility", {
    p_user_id: userId,
  });
  if (!error) return data === true;
  if (!isMissingRpcError(error)) throw error;
  warnEligibilityFallback();
  return readConfirmedEmailFromAuth(userId);
}

/** L'ancienne règle : l'adresse email du compte est confirmée (`auth.users.email_confirmed_at`). */
async function readConfirmedEmailFromAuth(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) throw error;
  return Boolean(data?.user?.email_confirmed_at);
}

let fallbackWarned = false;
function warnEligibilityFallback(): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  console.warn(
    JSON.stringify({
      scope: "launch-offer.eligibility",
      fallback: "auth-email-confirmed",
      reason:
        "get_launch_offer_account_eligibility absente : appliquer la migration 20261029110000",
    }),
  );
}

function rememberEligibility(userId: string, read: TrialRead, now: number): void {
  // Une table pleine perd sa plus ancienne lecture (l'ordre d'insertion d'une Map) au lieu de tout
  // oublier d'un coup : un pic de comptes ne déclenche pas une rafale de lectures en base.
  eligibilityReads.delete(userId);
  while (eligibilityReads.size >= ELIGIBILITY_CACHE_MAX) {
    const oldest = eligibilityReads.keys().next().value;
    if (oldest === undefined) break;
    eligibilityReads.delete(oldest);
  }
  const known = read.endsAt != null || read.fallbackActive === true;
  eligibilityReads.set(userId, {
    read,
    expiresAt: now + (known ? ELIGIBLE_CACHE_MS : NOT_ELIGIBLE_CACHE_MS),
  });
}
