import "server-only";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  lawyerStatementMonthSchema,
  lawyerStatementMonthStart,
  parseLawyerStatement,
  type LawyerStatement,
} from "@/lib/lawyer-statement";

/**
 * Relevé mensuel des avocats référencés (point 72), lu par `admin_lawyer_monthly_statement`.
 * Même protection que les autres routes admin : jeton de session vérifié, rôle administrateur et
 * double authentification (`auth.isAdmin`), puis lecture avec le client de service. Rien n'est
 * envoyé : le propriétaire exporte le CSV et l'envoie lui-même.
 */
export async function getAdminLawyerStatement(
  authToken: string,
  month: string,
): Promise<LawyerStatement> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  const validMonth = lawyerStatementMonthSchema.parse(month);
  const { data, error } = await supabaseAdmin.rpc("admin_lawyer_monthly_statement", {
    p_month: lawyerStatementMonthStart(validMonth),
  });
  if (error) {
    // Fonction absente : la migration du relevé n'est pas encore appliquée.
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new Error("Le relevé mensuel n'est pas encore disponible : migration à appliquer.");
    }
    throw error;
  }
  return parseLawyerStatement(validMonth, data);
}
