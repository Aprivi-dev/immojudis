import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/*
 * Lecture du journal des envois (`email_send_log`) pour l'onglet Envois de l'agent d'information.
 * Affichage seulement : seule la liste des missions (`listAdminInformationAgentMissions`) l'importe, et
 * aucune règle d'envoi, aucun garde-fou ni aucun registre de contacts ne lit ce module
 * (`email-delivery-log.test.ts` le vérifie).
 */

/**
 * État de livraison des messages de la page au journal des envois (`email_send_log`), en une requête pour
 * toute la page : l'identifiant Resend, le statut et le type de rebond, jamais l'adresse ni l'objet. Une
 * lecture en échec laisse les lignes sans état de remise (jamais un échec de la liste).
 */
export async function loadDeliveryLog(
  emailIds: string[],
): Promise<Map<string, { status: string; bounce_type: string | null }>> {
  const log = new Map<string, { status: string; bounce_type: string | null }>();
  const uniqueIds = [...new Set(emailIds)];
  if (!uniqueIds.length) return log;
  const { data, error } = await supabaseAdmin
    .from("email_send_log")
    .select("resend_email_id,status,bounce_type")
    .in("resend_email_id", uniqueIds);
  if (error) {
    console.warn("Journal des envois illisible pour les missions de l'agent", {
      code: error.code ?? null,
    });
    return log;
  }
  for (const row of data ?? []) {
    if (row.resend_email_id) {
      log.set(row.resend_email_id, { status: row.status, bounce_type: row.bounce_type });
    }
  }
  return log;
}
