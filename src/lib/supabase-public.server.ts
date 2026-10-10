import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { serverEnv, type EnvSource } from "@/lib/env";

/**
 * Anonymous Supabase client for server components, sitemap and metadata.
 *
 * It uses only the publishable (anon) key: every read goes through the same
 * RLS policies, views and RPC as a signed-out visitor. It never carries a
 * session and must not be used for anything that depends on the viewer.
 */
export function createPublicSupabaseClient(env?: EnvSource) {
  const { publicUrl: url, publishableKey: key } = serverEnv(env).supabase;
  if (!url || !key) return null;

  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type PublicSupabaseClient = NonNullable<ReturnType<typeof createPublicSupabaseClient>>;
