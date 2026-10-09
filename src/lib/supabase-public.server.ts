import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Anonymous Supabase client for server components, sitemap and metadata.
 *
 * It uses only the publishable (anon) key: every read goes through the same
 * RLS policies, views and RPC as a signed-out visitor. It never carries a
 * session and must not be used for anything that depends on the viewer.
 */
function firstFilledEnv(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

export function createPublicSupabaseClient(env: NodeJS.ProcessEnv = process.env) {
  const url = firstFilledEnv(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL);
  const key = firstFilledEnv(
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  if (!url || !key) return null;

  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type PublicSupabaseClient = NonNullable<ReturnType<typeof createPublicSupabaseClient>>;
