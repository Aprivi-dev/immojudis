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

/**
 * Public figures of the courts, shared by every visitor and cached for an hour.
 * An unavailable database (or a function not deployed yet) yields an empty list:
 * the page then shows the Analyse barometer alone, as before.
 */
export async function loadPublicTribunalActivity(): Promise<PublicTribunalActivity[]> {
  try {
    return await cachedPublicTribunalActivity();
  } catch (error) {
    console.warn("[tribunaux] Activité publique indisponible:", error);
    return [];
  }
}
