import "server-only";
import { Resend, type EmailBouncedEvent, type EmailComplainedEvent } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  revokeEmailAlertConsent,
  revokeSaleReminderConsent,
  revokeSaleResultsConsent,
  revokeWeeklyDigestConsent,
} from "@/lib/email-alerts";
import { informationAgentSenderAddress } from "@/lib/information-agent-inbound/delivery-events";
import { captureFailure, recordEmailDeliveryEvent } from "@/lib/email-delivery-log";

/**
 * Rebonds et plaintes des emails envoyés aux comptes (alertes, rappels d'audience, récapitulatif,
 * alertes de résultat), reçus sur `/api/webhooks/resend/account-emails`.
 *
 * Avant, aucun évènement de livraison n'était lu pour ces emails : une adresse qui rebondit
 * définitivement continuait d'être sollicitée, et une plainte pour spam n'arrêtait rien, ce qui abîme
 * la réputation de l'expéditeur (et donc la livraison de tous les emails, factures comprises).
 *
 * - Rebond définitif (`bounce.type` « Permanent ») ou plainte : les consentements email du compte
 *   sont retirés (alertes, rappels d'audience, récapitulatif, alertes de résultat) et les envois en
 *   file d'alerte sont annulés. L'adresse n'est plus sollicitée tant que la personne ne redonne pas
 *   son accord elle-même.
 * - Rebond passager ou indéterminé : ignoré (la boîte était pleine ou le serveur indisponible).
 * - Emails de l'agent d'information (`INFORMATION_AGENT_EMAIL_FROM`) : ignorés ici, l'autre webhook
 *   les traite (registre de contacts, pas comptes).
 *
 * - Tous les évènements de livraison (remis, différé, échec, rebond, plainte) sont ensuite écrits au
 *   journal des envois (`email_send_log`), APRÈS la logique ci-dessus, qui ne le lit jamais. Une panne ou
 *   une lenteur du journal (3 s au plus) ne retarde pas les retraits de consentement : elle remonte après
 *   eux (500), le fournisseur rejoue l'évènement.
 *
 * Les journaux ne portent aucune adresse.
 */
export type AccountEmailDeliveryEvent = EmailBouncedEvent | EmailComplainedEvent;

export type AccountEmailDeliveryAction = {
  kind: "bounce_permanent" | "complaint";
  emails: string[];
};

export type AccountEmailWebhookResult = {
  accepted: true;
  ignored?: true;
  kind?: AccountEmailDeliveryAction["kind"];
  /** Comptes dont les consentements ont été retirés. */
  revokedAccounts?: number;
};

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export class InvalidAccountEmailWebhookSignatureError extends Error {
  constructor() {
    super("Signature webhook invalide.");
    this.name = "InvalidAccountEmailWebhookSignatureError";
  }
}

export class AccountEmailWebhookPayloadTooLargeError extends Error {
  constructor() {
    super("Corps du webhook trop volumineux.");
    this.name = "AccountEmailWebhookPayloadTooLargeError";
  }
}

function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Adresse nue d'un expéditeur (« Immojudis <alertes@immojudis.com> » donne l'adresse seule). */
function bareAddress(value: string | null | undefined): string {
  const text = value ?? "";
  const match = /<([^<>]+)>/.exec(text);
  return normalizeAddress(match ? match[1] : text);
}

/**
 * Ce que l'évènement demande de faire, ou `null` : rebond passager, email de l'agent d'information,
 * aucun destinataire lisible. Pur, testé sans base.
 */
