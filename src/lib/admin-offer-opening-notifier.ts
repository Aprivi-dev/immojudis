import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PublicApiError } from "@/lib/api-errors";
import {
  escapeAttribute,
  resolveEmailAlertDeliveryConfig,
  sendResendEmail,
  type ResendEmailMessage,
} from "@/lib/email-alerts";
import { createUnsubscribeToken } from "@/lib/email-unsubscribe-token";
import { escapeHtml } from "@/lib/guards";

/**
 * Envoi de l'email d'ouverture à la liste d'attente (`offer_opening_notifications`), depuis
 * /admin/clients. Jusqu'ici la table ne faisait que collecter : rien n'envoyait l'email ni
 * n'écrivait `notified_at`.
 *
 * Garanties :
 * - réservé à l'administrateur (`auth.isAdmin`, comme les autres actions admin) ;
 * - destinataires : demande active (`notify_enabled`) et jamais prévenue (`notified_at is null`),
 *   adresse email confirmée ;
 * - jamais deux fois : `notified_at` est écrit AVANT l'envoi par une mise à jour conditionnelle
 *   (`notified_at is null`) ; seul celui qui l'obtient envoie. Si l'envoi échoue, la marque est
 *   retirée pour pouvoir réessayer. Au pire, un plantage entre la marque et l'envoi fait perdre un
 *   email, jamais en envoie deux ;
 * - par lots de 200 au plus, avec un budget de temps (les routes admin coupent à 30 s) : l'envoi
 *   s'arrête proprement et l'administrateur relance pour le reste ;
 * - lien de désinscription signé (portée « offer-opening ») dans le message et l'en-tête
 *   `List-Unsubscribe` (désinscription en un clic).
 *
 * Le texte est volontairement sobre : aucun prix ni promesse, un renvoi vers /offres où figurent
 * les conditions en vigueur. Il est à faire relire par le propriétaire avant le premier envoi réel.
 */

/** Taille maximale d'un lot (brief du propriétaire). */
export const OFFER_OPENING_BATCH_SIZE = 200;
/** Envois simultanés : assez peu pour rester sous la limite de débit de l'API d'email. */
const SEND_CONCURRENCY = 4;
/** Après ce délai, aucun nouvel envoi n'est commencé (la route admin coupe à 28 s). */
const SEND_TIME_BUDGET_MS = 20_000;

export const OFFER_OPENING_EMAIL_SUBJECT = "Immojudis : l’ouverture de l’offre Analyse";

export const offerOpeningNotifierActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test") }).strict(),
  z
    .object({
      action: z.literal("send"),
      /** Taille du lot, 200 au plus. */
      limit: z.number().int().min(1).max(OFFER_OPENING_BATCH_SIZE).optional(),
      /** Confirmation explicite : un envoi réel ne part jamais par un corps incomplet. */
      confirm: z.literal(true),
    })
    .strict(),
]);
export type OfferOpeningNotifierAction = z.infer<typeof offerOpeningNotifierActionSchema>;

export type OfferOpeningAudience = {
  /** Demandes actives jamais prévenues : les destinataires d'un envoi. */
  recipients: number;
  /** Demandes déjà prévenues (`notified_at` écrit). */
  alreadyNotified: number;
  batchSize: number;
  /** L'envoi d'email est configuré (clé, expéditeur, adresse du site). */
  configured: boolean;
  missing: string[];
  /** Ce que recevra chaque destinataire (le lien de désinscription y est un repère). */
  preview: { subject: string; text: string };
};

export type OfferOpeningTestResult = { sentTo: string };

export type OfferOpeningSendResult = {
  sent: number;
  /** Envois refusés par le fournisseur : la marque est retirée, un nouvel envoi les reprend. */
  failed: number;
  /** Demande retirée entre-temps, déjà prévenue par un autre envoi, ou adresse absente / non confirmée. */
  skipped: number;
  /** Destinataires restant après ce lot. */
  remaining: number;
  /** Le budget de temps est atteint : relancer pour la suite. */
  stoppedEarly: boolean;
};

