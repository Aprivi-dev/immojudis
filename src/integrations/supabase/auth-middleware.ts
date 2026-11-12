import { createClient } from "@supabase/supabase-js";
import type { AccountTier, UserRole } from "@/lib/account";
import { isAdminMfaRequired, sessionAssuranceLevel } from "@/lib/admin-mfa";
import { AuthRequiredError, PublicApiError } from "@/lib/api-errors";
import { serverEnv } from "@/lib/env";
import { supabaseConfigurationError } from "@/lib/supabase-configuration-error";
import type { Database } from "./types";

type Claims = Record<string, unknown> & {
  sub?: string;
  email?: string;
};

export type SupabaseAuthContext = {
  supabase: ReturnType<typeof createClient<Database>>;
  userId: string;
  claims: Claims;
  /** Niveau enregistré sur le profil (`premium` : accordé à la main). Ne dit rien de l'offre de lancement. */
  accountTier: AccountTier;
  userRole: UserRole;
  isAdmin: boolean;
  /**
   * Le compte a une ligne `user_profiles` (toujours le cas après l'inscription). Faux : le compte
   * ne bénéficie pas de l'offre de lancement, comme dans `app_private.has_active_analysis_access`.
   * Absent : traité comme vrai (contextes construits par les jobs et les tests).
   */
  hasProfile?: boolean;
};

/** URL and publishable key of the user-session client (`serverEnv().supabase`). */
function supabaseSessionEnv() {
  const { adminUrl: SUPABASE_URL, sessionPublishableKey: SUPABASE_PUBLISHABLE_KEY } =
    serverEnv().supabase;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw supabaseConfigurationError([
      ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY ? ["SUPABASE_PUBLISHABLE_KEY"] : []),
    ]);
  }
  return { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY };
}

export function bearerTokenFromRequest(request: Request): string {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) throw new AuthRequiredError("Unauthorized: No authorization header provided");
  if (!authHeader.startsWith("Bearer ")) {
    throw new AuthRequiredError("Unauthorized: Only Bearer tokens are supported");
  }
  const token = authHeader.replace("Bearer ", "");
  if (!token) throw new AuthRequiredError("Unauthorized: No token provided");
  return token;
}

export async function requireSupabaseAuthContext(token: string): Promise<SupabaseAuthContext> {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = supabaseSessionEnv();
  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  // The SDK can throw during JWT validation (notably for an expired exp claim),
  // rather than returning its usual { data, error } result.
  const { data, error } = await supabase.auth.getClaims(token).catch((cause: unknown) => {
    throw new AuthRequiredError("Unauthorized: Invalid token", { cause });
  });
  if (error || !data?.claims) {
    throw new AuthRequiredError("Unauthorized: Invalid token");
  }

  const claims = data.claims as Claims;
  if (!claims.sub) {
    throw new AuthRequiredError("Unauthorized: No user ID found in token");
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("account_tier,user_role")
    .eq("user_id", claims.sub)
    .maybeSingle();

  if (profileError) {
    // Keep the database detail in the server logs. The token is valid: a failed read of the
    // profile is an outage (503, retryable), not an expired session (401) that would sign the
    // user out.
    console.error(
      JSON.stringify({
        scope: "auth.profile",
        error: profileError.message ?? String(profileError),
      }),
    );
    throw new PublicApiError(
      "Service temporairement indisponible. Réessayez dans un instant.",
      503,
    );
  }

  const accountTier: AccountTier = profile?.account_tier === "premium" ? "premium" : "free";
  const userRole: UserRole = profile?.user_role === "admin" ? "admin" : "user";

  return {
    supabase,
    userId: claims.sub,
    claims,
    accountTier,
    userRole,
    hasProfile: profile != null,
    // With ADMIN_MFA_REQUIRED=true an administrator only keeps admin rights on an aal2 session
    // (TOTP verified); an aal1 session is treated like a regular account.
    isAdmin:
      userRole === "admin" && (!isAdminMfaRequired() || sessionAssuranceLevel(claims) === "aal2"),
  };
}
