import "server-only";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { AdminRequiredError } from "@/lib/api-errors";

/**
 * Garde des modules et routes d'administration : jeton de session vérifié, rôle administrateur et
 * double authentification (`auth.isAdmin`). Lève `AdminRequiredError` (403) sinon.
 */
export async function assertAdminAuth(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  assertAdmin(auth);
  return auth;
}

/** Même garde pour un contexte d'authentification déjà résolu par l'appelant. */
export function assertAdmin(auth: { isAdmin: boolean }): void {
  if (!auth.isAdmin) throw new AdminRequiredError();
}