/** Lien de désinscription signé de l'email d'ouverture. */
export function offerOpeningUnsubscribeUrl({
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
    createUnsubscribeToken({ userId, scope: { kind: "offer-opening" }, now, env }),
  )}`;
}

const INTRO =
  "Vous avez demandé à être prévenu(e) de l’ouverture de l’offre Analyse d’Immojudis. Ce message vous est envoyé une seule fois à ce sujet.";
const OFFERS_LINE =
  "Le contenu de l’offre, ses conditions en vigueur (tarif, essai éventuel, résiliation) et la façon de souscrire sont présentés sur la page Offres :";
const NO_COMMITMENT =
  "Rien n’est souscrit à votre place : aucun abonnement n’est créé sans votre accord.";

/**
 * Le message : texte et HTML. Pur, sans accès à la base. `internal` ajoute « [Test] » à l'objet
 * (envoi d'essai à l'administrateur).
 */
export function buildOfferOpeningMessage({
  recipientEmail,
  from,
  appUrl,
  unsubscribeUrl,
  internal = false,
}: {
  recipientEmail: string;
  from: string;
  appUrl: string;
  unsubscribeUrl: string;
  internal?: boolean;
}): ResendEmailMessage & { unsubscribeUrl: string } {
  const offersUrl = `${appUrl}/offres`;
  const subject = `${internal ? "[Test] " : ""}${OFFER_OPENING_EMAIL_SUBJECT}`;
  const text = [
    "Bonjour,",
    "",
    INTRO,
    "",
    `${OFFERS_LINE} ${offersUrl}`,
    "",
    NO_COMMITMENT,
    "",
    `Vous ne souhaitez plus être prévenu(e) ? Retirer ma demande : ${unsubscribeUrl}`,
  ].join("\n");
  const html = `<!doctype html>
<html lang="fr">
  <body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif;">
    <div style="max-width:620px;margin:0 auto;padding:28px 18px;">
      <div style="background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:24px;">
        <p style="margin:0 0 12px;font-size:16px;">Bonjour,</p>
        <p style="margin:0 0 14px;color:#4b5563;line-height:1.55;">${escapeHtml(INTRO)}</p>
        <p style="margin:0 0 18px;color:#4b5563;line-height:1.55;">${escapeHtml(OFFERS_LINE)}</p>
        <p style="margin:0 0 18px;"><a href="${escapeAttribute(offersUrl)}" style="display:inline-block;background:#182033;color:#fff;text-decoration:none;border-radius:8px;padding:10px 14px;font-weight:700;">Voir les offres</a></p>
        <p style="margin:0;color:#4b5563;line-height:1.55;">${escapeHtml(NO_COMMITMENT)}</p>
      </div>
      <p style="margin:14px 0 0;text-align:center;color:#6c7280;font-size:12px;">
        <a href="${escapeAttribute(unsubscribeUrl)}" style="color:#6c7280;">Retirer ma demande d’être prévenu(e)</a>
      </p>
    </div>
  </body>
