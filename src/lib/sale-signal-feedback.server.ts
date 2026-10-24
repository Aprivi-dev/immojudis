import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog } from "@/lib/api-errors";
import type { SaleSignalFeedbackInput } from "@/lib/sale-signal-feedback";

const uuidSchema = z.string().guid();

/**
 * Enregistre ou corrige le retour du jour d'un compte sur un signal d'une vente
 * (`record_sale_signal_feedback`, migration 20261030110100). La base arbitre : un seul retour par compte,
 * vente, signal et jour (le motif corrige la ligne du jour), vente publique seulement, 100 retours au plus
 * par compte et par jour.
 *
 * Rend vrai quand le retour est écrit, faux quand la base le refuse (vente hors du catalogue public,
 * plafond du jour) ou sans compte valide. Une panne LÈVE : l'appelant répond alors par une erreur, la
 * personne sait que son retour n'est pas parti. Aucune donnée n'est journalisée.
 */
export async function recordSaleSignalFeedback(
  userId: string | null | undefined,
  saleId: string,
  input: SaleSignalFeedbackInput,
): Promise<boolean> {
  const user = uuidSchema.safeParse(userId);
  const sale = uuidSchema.safeParse(saleId);
  if (!user.success || !sale.success) return false;

  const { data, error } = await supabaseAdmin.rpc("record_sale_signal_feedback", {
    p_user_id: user.data,
    p_sale_id: sale.data.toLowerCase(),
    p_signal: input.signal,
    p_value: input.value,
    ...(input.reason ? { p_reason: input.reason } : {}),
  });
  if (error) {
    console.warn(
      JSON.stringify({
        scope: "sale-signal-feedback",
        signal: input.signal,
        error: errorDetailForLog(error),
      }),
    );
    throw error;
  }
  return data === true;
}
