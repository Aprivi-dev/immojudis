import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  renderLaunchOfferEndNoticeEmail,
  launchOfferEndNoticeSubject,
} from "../../emails/launch-offer-end-notice";
import { PublicApiError } from "@/lib/api-errors";
import {
  resolveEmailAlertDeliveryConfig,
  sendResendEmail,
  type ResendEmailMessage,
} from "@/lib/email-alerts";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { asRecord } from "@/lib/guards";
import {
  LAUNCH_OFFER_MIN_NOTICE_DAYS,
  daysUntilLaunchOfferEnd,
  launchOfferEndLabel,
  parseLaunchOfferEndDay,
} from "@/lib/launch-offer-end";
import { resetLaunchOfferCache } from "@/lib/launch-offer.server";
import { isMissingRpcError } from "@/lib/postgrest-errors";

/**
 * Préavis de fin de l'offre de lancement (n° 74), depuis /admin/clients.
 *
 * Les textes publics promettent « Nous vous prévenons par email avant leur fin ». Ce module est l'outil :
 *
 * - la DATE DE FIN ANNONCÉE est enregistrée dans la configuration de l'offre (`ends_on`). Elle ne coupe
 *   rien : l'offre reste active jusqu'au bouton « Couper l'offre de lancement » ;
 * - la liste des comptes concernés (`get_launch_offer_end_queue`) : ceux qui n'ont l'accès Analyse que
 *   grâce à l'offre (règle canonique d'éligibilité, hors administrateurs, premium et abonnés), non
 *   désinscrits, pas encore prévenus pour cette date. Nombres seulement : aucune adresse ne sort ;
 * - RIEN n'est envoyé automatiquement : un envoi réel exige l'action explicite d'un administrateur avec
 *   `confirm: true` ET la date que l'écran affichait (si elle a changé entre-temps, rien ne part) ;
 * - idempotent : le préavis d'un compte pour une date est réservé AVANT l'envoi
 *   (`claim_launch_offer_end_notice`) ; un échec le rend reprenable (3 essais, 23 h, clé d'idempotence de
 *   Resend stable). Au pire un plantage entre la réservation et l'envoi perd un message, jamais en envoie deux ;
 * - désinscriptions : lien signé (portée « launch-offer-end ») dans le message et `List-Unsubscribe` en un
 *   clic ; un compte désinscrit n'est ni dans la file ni réservable, pour aucune date ;
 * - l'envoi réel exige au moins `LAUNCH_OFFER_MIN_NOTICE_DAYS` jours avant la date (procédure du
 *   20/10/2026) et une offre encore active ;
 * - lots de 200 au plus et budget de temps (les routes admin coupent à 30 s) : relancer pour le reste.
 */
export const LAUNCH_OFFER_END_BATCH_SIZE = 200;
const SEND_CONCURRENCY = 4;
const SEND_TIME_BUDGET_MS = 20_000;

const endDaySchema = z
  .string()
  .refine((value) => parseLaunchOfferEndDay(value) !== null, "Date invalide (AAAA-MM-JJ).");

export const launchOfferEndActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-date"), endsOn: endDaySchema.nullable() }).strict(),
  z.object({ action: z.literal("test") }).strict(),
  z
    .object({
      action: z.literal("send"),
      /** La date que l'écran affichait : si la configuration a changé depuis, rien ne part. */
      endsOn: endDaySchema,
      limit: z.number().int().min(1).max(LAUNCH_OFFER_END_BATCH_SIZE).optional(),
      confirm: z.literal(true),
    })
    .strict(),
]);
export type LaunchOfferEndAction = z.infer<typeof launchOfferEndActionSchema>;

export type LaunchOfferEndState = {
  active: boolean;
  /** `AAAA-MM-JJ`, ou null tant qu'aucune date n'est annoncée. */
  endsOn: string | null;
  endsOnLabel: string | null;
  /** Jours de calendrier jusqu'à la date (négatif une fois passée). */
  daysLeft: number | null;
  minNoticeDays: number;
  /** Pourquoi un envoi réel est impossible maintenant, ou null. */
  blocker: string | null;
  audience: {
    /** Comptes qui n'ont l'accès Analyse que grâce à l'offre. */
    accounts: number;
    optedOut: number;
    notified: number;
    /** Destinataires envoyables maintenant. */
    recipients: number;
    inProgress: number;
    needsReview: number;
  } | null;
  batchSize: number;
  configured: boolean;
  missing: string[];
  preview: { subject: string; text: string } | null;
};