export function accountEmailActionOf(
  event: { type: string; data?: unknown },
  agentSender: string | null,
): AccountEmailDeliveryAction | null {
  if (event.type !== "email.bounced" && event.type !== "email.complained") return null;
  const data = (event.data ?? {}) as {
    from?: string;
    to?: string[];
    bounce?: { type?: string };
  };
  if (agentSender && bareAddress(data.from) === agentSender) return null;
  const emails = [
    ...new Set((data.to ?? []).map((recipient) => bareAddress(recipient)).filter(Boolean)),
  ];
  if (emails.length === 0) return null;
  if (event.type === "email.complained") return { kind: "complaint", emails };
  const bounceType = typeof data.bounce?.type === "string" ? data.bounce.type : "";
  if (bounceType.trim().toLowerCase() !== "permanent") return null;
  return { kind: "bounce_permanent", emails };
}

/** Retire tous les consentements email du compte et annule les envois d'alerte en file. */
export async function revokeAllEmailConsents(userId: string, now = new Date()): Promise<void> {
  const results = await Promise.allSettled([
    // Annule aussi les envois d'alerte en file (`cancelQueuedEmailNotifications`).
    revokeEmailAlertConsent({ userId, now }),
    revokeSaleReminderConsent({ userId, now }),
    revokeWeeklyDigestConsent({ userId, now }),
    revokeSaleResultsConsent({ userId, now }),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  // Une erreur remonte : le fournisseur rejoue l'évènement, les retraits sont idempotents.
  if (failed) throw (failed as PromiseRejectedResult).reason;
}

async function findAccountId(email: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.rpc("user_id_for_email", { p_email: email });
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    throw new AccountEmailWebhookPayloadTooLargeError();
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new AccountEmailWebhookPayloadTooLargeError();
  }
  return body;
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) throw new InvalidAccountEmailWebhookSignatureError();
  return value;
}

export async function processAccountEmailDeliveryWebhook({
  request,
  env = process.env,
  findAccount = findAccountId,
  revoke = revokeAllEmailConsents,
  recordDelivery = recordEmailDeliveryEvent,
}: {
  request: Request;
  env?: Readonly<Record<string, string | undefined>>;
  findAccount?: (email: string) => Promise<string | null>;
  revoke?: (userId: string) => Promise<void>;
  recordDelivery?: (event: { type: string; created_at?: string; data?: unknown }) => Promise<void>;
}): Promise<AccountEmailWebhookResult> {
  const webhookSecret = env.RESEND_ACCOUNT_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) throw new Error("Configuration du webhook des emails de compte incomplète.");

  const payload = await readBoundedBody(request);
  let event: { type: string; data?: unknown };
  try {
    // La vérification n'appelle pas l'API de Resend : la clé n'est qu'un paramètre du constructeur.
    event = new Resend("re_signature_verification_only").webhooks.verify({
      payload,
      headers: {
        id: requiredHeader(request, "svix-id"),
        timestamp: requiredHeader(request, "svix-timestamp"),
        signature: requiredHeader(request, "svix-signature"),
      },
      webhookSecret,
    });
  } catch {
    throw new InvalidAccountEmailWebhookSignatureError();
  }

  // Le journal passe APRÈS la logique de consentement : une panne ou une lenteur du journal ne la retarde jamais.
  // Son échec remonte quand même (500) pour que le fournisseur rejoue l'évènement, les retraits étant idempotents.
  const finish = async (result: AccountEmailWebhookResult) => {
    const logFailure = await captureFailure(() => recordDelivery(event));
    if (logFailure) throw logFailure.error;
    return result;
  };

  const action = accountEmailActionOf(event, informationAgentSenderAddress(env));
  if (!action) return finish({ accepted: true, ignored: true });

  const accounts = new Set<string>();
  for (const email of action.emails) {
    const userId = await findAccount(email);
    if (userId) accounts.add(userId);
  }
  for (const userId of accounts) await revoke(userId);

  console.warn(
    JSON.stringify({
      scope: "account-email-delivery",
      level: "warn",
      event: action.kind,
      recipients: action.emails.length,
      revokedAccounts: accounts.size,
    }),
  );
  return finish({ accepted: true, kind: action.kind, revokedAccounts: accounts.size });
}
