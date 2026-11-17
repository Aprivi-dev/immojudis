import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, Tables } from "@/integrations/supabase/types";
import { resolveTransactionalEmailConfig } from "@/lib/email-alerts";
import { errorDetailForLog } from "@/lib/error-detail-for-log";
import { resolveOperationalAlertEmailConfig } from "@/lib/operational-alerts";
import {
  buildPrivacyRequestAcknowledgementMessage,
  buildPrivacyRequestClosureMessage,
  buildPrivacyRequestOperatorMessage,
  type PrivacyRequestClosure,
} from "@/lib/privacy-request-emails";
import { privacyRequestSubjectKind } from "@/lib/privacy-request-types";
import { sendTrackedEmail } from "@/lib/send-tracked-email";
import { resolveSiteOrigin } from "@/lib/site-url";

/**
 * Envoi des emails de suivi d'une demande de droits, et leur trace dans la demande.
 *
 * Trois envois, chacun suivi dans `data_subject_requests.metadata.notifications` (jamais le corps) :
 * - `operator` : l'exploitation est prévenue du dépôt (canal `OPERATIONS_ALERT_EMAIL_TO` des alertes) ;
 * - `acknowledgement` : accusé de réception au demandeur ; `acknowledged_at` prend la date de son envoi ;
 * - `closure` : email de clôture (demande traitée ou refusée), posé « en attente » par la clôture même.
 *
 * Aucun envoi ne fait échouer le dépôt ni la clôture : un échec est journalisé (sans adresse) et repris par
 * `followUpPrivacyRequests`, appelé à chaque passage d'operational-health, jusqu'à `MAX_ATTEMPTS` essais.
 * L'exploitation est aussi prévenue sans email : le dépôt ouvre aussitôt l'alerte d'exploitation
 * `compliance.privacy_requests.awaiting_operator` (canal commun des alertes), refermée quand plus aucune
 * demande n'est « reçue ». C'est le seul canal tant que `OPERATIONS_ALERT_EMAIL_TO` n'est pas défini.
 *
 * Pourquoi la trace est dans la demande : l'effacement d'un compte purge `email_send_log` (par compte et par
 * adresse). L'email de clôture d'un effacement part APRÈS cette purge, vers `requester_email` et sans compte
 * (il fonctionne alors que le compte n'existe plus) ; sa ligne du journal des envois suit la durée commune du
 * journal (90 jours), et la preuve durable de l'envoi est `metadata.notifications.closure` (date, identifiant
 * Resend, gabarit), conservée avec la demande.
 */

type Env = Pick<NodeJS.ProcessEnv, string>;

const MAX_ATTEMPTS = 5;
const OPEN_STATUSES = ["received", "identity_verification", "in_review"];
const FOLLOW_UP_LIMIT = 200;
const DEFAULT_ORIGIN = "https://immojudis.com";

export type NotifiableRequest = Pick<
  Tables<"data_subject_requests">,
  | "id"
  | "request_type"
  | "requester_email"
  | "user_id"
  | "submitted_at"
  | "due_at"
  | "status"
  | "metadata"
>;

const NOTIFIABLE_COLUMNS =
  "id,request_type,requester_email,user_id,submitted_at,due_at,status,metadata";

type DeliveryState = {
  status: "pending" | "sent" | "failed";
  attempts?: number;
  sent_at?: string;
  email_id?: string | null;
  template_key?: string;
};

type ClosureState = DeliveryState & {
  outcome: PrivacyRequestClosure["status"];
  closed_at: string;
  erasure_executed: boolean;
  response: string | null;
};

type NotificationKind = "operator" | "acknowledgement" | "closure";
type Outcome = "sent" | "failed" | "unconfigured" | "skipped";

function record(value: Json | null | undefined): Record<string, Json | undefined> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function notificationsOf(metadata: Json | null | undefined) {
  return record(record(metadata).notifications) as {
    operator?: DeliveryState;
    acknowledgement?: DeliveryState;
    closure?: ClosureState;
  };
}

/** À envoyer : jamais tenté (demande antérieure à ce suivi comprise), en attente, ou en échec non épuisé. */
function due(state: DeliveryState | undefined): boolean {
  if (!state) return true;
  return state.status === "pending" && (state.attempts ?? 0) < MAX_ATTEMPTS;
}

/** Métadonnées à écrire à la clôture : l'email de clôture y est posé en attente. */
export function withPendingClosure(
  metadata: Json | null | undefined,
  closure: PrivacyRequestClosure,
): Json {
  const current = record(metadata);
  const state: ClosureState = {
    status: "pending",
    attempts: 0,
    outcome: closure.status,
    closed_at: closure.closedAt,
    erasure_executed: closure.erasureExecuted,
    response: closure.response?.trim().slice(0, 2000) || null,
  };
  return {
    ...current,
    notifications: { ...notificationsOf(metadata), closure: state },
  } as Json;
}

