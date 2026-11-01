import "server-only";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";

/**
 * Garde commune des routes `/api/admin/emails/*` : jeton de session vérifié, rôle administrateur et
 * double authentification (`auth.isAdmin`). Les autres modules admin gardent leur copie locale ; elles
 * ne sont pas fusionnées ici.
 */
export async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}
