import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { errorDetailForLog } from "@/lib/api-errors";
import {
  readUserEmail,
  resolveEmailAlertDeliveryConfig,
  sendResendEmail,
  type EmailAlertDeliveryConfig,
} from "@/lib/email-alerts";
import { trialEndEmailMode, type EmailFeatureMode } from "@/lib/email-feature-mode";
import { parisDateKey } from "@/lib/sale-countdown";
import { buildTrialEndMessage } from "@/lib/trial-end-email";

/**
 * Envoi de l'email unique de fin d'essai (J+5), appelé chaque jour par `/api/cron/trial-end-email`.
 *
 * Interrupteur `TRIAL_END_EMAIL_MODE` (voir `email-feature-mode.ts`) :
 * - `off` (défaut, et toute valeur inconnue) : le passage réussit sans rien lire ni envoyer ;
 * - `internal` : un message d'exemple, objet « [Test interne] », à chaque administrateur, une fois par
 *   jour au plus. Aucun compte réel n'est lu ni écrit : c'est pour vérifier le rendu et la remise ;
 * - `on` : aux comptes de la file `get_trial_end_notice_queue` (essai qui se termine dans les deux
 *   jours, pas encore prévenus, non désinscrits).
 *
 * Un compte n'est prévenu qu'une fois par fin d'essai : la réservation `claim_launch_offer_end_notice`
 * (journal `launch_offer_end_notices`, clé compte + jour de fin) est prise AVANT l'envoi, comme celle du
 * récapitulatif hebdomadaire. Un échec reste dans le journal (`failed`, code fermé) et la file le
 * reprend dans les 23 heures, trois essais au plus ; la clé d'idempotence de Resend évite le doublon si
 * la réponse s'est perdue. La désinscription (lien du message) ajoute le compte à
 * `launch_offer_end_notice_optouts`, que la file exclut.
 *
 * Le passage échoue (donc la supervision le voit) quand des envois ont échoué, que le délai l'a
 * interrompu, ou qu'un envoi est dû alors que Resend n'est pas configuré.
 */

const PAGE_LIMIT = 200;
/** Marge sous les 60 s de la route : le passage s'arrête de lui-même et échoue pour être vu. */
export const TRIAL_END_BUDGET_MS = 50_000;

export type TrialEndNoticeSummary = {
  mode: EmailFeatureMode;
  /** Comptes à qui un message est dû (file, ou administrateurs en mode `internal`). */
  due: number;
  sent: number;
  failed: number;
  /** Déjà réservés ou envoyés par un passage précédent, ou désinscrits entre-temps. */
  skipped: number;
  /** Essais épuisés ou trop anciens : un message a pu partir sans qu'on le sache (journal Resend). */
  needsReview: number;
  configured: boolean;
  interrupted: boolean;
};

type Recipient = { userId: string; endsAt: string; endsOn: string };

function emptySummary(mode: EmailFeatureMode): TrialEndNoticeSummary {
  return {
    mode,
    due: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    needsReview: 0,
    configured: true,
    interrupted: false,
  };
}

function isRecipient(
  value: unknown,
): value is { user_id: string; ends_at: string; ends_on: string } {
  const row = value as Record<string, unknown> | null;
  return (
    typeof row === "object" &&
    row !== null &&
    typeof row.user_id === "string" &&
    typeof row.ends_at === "string" &&
    typeof row.ends_on === "string"
  );
}

/** Les comptes à prévenir : la file de la base (`on`), ou les administrateurs avec une fin d'essai fictive. */
async function loadRecipients(
  mode: "internal" | "on",
  now: Date,
): Promise<{ recipients: Recipient[]; needsReview: number }> {
  if (mode === "internal") {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("user_role", "admin");
    if (error) throw error;
    // Fin d'essai fictive dans deux jours ; la clé du journal est le jour du test, donc un seul
    // message d'exemple par administrateur et par jour.
    const endsAt = new Date(now.getTime() + 2 * 86_400_000).toISOString();
    const today = parisDateKey(now);
    return {
      recipients: (data ?? []).map((row) => ({ userId: row.user_id, endsAt, endsOn: today })),
      needsReview: 0,
    };
  }
  const { data, error } = await supabaseAdmin.rpc("get_trial_end_notice_queue", {
    p_limit: PAGE_LIMIT,
    p_now: now.toISOString(),
  });
  if (error) throw error;
  const queue = (data ?? {}) as { recipients?: unknown; needs_review?: unknown };
  const rows = Array.isArray(queue.recipients) ? queue.recipients.filter(isRecipient) : [];
  return {
    recipients: rows.map((row) => ({
      userId: row.user_id,
      endsAt: row.ends_at,
      endsOn: row.ends_on,
    })),
    needsReview: typeof queue.needs_review === "number" ? queue.needs_review : 0,
  };
}

