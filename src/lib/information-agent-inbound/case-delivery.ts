import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

/**
 * État de remise d'un message de l'agent, porté par son dossier et sa mission
 * (`metadata.delivery = { status, at }`), repéré par l'identifiant Resend du message.
 *
 * - `bounced` : rebond définitif. Le dossier ne compte plus comme « déjà sollicité » : la vente redevient
 *   éligible pour un autre destinataire (la file de l'agent, `admin_information_agent_queue`).
 * - `bounced_temporary` : rebond passager, rien ne change pour la vente (Resend peut retenter).
 * - `complained` : plainte, l'adresse est déjà en opposition (registre des contacts).
 * - `delivered` : message remis (`email.delivered`), seule preuve qu'il a informé son destinataire (« déjà informé »
 *   du pilote). Un rebond arrivé ensuite le remplace ; un rebond passager suivi d'une remise devient « remis ».
 * - `failed` : échec de l'envoi chez le fournisseur (`email.failed`), le message n'est pas parti.
 *
 * `bounce_type` garde le type brut du fournisseur à côté de l'état (onglet Envois : « Rebond passager »
 * seulement pour « transient ») ; aucune décision ne le lit.
 *
 * Ni le statut du dossier ni celui de la mission ne changent : le message est bien parti. Le journal des
 * envois (`email_send_log`) garde le détail de chaque évènement de livraison.
 */
export type CaseDeliveryStatus =
  | "bounced"
  | "bounced_temporary"
  | "complained"
  | "delivered"
  | "failed";

/**
 * Un état plus grave n'est jamais remplacé par un moins grave. « Remis » se place entre le rebond passager (le
 * fournisseur a pu réessayer et remettre) et le rebond définitif (un rebond peut arriver après la remise).
 */
const DELIVERY_RANK: Record<string, number> = {
  failed: 1,
  bounced_temporary: 1,
  delivered: 2,
  bounced: 3,
  complained: 4,
};

const TABLES = ["information_agent_cases", "information_agent_missions"] as const;

export async function markInformationAgentCaseDelivery({
  emailId,
  status,
  at,
  bounceType,
}: {
  emailId: string | null | undefined;
  status: CaseDeliveryStatus;
  at: string;
  bounceType?: string;
}): Promise<number> {
  const id = emailId?.trim();
  if (!id) return 0;
  let marked = 0;
  for (const table of TABLES) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("id,metadata")
      .eq("provider_message_id", id)
      .limit(5);
    if (error) throw error;
    for (const row of data ?? []) {
      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? row.metadata
          : {};
      // Un état déjà posé ne recule jamais (rebond définitif ou plainte, puis évènement passager en retard).
      const delivery = metadata.delivery;
      const current =
        delivery && typeof delivery === "object" && !Array.isArray(delivery)
          ? (delivery as { status?: unknown }).status
          : null;
      if (typeof current === "string" && (DELIVERY_RANK[current] ?? 0) >= DELIVERY_RANK[status]) {
        continue;
      }
      const { error: updateError } = await supabaseAdmin
        .from(table)
        .update({
          metadata: {
            ...metadata,
            delivery: { status, at, ...(bounceType ? { bounce_type: bounceType } : {}) },
          } as Json,
        })
        .eq("id", row.id);
      if (updateError) throw updateError;
      marked += 1;
    }
  }
  return marked;
}