export type LaunchOfferEndSendResult = {
  sent: number;
  failed: number;
  skipped: number;
  remaining: number;
  stoppedEarly: boolean;
};

export function launchOfferEndUnsubscribeUrl({
  appUrl,
  userId,
  now = new Date(),
  env,
}: {
  appUrl: string;
  userId: string;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): string {
  return `${appUrl}/api/notification-preferences/unsubscribe?token=${encodeURIComponent(
    createUnsubscribeToken({ userId, scope: { kind: "launch-offer-end" }, now, env }),
  )}`;
}

/**
 * Date d'émission du jeton de désinscription d'un préavis : le début du jour de fin annoncé, jamais
 * l'heure de l'essai. La clé d'idempotence de Resend est stable pour un compte et une date ; si
 * chaque essai signait un jeton neuf (expiration datée de l'essai), la relance d'un envoi arriverait
 * avec un message différent sous la même clé, et Resend la refuserait. Le jeton est ainsi le même à
 * chaque essai et reste valable un an après la fin annoncée.
 */
export function launchOfferEndTokenIssuedAt(endsOn: string): Date {
  return new Date(`${endsOn}T00:00:00.000Z`);
}

export function launchOfferEndIdempotencyKey(userId: string, endsOn: string): string {
  return `immojudis-launch-offer-end-${userId}-${endsOn}`;
}

/** Le message : objet, texte et HTML. `internal` ajoute « [Test] » à l'objet (essai à l'administrateur). */
export async function buildLaunchOfferEndMessage({
  recipientEmail,
  from,
  appUrl,
  endsOn,
  unsubscribeUrl,
  internal = false,
}: {
  recipientEmail: string;
  from: string;
  appUrl: string;
  endsOn: string;
  unsubscribeUrl: string;
  internal?: boolean;
}): Promise<ResendEmailMessage & { unsubscribeUrl: string }> {
  const endsOnLabel = launchOfferEndLabel(endsOn);
  const { html, text } = await renderLaunchOfferEndNoticeEmail({
    endsOnLabel,
    accountUrl: `${appUrl}/compte`,
    unsubscribeUrl,
  });
  return {
    from,
    to: recipientEmail,
    subject: `${internal ? "[Test] " : ""}${launchOfferEndNoticeSubject(endsOnLabel)}`,
    html,
    text,
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}

const MIGRATION_MESSAGE =
  "Le préavis de fin d’offre n’est pas encore disponible : la migration 20261102140000 n’est pas appliquée.";

type OfferConfig = { active: boolean; endsOn: string | null };

async function readConfig(): Promise<OfferConfig> {
  const { data, error } = await supabaseAdmin.rpc("get_launch_offer_config");
  if (error) {
    if (isMissingRpcError(error)) throw new PublicApiError(MIGRATION_MESSAGE, 503);
    throw error;
  }
  const document = asRecord(data);
  return {
    active: document.active === true,
    endsOn: parseLaunchOfferEndDay(document.ends_on),
  };
}

type Queue = {
  audience: number;
  optedOut: number;
  notified: number;
  total: number;
  inProgress: number;
  needsReview: number;
  recipients: string[];
};

async function readQueue(endsOn: string, limit: number): Promise<Queue> {
  const { data, error } = await supabaseAdmin.rpc("get_launch_offer_end_queue", {
    p_ends_on: endsOn,
    p_limit: limit,
  });
  if (error) {
    if (isMissingRpcError(error)) throw new PublicApiError(MIGRATION_MESSAGE, 503);
    throw error;
  }
  const document = asRecord(data);
  const count = (key: string) => Number(document[key] ?? 0) || 0;
  return {
    audience: count("audience"),
    optedOut: count("opted_out"),
    notified: count("notified"),
    total: count("total"),
    inProgress: count("in_progress"),
    needsReview: count("needs_review"),
    recipients: (Array.isArray(document.recipients) ? document.recipients : []).filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

/** Pourquoi un envoi réel est impossible (null : possible). La même règle sert l'écran et la route. */
function sendBlocker(config: OfferConfig, now: Date): string | null {
  if (!config.active)
    return "L’offre de lancement est déjà coupée : il n’y a plus rien à annoncer.";
  if (!config.endsOn) return "Enregistrez d’abord la date de fin annoncée.";
  const daysLeft = daysUntilLaunchOfferEnd(config.endsOn, now);
  if (daysLeft < LAUNCH_OFFER_MIN_NOTICE_DAYS) {
    return `La date de fin est dans ${Math.max(daysLeft, 0)} jour${daysLeft > 1 ? "s" : ""} : le préavis doit être d’au moins ${LAUNCH_OFFER_MIN_NOTICE_DAYS} jours. Reportez la date.`;
  }
  return null;
}

function requireDeliveryConfig(env: Pick<NodeJS.ProcessEnv, string>) {
  const config = resolveEmailAlertDeliveryConfig(env);
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) {
    throw new PublicApiError(
      "L’envoi d’emails n’est pas configuré sur ce serveur : aucun message n’est parti.",
      503,
    );
  }
  return { apiKey: config.apiKey, from: config.from, appUrl: config.appUrl };
}

/** Configuration, liste des comptes concernés, état de l'envoi et aperçu du message. */
export async function getAdminLaunchOfferEnd({
  authToken,
  now = new Date(),
  env = process.env,
}: {
  authToken: string;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): Promise<LaunchOfferEndState> {
  await requireAdmin(authToken);
  const config = await readConfig();
  const delivery = resolveEmailAlertDeliveryConfig(env);
  const queue = config.endsOn ? await readQueue(config.endsOn, 1) : null;
  let preview: LaunchOfferEndState["preview"] = null;
  if (config.endsOn) {
    const message = await buildLaunchOfferEndMessage({
      recipientEmail: "destinataire@exemple.fr",
      from: delivery.from ?? "Immojudis",
      appUrl: delivery.appUrl ?? "https://…",
      endsOn: config.endsOn,
      unsubscribeUrl: "[lien de désinscription personnel et signé]",
    });
    preview = { subject: message.subject, text: message.text };
  }
  return {
    active: config.active,
    endsOn: config.endsOn,
    endsOnLabel: config.endsOn ? launchOfferEndLabel(config.endsOn) : null,
    daysLeft: config.endsOn ? daysUntilLaunchOfferEnd(config.endsOn, now) : null,
    minNoticeDays: LAUNCH_OFFER_MIN_NOTICE_DAYS,
    blocker: sendBlocker(config, now),
    audience: queue && {
      accounts: queue.audience,
      optedOut: queue.optedOut,
      notified: queue.notified,
      recipients: queue.total,
      inProgress: queue.inProgress,
      needsReview: queue.needsReview,
    },
    batchSize: LAUNCH_OFFER_END_BATCH_SIZE,
    configured: delivery.configured,
    missing: delivery.missing,
    preview,
  };
}

/** Enregistre (ou efface) la date de fin annoncée. Ne coupe rien. */
export async function setAdminLaunchOfferEnd({
  authToken,
  endsOn,
}: {
  authToken: string;
  endsOn: string | null;
}): Promise<void> {
  const auth = await requireAdmin(authToken);
  const { error } = await supabaseAdmin.rpc("set_launch_offer_end", {
    // Les types générés ne marquent pas les paramètres SQL nullables : null efface la date (voir la migration).
    p_ends_on: endsOn as string,
    p_actor: auth.userId,
  });
  if (error) {
    if (isMissingRpcError(error)) throw new PublicApiError(MIGRATION_MESSAGE, 503);
    if ((error as { code?: unknown }).code === "22023") {
      throw new PublicApiError("La date de fin ne peut pas être passée.", 422);
    }
    throw error;
  }
  resetLaunchOfferCache();
  console.info(
    JSON.stringify({
      scope: "admin.launch-offer-end",
      action: "set-date",
      adminId: auth.userId,
      endsOn,
    }),
  );
}

/** Envoi d'essai : le message tel que le recevront les comptes, à l'adresse de l'administrateur. */
export async function sendLaunchOfferEndTest({
  authToken,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
}: {
  authToken: string;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
}): Promise<{ sentTo: string }> {
  const auth = await requireAdmin(authToken);
  const config = await readConfig();
  if (!config.endsOn) throw new PublicApiError("Enregistrez d’abord la date de fin annoncée.", 409);
  const delivery = requireDeliveryConfig(env);
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(auth.userId);
  if (error) throw error;
  const email = data.user?.email?.trim();
  if (!email) throw new PublicApiError("Votre compte n’a pas d’adresse email.", 409);
  const message = await buildLaunchOfferEndMessage({
    recipientEmail: email,
    from: delivery.from,
    appUrl: delivery.appUrl,
    endsOn: config.endsOn,
    unsubscribeUrl: launchOfferEndUnsubscribeUrl({
      appUrl: delivery.appUrl,
      userId: auth.userId,
      now,
      env,
    }),
    internal: true,
  });
  await sendResendEmail({
    apiKey: delivery.apiKey,
    message,
    idempotencyKey: `immojudis-launch-offer-end-test-${auth.userId}-${now.getTime()}`,
    fetchImpl,
    category: "launch_offer_end",
  });
  console.info(JSON.stringify({ scope: "admin.launch-offer-end", action: "test" }));
  return { sentTo: email };
}

/** Adresse d'un compte, seulement si elle est confirmée. */
async function readConfirmedEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) throw error;
  const email = data.user?.email?.trim();
  return email && data.user?.email_confirmed_at ? email : null;
}

/**
 * Envoie un lot de 200 destinataires au plus, sur l'action explicite d'un administrateur. Relancé, il ne
 * reprend que ceux qui n'ont pas reçu le préavis de CETTE date (voir l'en-tête du module).
 */
export async function sendLaunchOfferEndBatch({
  authToken,
  endsOn,
  limit = LAUNCH_OFFER_END_BATCH_SIZE,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  clock = Date.now,
}: {
  authToken: string;
  endsOn: string;
  limit?: number;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}): Promise<LaunchOfferEndSendResult> {
  const auth = await requireAdmin(authToken);
  const config = await readConfig();
  const blocker = sendBlocker(config, now);
  if (blocker) throw new PublicApiError(blocker, 409);
  if (config.endsOn !== endsOn) {
    throw new PublicApiError(
      "La date de fin annoncée a changé depuis l’affichage de cet écran : rechargez la page avant d’envoyer.",
      409,
    );
  }
  const delivery = requireDeliveryConfig(env);
  const size = Math.min(Math.max(1, Math.trunc(limit)), LAUNCH_OFFER_END_BATCH_SIZE);
  const queue = await readQueue(endsOn, size);

  const counts = { sent: 0, failed: 0, skipped: 0 };
  const startedAt = clock();
  let stoppedEarly = false;

  async function settle(
    userId: string,
    patch: { status: "sent" | "failed"; error?: string; message_id?: string | null },
  ) {
    const { error } = await supabaseAdmin
      .from("launch_offer_end_notices")
      .update({
        status: patch.status,
        error: patch.error ?? null,
        message_id: patch.message_id ?? null,
        sent_at: patch.status === "sent" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("ends_on", endsOn);
    if (error) {
      console.error(
        JSON.stringify({
          scope: "admin.launch-offer-end",
          journal: "failed",
          userId,
          status: patch.status,
        }),
      );
    }
  }

  async function deliver(userId: string) {
    const { data: claimed, error: claimError } = await supabaseAdmin.rpc(
      "claim_launch_offer_end_notice",
      { p_user_id: userId, p_ends_on: endsOn, p_now: now.toISOString() },
    );
    if (claimError) throw claimError;
    if (claimed !== true) {
      counts.skipped += 1;
      return;
    }
    try {
      const email = await readConfirmedEmail(userId);
      if (!email) {
        await settle(userId, { status: "failed", error: "email_unavailable" });
        counts.skipped += 1;
        return;
      }
      const message = await buildLaunchOfferEndMessage({
        recipientEmail: email,
        from: delivery.from,
        appUrl: delivery.appUrl,
        endsOn,
        unsubscribeUrl: launchOfferEndUnsubscribeUrl({
          appUrl: delivery.appUrl,
          userId,
          now: launchOfferEndTokenIssuedAt(endsOn),
          env,
        }),
      });
      const result = await sendResendEmail({
        apiKey: delivery.apiKey,
        message,
        idempotencyKey: launchOfferEndIdempotencyKey(userId, endsOn),
        fetchImpl,
        category: "launch_offer_end",
      });
      await settle(userId, { status: "sent", message_id: result.id });
      counts.sent += 1;
    } catch (failure) {
      await settle(userId, { status: "failed", error: "send_failed" });
      counts.failed += 1;
      console.error(
        JSON.stringify({
          scope: "admin.launch-offer-end",
          send: "failed",
          userId,
          error: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, queue.recipients.length) }, async () => {
      while (next < queue.recipients.length) {
        if (clock() - startedAt > SEND_TIME_BUDGET_MS) {
          stoppedEarly = true;
          return;
        }
        const userId = queue.recipients[next];
        next += 1;
        await deliver(userId);
      }
    }),
  );

  const remaining = (await readQueue(endsOn, 1)).total;
  console.info(
    JSON.stringify({
      scope: "admin.launch-offer-end",
      action: "send",
      adminId: auth.userId,
      endsOn,
      ...counts,
      remaining,
      stoppedEarly,
    }),
  );
  return { ...counts, remaining, stoppedEarly };
}
