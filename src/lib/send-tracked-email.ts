import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendResendEmail } from "@/lib/email-alerts";
import { GENERIC_LOG_SUBJECTS, type SentTemplateKey } from "@/lib/email-templates/keys";

/**
 * Envoi d'un email par Resend ET écriture de sa ligne au journal central (`email_send_log`).
 *
 * C'est le seul module qui appelle `sendResendEmail` (garde : `send-tracked-email.test.ts`). Il exige la
 * clé du gabarit dans le registre (`templateKey`) : un envoi sans gabarit déclaré ne compile pas.
 *
 * - L'écriture du journal est au mieux : un échec est tracé (sans adresse) mais n'annule ni ne retarde
 *   l'envoi, déjà parti. Le journal n'est jamais une condition d'envoi.
 * - Rejoué avec la même clé d'idempotence, Resend rend le même identifiant et la ligne est complétée
 *   (upsert), jamais dupliquée, sans faire reculer son statut de livraison.
 * - Aucun corps n'est enregistré. L'objet est remplacé par un objet générique pour les gabarits
 *   personnalisés avec des données de tiers (`GENERIC_LOG_SUBJECTS`).
 */
export type TrackedEmailMode = "on" | "internal" | "test" | "manual" | "autopilot";

export type SendTrackedEmailInput = Parameters<typeof sendResendEmail>[0] & {
  /** Clé du gabarit dans le registre (`src/lib/email-templates`). */
  templateKey: SentTemplateKey;
  /** `on` (défaut) : envoi normal ; `internal` : adresse interne ; `test` : essai ; `manual` : déclenché à la main ; `autopilot` : envoi du pilote automatique de l'agent. */
  mode?: TrackedEmailMode;
  /** Compte destinataire, quand le destinataire en a un. La ligne est effacée avec lui. */
  userId?: string | null;
};

async function writeSendLog(
  input: SendTrackedEmailInput,
  resendEmailId: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("record_email_send", {
    p_resend_email_id: resendEmailId ?? "",
    p_template_key: input.templateKey,
    p_category: input.category,
    p_mode: input.mode ?? "on",
    p_user_id: input.userId ?? undefined,
    p_from: input.message.from,
    p_to: input.message.to,
    p_subject: GENERIC_LOG_SUBJECTS[input.templateKey] ?? input.message.subject,
  });
  if (error) throw error;
}

export async function sendTrackedEmail(
  input: SendTrackedEmailInput,
): Promise<{ id: string | null }> {
  const { apiKey, message, idempotencyKey, fetchImpl, category } = input;
  const result = await sendResendEmail({ apiKey, message, idempotencyKey, fetchImpl, category });
  try {
    await writeSendLog(input, result.id);
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "email-send-log",
        level: "warn",
        event: "write_failed",
        templateKey: input.templateKey,
        errorName: error instanceof Error ? error.name : "Error",
      }),
    );
  }
  return result;
}
