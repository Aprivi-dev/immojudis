import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ConfigurationError } from "@/lib/api-errors";
import { errorDetailForLog } from "@/lib/error-detail-for-log";
import {
  readUserEmail,
  resolveNoReplyEmailConfig,
  type EmailAlertDeliveryConfig,
} from "@/lib/email-alerts";
import { sendTrackedEmail } from "@/lib/send-tracked-email";
import { onboardingEmailMode, type EmailFeatureMode } from "@/lib/email-feature-mode";
import { parisDateKey } from "@/lib/paris-time";
import { buildOnboardingMessage } from "@/lib/onboarding-email";
import { EMAIL_PASS_BUDGET_MS } from "@/lib/email-campaign-pass";

/**
 * Envoi de l'email unique de prise en main, le lendemain de l'inscription, appelé chaque jour par
 * `/api/cron/onboarding-email`. Même architecture que l'email de fin d'essai (`trial-end-notices.ts`).
 *
 * Interrupteur `ONBOARDING_EMAIL_MODE` (voir `email-feature-mode.ts`) :
 * - `off` (défaut, et toute valeur inconnue) : le passage réussit sans rien lire ni envoyer ;
 * - `internal` : un message d'exemple, objet « [Test interne] », à chaque administrateur, une fois par
 *   jour au plus (clé d'idempotence de Resend datée du jour). Aucun compte réel n'est lu, et le journal
 *   n'est pas écrit : sa clé est le compte, un exemple ne doit pas consommer le message d'un compte ;
 * - `on` : aux comptes de la file `get_onboarding_email_queue` (compte créé il y a 24 à 72 heures, sans
 *   accès Analyse, sans déblocage ni achat, non désinscrit, jamais prévenu).
 *
 * Un compte ne reçoit ce message qu'UNE fois : la réservation `claim_onboarding_email` (journal
 * `onboarding_email_notices`, clé = le compte) est prise AVANT l'envoi, et relit l'audience au moment de
 * l'envoi. Un échec reste dans le journal (`failed`, code fermé) et la file le reprend dans les 23 heures
 * du premier essai, trois essais au plus : le cron repasse à 15:30 le même jour quand son passage de
 * 13:30 a échoué. Passé ce délai la ligne n'est plus rejouée (la clé d'idempotence de Resend ne protège
 * d'un doublon que 24 heures) : elle est comptée dans `needsReview`.
 *
 * L'opposition (lien du message) ajoute le compte à `onboarding_email_optouts`, propre à ce message.
 *
 * Le passage échoue (donc la supervision le voit) quand des envois ont échoué, que le délai l'a
 * interrompu, ou qu'un envoi est dû alors que Resend n'est pas configuré.
 */

const PAGE_LIMIT = 200;

export type OnboardingEmailSummary = {
  mode: EmailFeatureMode;
  /** Comptes à qui un message est dû (file, ou administrateurs en mode `internal`). */
  due: number;
  sent: number;
  failed: number;
  /** Déjà réservés ou envoyés par un passage précédent, désinscrits ou sortis de l'audience entre-temps. */
  skipped: number;
  /** Essais épuisés ou trop anciens : un message a pu partir sans qu'on le sache (journal Resend). */
  needsReview: number;
  configured: boolean;
  interrupted: boolean;
};

type Recipient = { userId: string; department: string | null };

function emptySummary(mode: EmailFeatureMode): OnboardingEmailSummary {
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

function isRecipient(value: unknown): value is { user_id: string; department: string | null } {
  const row = value as Record<string, unknown> | null;
  return (
    typeof row === "object" &&
    row !== null &&
    typeof row.user_id === "string" &&
    (row.department === null || typeof row.department === "string")
  );
}

/** Les comptes à prévenir : la file de la base (`on`), ou les administrateurs (`internal`). */
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
    return {
      recipients: (data ?? []).map((row) => ({ userId: row.user_id, department: null })),
      needsReview: 0,
    };
  }
  const { data, error } = await supabaseAdmin.rpc("get_onboarding_email_queue", {
    p_limit: PAGE_LIMIT,
    p_now: now.toISOString(),
  });
  if (error) throw error;
  const queue = (data ?? {}) as { recipients?: unknown; needs_review?: unknown };
  const rows = Array.isArray(queue.recipients) ? queue.recipients.filter(isRecipient) : [];
  return {
    recipients: rows.map((row) => ({ userId: row.user_id, department: row.department })),
    needsReview: typeof queue.needs_review === "number" ? queue.needs_review : 0,
  };
}

