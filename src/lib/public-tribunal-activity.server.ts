import { unstable_cache } from "next/cache";
import {
  mapPublicTribunalActivity,
  type PublicTribunalActivity,
  type PublicTribunalActivityRow,
  type PublicTribunalPriceFigureRow,
} from "@/lib/public-tribunal-activity";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

export const PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS = 3_600;
/** Étiquette du cache de données de l'activité des tribunaux (purgée par `revalidate-sale`). */
export const PUBLIC_TRIBUNAL_ACTIVITY_CACHE_TAG = "public-tribunal-activity";

async function readPublicTribunalActivity(): Promise<PublicTribunalActivity[]> {
  const client = createPublicSupabaseClient();
  if (!client) return [];
  const [activity, figures] = await Promise.all([
    client.rpc("get_public_tribunal_activity"),
    client.rpc("get_public_tribunal_price_figures"),
  ]);
  if (activity.error) throw activity.error;
  // Les chiffres de prix soumis aux seuils sont un plus : sans eux (fonction pas encore déployée,
  // panne passagère), la liste reste servie avec la médiane d'avant, sans fourchette.
  if (figures.error) {
    console.warn("[tribunaux] Chiffres de prix indisponibles:", figures.error.message);
  }
  return mapPublicTribunalActivity(
    (activity.data ?? []) as PublicTribunalActivityRow[],
    figures.error ? null : ((figures.data ?? []) as PublicTribunalPriceFigureRow[]),
  );
}

const cachedPublicTribunalActivity = unstable_cache(
  readPublicTribunalActivity,
  ["public-tribunal-activity", "v2"],
  {
    revalidate: PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS,
    tags: [PUBLIC_TRIBUNAL_ACTIVITY_CACHE_TAG],
  },
);

/** How long a failed read is remembered before the database is asked again. */
export const PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS = 5 * 60_000;

/**
 * An empty list is an answer ("no court has an upcoming sale"); an error is not. Callers
 * must not treat the second like the first: it would remove the page from the index and the
 * sitemap because of a passing outage.
 */
export type PublicTribunalActivityResult =
  | { status: "ok"; items: PublicTribunalActivity[] }
  | { status: "error" };

// Per server instance: while the function is missing or the database is down, every request
// (page, metadata, sitemap) would otherwise repeat the failing call. Successes are cached an
// hour by `unstable_cache`, which never stores a thrown error.
let lastFailureAt: number | null = null;

/**
 * Public figures of the courts, shared by every visitor and cached for an hour.
 * An unavailable database (or a function not deployed yet) yields `{ status: "error" }`,
 * and the failure is remembered for a few minutes so the database is not hit again
 * by every request: the page then shows the Analyse barometer alone, as before.
 */
export async function loadPublicTribunalActivity(
  now: number = Date.now(),
): Promise<PublicTribunalActivityResult> {
  if (lastFailureAt !== null && now - lastFailureAt < PUBLIC_TRIBUNAL_ACTIVITY_FAILURE_RETRY_MS) {
    return { status: "error" };
  }
  try {
    const items = await cachedPublicTribunalActivity();
    lastFailureAt = null;
    return { status: "ok", items };
  } catch (error) {
    lastFailureAt = now;
    console.warn("[tribunaux] Activité publique indisponible:", error);
    return { status: "error" };
  }
}
