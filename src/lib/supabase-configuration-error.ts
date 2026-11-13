import { ConfigurationError } from "@/lib/api-errors";
import { serverEnv } from "@/lib/env";

/**
 * The one error of a missing Supabase setting (`missing`: the variables to define), logged here.
 * A `ConfigurationError`: the response says « Service temporairement indisponible. ».
 */
export function supabaseConfigurationError(missing: readonly string[]): ConfigurationError {
  const message = `Missing Supabase environment variable(s): ${missing.join(", ")}. Configure these variables in Vercel or your local environment.`;
  console.error(`[Supabase] ${message}`);
  return new ConfigurationError(message);
}

/** Same error for the anonymous server client, when `createPublicSupabaseClient()` answered `null`. */
export function publicSupabaseConfigurationError(): ConfigurationError {
  const { publicUrl, publishableKey } = serverEnv().supabase;
  return supabaseConfigurationError([
    ...(!publicUrl ? ["NEXT_PUBLIC_SUPABASE_URL"] : []),
    ...(!publishableKey ? ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] : []),
  ]);
}
