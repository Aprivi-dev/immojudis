import { unstable_cache } from "next/cache";
import {
  mapPublicTribunalActivity,
  type PublicTribunalActivity,
  type PublicTribunalActivityRow,
} from "@/lib/public-tribunal-activity";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

export const PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS = 3_600;

async function readPublicTribunalActivity(): Promise<PublicTribunalActivity[]> {
  const client = createPublicSupabaseClient();
  if (!client) return [];
  const { data, error } = await client.rpc("get_public_tribunal_activity");
  if (error) throw error;
  return mapPublicTribunalActivity((data ?? []) as PublicTribunalActivityRow[]);
}

const cachedPublicTribunalActivity = unstable_cache(
  readPublicTribunalActivity,
  ["public-tribunal-activity", "v1"],
  { revalidate: PUBLIC_TRIBUNAL_ACTIVITY_REVALIDATE_SECONDS, tags: ["public-tribunal-activity"] },
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
