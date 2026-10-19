import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { LAUNCH_OFFER_CACHE_SECONDS } from "@/lib/launch-offer";

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

type Cached = { active: boolean; expiresAt: number };
let cached: Cached | null = null;
let inflight: Promise<boolean> | null = null;

export async function isLaunchOfferActive(now: number = Date.now()): Promise<boolean> {
  if (cached && cached.expiresAt > now) return cached.active;
  inflight ??= readLaunchOfferStatus().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function readLaunchOfferStatus(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc("get_launch_offer_status");
    if (error) throw error;
    const active = data === true;
    cached = { active, expiresAt: Date.now() + CACHE_MS };
    return active;
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "launch-offer.status",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    cached = { active: false, expiresAt: Date.now() + FAILURE_RETRY_MS };
    return false;
  }
}

/** Oublie la lecture en mémoire (après un changement par l'administrateur, et dans les tests). */
export function resetLaunchOfferCache(): void {
  cached = null;
  inflight = null;
  confirmedEmails.clear();
}

/**
 * Durée pendant laquelle une adresse email confirmée reste en mémoire. Une confirmation ne se défait
 * pas : seule une lecture « confirmée » est gardée, une lecture « non confirmée » est toujours relue
 * (le compte peut confirmer à tout moment), et une erreur n'est jamais gardée.
 */
const CONFIRMED_EMAIL_CACHE_MS = 10 * 60_000;
const CONFIRMED_EMAIL_CACHE_MAX = 1_000;
const confirmedEmails = new Map<string, number>();

/**
 * Le compte a confirmé son adresse email (`auth.users.email_confirmed_at`). L'offre de lancement
 * l'exige, comme `app_private.launch_offer_account_eligible` côté base : sans cela, un compte créé avec une
 * adresse jetable ou inventée aurait les avantages Analyse. Fermé en cas d'erreur, comme la lecture
 * de l'état de l'offre : l'accès normal (abonnement, premium, administrateur) n'en dépend pas.
 */
export async function hasConfirmedEmail(
  userId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const cachedUntil = confirmedEmails.get(userId);
  if (cachedUntil && cachedUntil > now) return true;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw error;
    const confirmed = Boolean(data?.user?.email_confirmed_at);
    if (confirmed) {
      if (confirmedEmails.size >= CONFIRMED_EMAIL_CACHE_MAX) confirmedEmails.clear();
      confirmedEmails.set(userId, now + CONFIRMED_EMAIL_CACHE_MS);
    }
    return confirmed;
  } catch (error) {
    console.error(
      JSON.stringify({
        scope: "launch-offer.email-confirmation",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}
