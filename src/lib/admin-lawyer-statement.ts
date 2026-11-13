import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
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
  await assertAdminAuth(authToken);

  const validMonth = lawyerStatementMonthSchema.parse(month);
  const { data, error } = await supabaseAdmin.rpc("admin_lawyer_monthly_statement", {
    p_month: lawyerStatementMonthStart(validMonth),
  });
  if (error) throw error;
  return parseLawyerStatement(validMonth, data);
}
