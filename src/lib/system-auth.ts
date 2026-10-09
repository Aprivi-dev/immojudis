import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Auth context for background jobs acting on behalf of a user. It carries the
 * user's real tier and role so plan checks give the same answer as when the
 * user is signed in (a premium or admin account is not treated as free).
 */
export async function systemAuthForUser(userId: string): Promise<SupabaseAuthContext> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("account_tier,user_role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  const userRole = data?.user_role === "admin" ? "admin" : "user";
  return {
    supabase: supabaseAdmin,
    userId,
    claims: {},
    accountTier: data?.account_tier === "premium" ? "premium" : "free",
    userRole,
    // Same rule as the request middleware: an admin account has the Analyse plan.
    isAdmin: userRole === "admin",
  };
}