async function markNotice(
  recipient: Recipient,
  patch:
    | { status: "sent"; message_id: string | null; sent_at: string }
    | { status: "failed"; error: "email_unavailable" | "send_failed" },
  now: Date,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("launch_offer_end_notices")
    .update({ ...patch, updated_at: now.toISOString() })
    .eq("user_id", recipient.userId)
    .eq("ends_on", recipient.endsOn);
  if (error) {
    // Le message est parti (ou a échoué) : on ne le rejoue pas pour autant, la réservation reste.
    console.warn(
      JSON.stringify({
        scope: "trial-end-notices",
        event: "journal_update_failed",
        status: patch.status,
        error: errorDetailForLog(error),
      }),
    );
  }
}

export async function runTrialEndNotices({
  mode = trialEndEmailMode(),
  now = new Date(),
  fetchImpl = fetch,
  config = resolveEmailAlertDeliveryConfig(),
  budgetMs = TRIAL_END_BUDGET_MS,
}: {
  mode?: EmailFeatureMode;
  now?: Date;
  fetchImpl?: typeof fetch;
  config?: EmailAlertDeliveryConfig;
  budgetMs?: number;
} = {}): Promise<TrialEndNoticeSummary> {
  const summary = emptySummary(mode);
  if (mode === "off") return summary;

  const { recipients, needsReview } = await loadRecipients(mode, now);
  summary.due = recipients.length;
  summary.needsReview = needsReview;
  if (recipients.length === 0) return summary;

  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) {
    summary.configured = false;
    return summary;
  }

  const startedAt = Date.now();
  for (const recipient of recipients) {
    if (Date.now() - startedAt > budgetMs) {
      summary.interrupted = true;
      break;
    }
    try {
      const { data: claimed, error: claimError } = await supabaseAdmin.rpc(
        "claim_launch_offer_end_notice",
        { p_user_id: recipient.userId, p_ends_on: recipient.endsOn, p_now: now.toISOString() },
      );
      if (claimError) throw claimError;
      if (claimed !== true) {
        summary.skipped += 1;
        continue;
      }
      const email = await readUserEmail(recipient.userId);
      if (!email) {
        await markNotice(recipient, { status: "failed", error: "email_unavailable" }, now);
        summary.failed += 1;
        continue;
      }
      const message = await buildTrialEndMessage({
        userId: recipient.userId,
        endsAt: recipient.endsAt,
        recipientEmail: email,
        from: config.from,
        appUrl: config.appUrl,
        internal: mode === "internal",
        now,
      });
      try {
        const result = await sendResendEmail({
          apiKey: config.apiKey,
          message,
          idempotencyKey: `immojudis-launch-offer-end-${recipient.userId}-${recipient.endsOn}`,
          fetchImpl,
          category: "launch_offer_end",
        });
        await markNotice(
          recipient,
          { status: "sent", message_id: result.id, sent_at: now.toISOString() },
          now,
        );
        summary.sent += 1;
      } catch (sendError) {
        await markNotice(recipient, { status: "failed", error: "send_failed" }, now);
        summary.failed += 1;
        console.warn(
          JSON.stringify({
            scope: "trial-end-notices",
            event: "send_failed",
            error: errorDetailForLog(sendError),
          }),
        );
      }
    } catch (error) {
      // Réservation ou lecture impossible : le compte reste dû, le passage suivant le reprend.
      summary.failed += 1;
      console.warn(
        JSON.stringify({
          scope: "trial-end-notices",
          event: "claim_failed",
          error: errorDetailForLog(error),
        }),
      );
    }
  }
  return summary;
}

/** Fait échouer le passage (donc la supervision) quand il n'est pas allé au bout. */
export function assertTrialEndNoticesComplete(summary: TrialEndNoticeSummary): void {
  if (!summary.configured) {
    throw new Error(
      `Fin d'essai : ${summary.due} message(s) dû(s) mais Resend n'est pas configuré (RESEND_API_KEY, ALERT_EMAIL_FROM, SITE_URL).`,
    );
  }
  if (summary.failed > 0) {
    throw new Error(`Fin d'essai : ${summary.failed} envoi(s) en échec sur ${summary.due}.`);
  }
  if (summary.interrupted) {
    throw new Error("Fin d'essai : passage interrompu par le délai, la suite sera reprise.");
  }
}
