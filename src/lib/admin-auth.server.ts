import "server-only";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

/**
 * Garde commune des routes `/api/admin/emails/*` : jeton de session vérifié, rôle administrateur et
 * double authentification (`auth.isAdmin`), partagée par tous les modules admin.
 */
export async function requireAdmin(
  authToken: string,
  forbiddenMessage = "Forbidden: accès administrateur requis.",
) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error(forbiddenMessage);
  return auth;
}

export function assertAdminAuth(authToken: string) {
  return requireAdmin(
    authToken,
    "Forbidden: ce compte n'a pas les droits administrateur Immojudis.",
  );
}
