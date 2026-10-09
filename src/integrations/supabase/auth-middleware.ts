import { createClient } from "@supabase/supabase-js";
import type { AccountTier, UserRole } from "@/lib/account";
import { isAdminMfaRequired, sessionAssuranceLevel } from "@/lib/admin-mfa";
import type { Database } from "./types";

type Claims = Record<string, unknown> & {
  sub?: string;
  email?: string;
};

export type SupabaseAuthContext = {
  supabase: ReturnType<typeof createClient<Database>>;
  userId: string;
  claims: Claims;
  accountTier: AccountTier;
  userRole: UserRole;
  isAdmin: boolean;
};

function supabasePublicEnv() {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY =
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ["SUPABASE_URL"] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY ? ["SUPABASE_PUBLISHABLE_KEY"] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(", ")}. Configure these variables in Vercel or your local environment.`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY };
}

export function bearerTokenFromRequest(request: Request): string {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) throw new Error("Unauthorized: No authorization header provided");
  if (!authHeader.startsWith("Bearer ")) {
    throw new Error("Unauthorized: Only Bearer tokens are supported");
  }
  const token = authHeader.replace("Bearer ", "");
  if (!token) throw new Error("Unauthorized: No token provided");
  return token;
}

export async function requireSupabaseAuthContext(token: string): Promise<SupabaseAuthContext> {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = supabasePublicEnv();
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
    throw new Error("Unauthorized: Invalid token", { cause });
  });
  if (error || !data?.claims) {
    throw new Error("Unauthorized: Invalid token");
  }

  const claims = data.claims as Claims;
  if (!claims.sub) {
    throw new Error("Unauthorized: No user ID found in token");
  }

  const { data: profile, error: profileError } = await supabase
    .from("user_profiles")
    .select("account_tier,user_role")
    .eq("user_id", claims.sub)
    .maybeSingle();

  if (profileError) {
    // Keep the database detail in the server logs; callers only see a generic 401.
    console.error(
      JSON.stringify({
        scope: "auth.profile",
        error: profileError.message ?? String(profileError),
      }),
    );
    throw new Error("Unauthorized: User access profile unavailable");
  }

  const accountTier: AccountTier = profile?.account_tier === "premium" ? "premium" : "free";
  const userRole: UserRole = profile?.user_role === "admin" ? "admin" : "user";

  return {
    supabase,
    userId: claims.sub,
    claims,
    accountTier,
    userRole,
    // With ADMIN_MFA_REQUIRED=true an administrator only keeps admin rights on an aal2 session
    // (TOTP verified); an aal1 session is treated like a regular account.
    isAdmin:
      userRole === "admin" && (!isAdminMfaRequired() || sessionAssuranceLevel(claims) === "aal2"),
  };
}