</html>`;
  return {
    from,
    to: recipientEmail,
    subject,
    text,
    html,
    unsubscribeUrl,
    oneClickUnsubscribe: true,
  };
}

async function requireAdmin(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");
  return auth;
}

const REQUESTS = "offer_opening_notifications" as const;

async function countRequests(notified: boolean): Promise<number> {
  let query = supabaseAdmin
    .from(REQUESTS)
    .select("user_id", { count: "exact", head: true })
    .eq("offer_code", "analyse");
  query = notified
    ? query.not("notified_at", "is", null)
    : query.eq("notify_enabled", true).is("notified_at", null);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** Nombre de destinataires, état de la configuration d'envoi et aperçu du message. */
export async function getOfferOpeningAudience({
  authToken,
  env = process.env,
}: {
  authToken: string;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): Promise<OfferOpeningAudience> {
  await requireAdmin(authToken);
  const config = resolveEmailAlertDeliveryConfig(env);
  const [recipients, alreadyNotified] = await Promise.all([
    countRequests(false),
    countRequests(true),
  ]);
  const preview = buildOfferOpeningMessage({
    recipientEmail: "destinataire@exemple.fr",
    from: config.from ?? "Immojudis",
    appUrl: config.appUrl ?? "https://…",
    unsubscribeUrl: "[lien de désinscription personnel et signé]",
  });
  return {
    recipients,
    alreadyNotified,
    batchSize: OFFER_OPENING_BATCH_SIZE,
    configured: config.configured,
    missing: config.missing,
    preview: { subject: preview.subject, text: preview.text },
  };
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

/** Adresse d'un compte, seulement si elle est confirmée. */
async function readConfirmedEmail(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) throw error;
  const user = data.user;
  const email = user?.email?.trim();
  return email && user?.email_confirmed_at ? email : null;
}

/** Envoi d'essai : le message tel que le recevra la liste, à l'adresse de l'administrateur. */
export async function sendOfferOpeningTest({
  authToken,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
}: {
  authToken: string;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
}): Promise<OfferOpeningTestResult> {
  const auth = await requireAdmin(authToken);
  const config = requireDeliveryConfig(env);
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(auth.userId);
  if (error) throw error;
  const email = data.user?.email?.trim();
  if (!email) throw new PublicApiError("Votre compte n’a pas d’adresse email.", 409);
  const message = buildOfferOpeningMessage({
    recipientEmail: email,
    from: config.from,
    appUrl: config.appUrl,
    unsubscribeUrl: offerOpeningUnsubscribeUrl({
      appUrl: config.appUrl,
      userId: auth.userId,
      now,
      env,
    }),
    internal: true,
  });
  await sendResendEmail({
    apiKey: config.apiKey,
    message,
    idempotencyKey: `immojudis-offer-opening-test-${auth.userId}-${now.getTime()}`,
    fetchImpl,
  });
  console.info(JSON.stringify({ scope: "admin.offer-opening-notifier", action: "test" }));
  return { sentTo: email };
}

/**
 * Envoie un lot de 200 destinataires au plus (les plus anciennes demandes d'abord). Idempotent :
 * relancé, il ne reprend que ceux qui n'ont pas été prévenus.
 */
export async function sendOfferOpeningBatch({
  authToken,
  limit = OFFER_OPENING_BATCH_SIZE,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
  clock = Date.now,
}: {
  authToken: string;
  limit?: number;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}): Promise<OfferOpeningSendResult> {
  const auth = await requireAdmin(authToken);
  const config = requireDeliveryConfig(env);
  const size = Math.min(Math.max(1, Math.trunc(limit)), OFFER_OPENING_BATCH_SIZE);

  const { data: candidates, error } = await supabaseAdmin
    .from(REQUESTS)
    .select("user_id")
    .eq("offer_code", "analyse")
    .eq("notify_enabled", true)
    .is("notified_at", null)
    .order("consented_at", { ascending: true })
    .limit(size);
  if (error) throw error;

  const markedAt = now.toISOString();
  const counts = { sent: 0, failed: 0, skipped: 0 };
  const startedAt = clock();
  let stoppedEarly = false;
  const queue = (candidates ?? []).map((row) => row.user_id);

  /** La marque « prévenu » : seul celui dont la mise à jour touche la ligne a le droit d'envoyer. */
  async function claim(userId: string): Promise<boolean> {
    const { data, error: claimError } = await supabaseAdmin
      .from(REQUESTS)
      .update({ notified_at: markedAt })
      .eq("user_id", userId)
      .eq("offer_code", "analyse")
      .eq("notify_enabled", true)
      .is("notified_at", null)
      .select("user_id");
    if (claimError) throw claimError;
    return (data ?? []).length === 1;
  }

  async function release(userId: string) {
    const { error: releaseError } = await supabaseAdmin
      .from(REQUESTS)
      .update({ notified_at: null })
      .eq("user_id", userId)
      .eq("notified_at", markedAt);
    if (releaseError) {
      console.error(
        JSON.stringify({ scope: "admin.offer-opening-notifier", release: "failed", userId }),
      );
    }
  }

  async function deliver(userId: string) {
    if (!(await claim(userId))) {
      counts.skipped += 1;
      return;
    }
    try {
      const email = await readConfirmedEmail(userId);
      if (!email) {
        await release(userId);
        counts.skipped += 1;
        return;
      }
      await sendResendEmail({
        apiKey: config.apiKey,
        message: buildOfferOpeningMessage({
          recipientEmail: email,
          from: config.from,
          appUrl: config.appUrl,
          unsubscribeUrl: offerOpeningUnsubscribeUrl({
            appUrl: config.appUrl,
            userId,
            now,
            env,
          }),
        }),
        idempotencyKey: `immojudis-offer-opening-${userId}`,
        fetchImpl,
      });
      counts.sent += 1;
    } catch (failure) {
      await release(userId);
      counts.failed += 1;
      console.error(
        JSON.stringify({
          scope: "admin.offer-opening-notifier",
          send: "failed",
          userId,
          error: failure instanceof Error ? failure.message : String(failure),
        }),
      );
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length) {
        if (clock() - startedAt > SEND_TIME_BUDGET_MS) {
          stoppedEarly = true;
          return;
        }
        const userId = queue[next];
        next += 1;
        await deliver(userId);
      }
    }),
  );

  const remaining = await countRequests(false);
  console.info(
    JSON.stringify({
      scope: "admin.offer-opening-notifier",
      action: "send",
      adminId: auth.userId,
      ...counts,
      remaining,
      stoppedEarly,
    }),
  );
  return { ...counts, remaining, stoppedEarly };
}