/** Relit les métadonnées puis y écrit l'état d'un envoi (la demande a pu changer entre-temps). */
async function writeState(
  requestId: string,
  kind: NotificationKind,
  state: DeliveryState | ClosureState,
  acknowledgedAt?: string,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .select("metadata")
    .eq("id", requestId)
    .single();
  if (error) throw error;
  const metadata = record(data.metadata);
  const { error: updateError } = await supabaseAdmin
    .from("data_subject_requests")
    .update({
      metadata: {
        ...metadata,
        notifications: { ...notificationsOf(data.metadata), [kind]: state },
      } as Json,
      ...(acknowledgedAt ? { acknowledged_at: acknowledgedAt } : {}),
    })
    .eq("id", requestId);
  if (updateError) throw updateError;
}

function logFailure(requestId: string, kind: NotificationKind | "alert", error: unknown) {
  console.warn(
    JSON.stringify({
      scope: "privacy-request-notifications",
      event: "send_failed",
      requestId,
      kind,
      error: errorDetailForLog(error),
    }),
  );
}

function facts(row: NotifiableRequest) {
  return {
    requestType: row.request_type,
    submittedAt: row.submitted_at,
    dueAt: row.due_at,
    subjectKind: privacyRequestSubjectKind(row),
  };
}

/** Un envoi suivi : état écrit après l'envoi, échec compté. Ne lève jamais. */
async function deliver(
  row: NotifiableRequest,
  kind: NotificationKind,
  previous: DeliveryState | undefined,
  send: () => Promise<{ id: string | null; templateKey: string } | "unconfigured">,
  extra: (sentAt: string) => {
    state?: Partial<ClosureState>;
    acknowledgedAt?: string;
  } = () => ({}),
): Promise<Outcome> {
  if (!due(previous)) return "skipped";
  const attempts = (previous?.attempts ?? 0) + 1;
  try {
    const result = await send();
    if (result === "unconfigured") return "unconfigured";
    const sentAt = new Date().toISOString();
    const { state, acknowledgedAt } = extra(sentAt);
    await writeState(
      row.id,
      kind,
      {
        ...previous,
        ...state,
        status: "sent",
        attempts,
        sent_at: sentAt,
        email_id: result.id,
        template_key: result.templateKey,
      } as DeliveryState,
      acknowledgedAt,
    );
    return "sent";
  } catch (error) {
    logFailure(row.id, kind, error);
    try {
      await writeState(row.id, kind, {
        ...previous,
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
      } as DeliveryState);
    } catch (stateError) {
      logFailure(row.id, kind, stateError);
    }
    return "failed";
  }
}