async function markNotice(
  userId: string,
  patch:
    | { status: "sent"; message_id: string | null; sent_at: string }
    | { status: "failed"; error: "email_unavailable" | "send_failed" },
  now: Date,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("onboarding_email_notices")
    .update({ ...patch, updated_at: now.toISOString() })
    .eq("user_id", userId);
  if (error) {
    // Le message est parti (ou a échoué) : on ne le rejoue pas pour autant, la réservation reste.
    console.warn(
      JSON.stringify({
        scope: "onboarding-email",
        event: "journal_update_failed",
        status: patch.status,
        error: errorDetailForLog(error),
      }),
    );
  }
}

async function claimNotice(userId: string, now: Date): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("claim_onboarding_email", {
    p_user_id: userId,
    p_now: now.toISOString(),
  });
  if (error) throw error;
  return data === true;
}

/**
 * Le journal d'un passage : la base en mode `on` (réservation avant l'envoi, état après) ; aucun en
 * mode `internal`, dont l'exemple ne réserve ni n'écrit rien (sa clé est le compte : un exemple ne doit
 * pas consommer le message d'un compte). La clé d'idempotence de Resend suit la même règle : le compte
 * pour un vrai message, le compte et le jour pour un exemple.
 */
type Journal = {
  claim: (userId: string, now: Date) => Promise<boolean>;
  mark: typeof markNotice;
  idempotencyKey: (userId: string, now: Date) => string;
};

const JOURNALS: Record<"internal" | "on", Journal> = {
  on: {
    claim: claimNotice,
    mark: markNotice,
    idempotencyKey: (userId) => `immojudis-onboarding-${userId}`,
  },
  internal: {
    claim: async () => true,
    mark: async () => undefined,
    idempotencyKey: (userId, now) => `immojudis-onboarding-internal-${userId}-${parisDateKey(now)}`,
  },
};

export async function runOnboardingEmails({
  mode = onboardingEmailMode(),
  now = new Date(),
  fetchImpl = fetch,
  config = resolveNoReplyEmailConfig(),
  budgetMs = EMAIL_PASS_BUDGET_MS,
}: {
  mode?: EmailFeatureMode;
  now?: Date;
  fetchImpl?: typeof fetch;
  config?: EmailAlertDeliveryConfig;
  budgetMs?: number;
} = {}): Promise<OnboardingEmailSummary> {
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

  const journal = JOURNALS[mode];
  const startedAt = Date.now();
  for (const recipient of recipients) {
    if (Date.now() - startedAt > budgetMs) {
      summary.interrupted = true;
      break;
    }
    try {
      if (!(await journal.claim(recipient.userId, now))) {
        summary.skipped += 1;
        continue;
      }
      const email = await readUserEmail(recipient.userId);
      if (!email) {
        await journal.mark(recipient.userId, { status: "failed", error: "email_unavailable" }, now);
        summary.failed += 1;
        continue;
      }
      const message = buildOnboardingMessage({
        userId: recipient.userId,
        department: recipient.department,
        recipientEmail: email,
        from: config.from,
        appUrl: config.appUrl,
        internal: mode === "internal",
        now,
      });
      try {
        const result = await sendTrackedEmail({
          apiKey: config.apiKey,
          message,
          idempotencyKey: journal.idempotencyKey(recipient.userId, now),
          fetchImpl,
          category: "onboarding",
          templateKey: "onboarding",
          mode,
          userId: recipient.userId,
        });
        await journal.mark(
          recipient.userId,
          { status: "sent", message_id: result.id, sent_at: now.toISOString() },
          now,
        );
        summary.sent += 1;
      } catch (sendError) {
        await journal.mark(recipient.userId, { status: "failed", error: "send_failed" }, now);
        summary.failed += 1;
        console.warn(
          JSON.stringify({
            scope: "onboarding-email",
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
          scope: "onboarding-email",
          event: "claim_failed",
          error: errorDetailForLog(error),
        }),
      );
    }
  }
  return summary;
}

/** Fait échouer le passage (donc la supervision) quand il n'est pas allé au bout. */
export function assertOnboardingEmailsComplete(summary: OnboardingEmailSummary): void {
  if (!summary.configured) {
    throw new ConfigurationError(
      `Prise en main : ${summary.due} message(s) dû(s) mais Resend n'est pas configuré (RESEND_API_KEY, ALERT_EMAIL_FROM, SITE_URL).`,
    );
  }
  if (summary.failed > 0) {
    throw new Error(`Onboarding emails: ${summary.failed} of ${summary.due} sends failed.`);
  }
  if (summary.interrupted) {
    throw new Error("Onboarding emails: pass stopped by its time budget, resumed next run.");
  }
}