async function sendOperatorNotification(
  row: NotifiableRequest,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Outcome> {
  return deliver(row, "operator", notificationsOf(row.metadata).operator, async () => {
    const config = resolveOperationalAlertEmailConfig(env);
    if (!config) return "unconfigured";
    const appUrl = resolveSiteOrigin(env, DEFAULT_ORIGIN) ?? DEFAULT_ORIGIN;
    let id: string | null = null;
    for (const to of config.to) {
      const result = await sendTrackedEmail({
        apiKey: config.apiKey,
        idempotencyKey: `privacy-request-operator-${row.id}-${to}`.slice(0, 256),
        fetchImpl,
        message: buildPrivacyRequestOperatorMessage(facts(row), { from: config.from, to, appUrl }),
        category: "operations",
        templateKey: "privacy_request_operator",
      });
      id ??= result.id;
    }
    return { id, templateKey: "privacy_request_operator" };
  });
}

function transactionalConfig(env: Env) {
  const config = resolveTransactionalEmailConfig(env);
  return config.configured && config.apiKey && config.from && config.appUrl
    ? { apiKey: config.apiKey, from: config.from, appUrl: config.appUrl }
    : null;
}

async function sendAcknowledgement(
  row: NotifiableRequest,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Outcome> {
  return deliver(
    row,
    "acknowledgement",
    notificationsOf(row.metadata).acknowledgement,
    async () => {
      const config = transactionalConfig(env);
      if (!config) return "unconfigured";
      const result = await sendTrackedEmail({
        apiKey: config.apiKey,
        idempotencyKey: `privacy-request-ack-${row.id}`,
        fetchImpl,
        message: buildPrivacyRequestAcknowledgementMessage(facts(row), {
          from: config.from,
          to: row.requester_email,
          appUrl: config.appUrl,
        }),
        category: "privacy",
        templateKey: "privacy_request_acknowledgement",
        userId: row.user_id,
      });
      return { id: result.id, templateKey: "privacy_request_acknowledgement" };
    },
    (sentAt) => ({ acknowledgedAt: sentAt }),
  );
}

async function sendClosure(
  row: NotifiableRequest,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Outcome> {
  const closure = notificationsOf(row.metadata).closure;
  // Pas de clôture posée par ce suivi (demande close avant lui) : rien à envoyer.
  if (!closure) return "skipped";
  return deliver(row, "closure", closure, async () => {
    const config = transactionalConfig(env);
    if (!config) return "unconfigured";
    const result = await sendTrackedEmail({
      apiKey: config.apiKey,
      idempotencyKey: `privacy-request-closure-${row.id}-${closure.outcome}`,
      fetchImpl,
      message: buildPrivacyRequestClosureMessage(
        facts(row),
        {
          status: closure.outcome,
          closedAt: closure.closed_at,
          erasureExecuted: closure.erasure_executed,
          response: closure.response,
        },
        { from: config.from, to: row.requester_email, appUrl: config.appUrl },
      ),
      category: "privacy",
      templateKey: "privacy_request_closure",
      // Compte effacé : `user_id` est déjà nul, la ligne du journal n'est rattachée à aucun compte.
      userId: row.user_id,
    });
    return { id: result.id, templateKey: "privacy_request_closure" };
  });
}

/**
 * Dépôt d'une demande : l'exploitation est prévenue et le demandeur reçoit l'accusé de réception. Ne lève
 * jamais : le dépôt est enregistré quoi qu'il arrive ici.
 */
export async function notifyPrivacyRequestReceived(
  row: NotifiableRequest,
  { env = process.env, fetchImpl = fetch }: { env?: Env; fetchImpl?: typeof fetch } = {},
): Promise<{ operator: Outcome; acknowledgement: Outcome }> {
  // L'un après l'autre : chaque envoi relit puis réécrit `metadata` ; en parallèle, le second effacerait
  // la trace du premier.
  // L'alerte `compliance.privacy_requests.awaiting_operator` s'ouvre tout de suite : c'est le canal qui
  // prévient l'exploitation quand `OPERATIONS_ALERT_EMAIL_TO` n'est pas défini. Elle part avec la remise
  // suivante des alertes (operational-health, toutes les 30 minutes) ; un échec ici est rattrapé par ce passage.
  try {
    await evaluatePrivacyRequestAlerts(new Date());
  } catch (error) {
    logFailure(row.id, "alert", error);
  }
  const operator = await sendOperatorNotification(row, env, fetchImpl);
  const acknowledgement = await sendAcknowledgement(row, env, fetchImpl);
  return { operator, acknowledgement };
}

/** Clôture d'une demande (métadonnées écrites par `withPendingClosure`) : l'email part. Ne lève jamais. */
export async function notifyPrivacyRequestClosed(
  row: NotifiableRequest,
  { env = process.env, fetchImpl = fetch }: { env?: Env; fetchImpl?: typeof fetch } = {},
): Promise<Outcome> {
  return sendClosure(row, env, fetchImpl);
}

type Counts = Record<Outcome, number>;
const emptyCounts = (): Counts => ({ sent: 0, failed: 0, unconfigured: 0, skipped: 0 });

export type PrivacyRequestFollowUpSummary = {
  /** Alertes évaluées ; `migration_pending` tant que la migration 20261202100000 n'est pas appliquée. */
  evaluation: Record<string, unknown> | "migration_pending";
  operator: Counts;
  acknowledgement: Counts;
  closure: Counts;
};

/**
 * Passage de suivi, appelé par operational-health : évalue les alertes `compliance.privacy_requests.*` et
 * reprend les envois restés en attente. Lève seulement si la base ne répond pas (lecture ou évaluation).
 */
export async function followUpPrivacyRequests(
  now: Date = new Date(),
  { env = process.env, fetchImpl = fetch }: { env?: Env; fetchImpl?: typeof fetch } = {},
): Promise<PrivacyRequestFollowUpSummary> {
  const summary: PrivacyRequestFollowUpSummary = {
    evaluation: "migration_pending",
    operator: emptyCounts(),
    acknowledgement: emptyCounts(),
    closure: emptyCounts(),
  };

  const [open, closing] = await Promise.all([
    supabaseAdmin
      .from("data_subject_requests")
      .select(NOTIFIABLE_COLUMNS)
      .in("status", OPEN_STATUSES)
      .order("submitted_at", { ascending: true })
      .limit(FOLLOW_UP_LIMIT),
    supabaseAdmin
      .from("data_subject_requests")
      .select(NOTIFIABLE_COLUMNS)
      .in("status", ["completed", "rejected"])
      .eq("metadata->notifications->closure->>status", "pending")
      .limit(FOLLOW_UP_LIMIT),
  ]);
  if (open.error) throw open.error;
  if (closing.error) throw closing.error;

  for (const row of open.data ?? []) {
    summary.operator[await sendOperatorNotification(row, env, fetchImpl)] += 1;
    summary.acknowledgement[await sendAcknowledgement(row, env, fetchImpl)] += 1;
  }
  for (const row of closing.data ?? []) {
    summary.closure[await sendClosure(row, env, fetchImpl)] += 1;
  }

  summary.evaluation = await evaluatePrivacyRequestAlerts(now);
  return summary;
}

/**
 * Alertes `compliance.privacy_requests.*` (migration 20261202100000). `migration_pending` tant que la
 * fonction n'existe pas (site déployé avant la migration) ; toute autre erreur remonte.
 */
async function evaluatePrivacyRequestAlerts(
  now: Date,
): Promise<Record<string, unknown> | "migration_pending"> {
  const { data, error } = await supabaseAdmin.rpc("evaluate_privacy_request_health", {
    p_now: now.toISOString(),
  });
  if (!error) return record(data as Json);
  if ((error as { code?: string }).code === "PGRST202") return "migration_pending";
  throw error;
}
