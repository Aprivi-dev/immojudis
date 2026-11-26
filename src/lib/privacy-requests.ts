import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, Tables } from "@/integrations/supabase/types";
import { findStripeCustomersOfAccount, getStripe } from "@/lib/billing-stripe";
import {
  collectProfessionalData,
  eraseProfessionalData,
  escapeLikePattern,
  type ProfessionalDataExport,
  type ProfessionalErasureReport,
} from "@/lib/information-agent-professional-rights";
import {
  privacyDeadlineStatus,
  WITHDRAWAL_PERIOD_DAYS,
  type PrivacyDeadlineStatus,
} from "@/lib/privacy-deadline";
import {
  notifyPrivacyRequestClosed,
  notifyPrivacyRequestReceived,
  withPendingClosure,
} from "@/lib/privacy-request-notifications";
import {
  ERASURE_CLOSED_WITHOUT_EXECUTION_CODES,
  ERASURE_EXECUTED_CODES,
  PRIVACY_REQUEST_TYPES,
  privacyRequestSubjectKind,
} from "@/lib/privacy-request-types";
import { PublicApiError } from "@/lib/api-errors";
import { normalizeEmail } from "@/lib/account";
import { formatDate } from "@/lib/format/dates";
import { isPlanPeriodActive } from "@/lib/plans";
import { ANALYSIS_CHECKOUT_EXPIRY_MINUTES } from "@/lib/analysis-offer";

const privacyRequestTypeSchema = z.enum(PRIVACY_REQUEST_TYPES);

const privacyRequestStatusSchema = z.enum([
  "received",
  "identity_verification",
  "in_review",
  "completed",
  "rejected",
]);

export const privacyRequestInputSchema = z
  .object({
    requestType: privacyRequestTypeSchema,
    message: z.string().trim().max(4000).optional(),
    /** Rétractation d'un achat à l'unité : l'achat visé, parmi ceux du compte (`withdrawablePurchases`). */
    purchaseId: z.string().guid().optional(),
  })
  .superRefine((input, context) => {
    if (input.purchaseId && input.requestType !== "contract_withdrawal") {
      context.addIssue({
        code: "custom",
        path: ["purchaseId"],
        message: "Un achat ne se choisit que pour une rétractation.",
      });
    }
  });

export const privacyRequestAdminUpdateSchema = z
  .object({
    requestId: z.string().guid(),
    status: privacyRequestStatusSchema,
    identityStatus: z
      .enum(["authenticated", "additional_verification_required", "verified"])
      .optional(),
    resolutionCode: z.string().trim().max(120).optional(),
    operatorNotes: z.string().trim().max(8000).optional(),
    /** Réponse au demandeur, reprise dans l'email de clôture (suites données, motifs d'un refus). */
    response: z.string().trim().max(2000).optional(),
  })
  .superRefine((input, context) => {
    if (["completed", "rejected"].includes(input.status) && !input.resolutionCode?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["resolutionCode"],
        message: "Un code de résolution est requis pour clôturer la demande.",
      });
    }
  });

export type PrivacyRequestType = z.infer<typeof privacyRequestTypeSchema>;
export type PrivacyRequestStatus = z.infer<typeof privacyRequestStatusSchema>;
export type PrivacyRequestInput = z.input<typeof privacyRequestInputSchema>;
export type PrivacyRequestAdminUpdate = z.infer<typeof privacyRequestAdminUpdateSchema>;

export type PrivacyRequestSummary = {
  id: string;
  requestType: PrivacyRequestType;
  status: PrivacyRequestStatus;
  identityStatus: string;
  message: string | null;
  submittedAt: string;
  /** Envoi réel de l'accusé de réception ; nul tant qu'il n'est pas parti. */
  acknowledgedAt: string | null;
  dueAt: string;
  completedAt: string | null;
  resolutionCode: string | null;
};

type NotificationStatus = "pending" | "sent" | "failed" | null;

export type PrivacyRequestAdminSummary = PrivacyRequestSummary & {
  requesterEmail: string;
  userId: string | null;
  /**
   * `account` : titulaire d'un compte (`userId`), ou ancien titulaire dont le compte est effacé.
   * `information_agent_professional` : professionnel contacté par l'agent d'information, sans compte,
   * vérifié par le lien signé de l'email.
   */
  subjectKind: "account" | "information_agent_professional";
  operatorNotes: string | null;
  deadline: PrivacyDeadlineStatus;
  /** Rétractation d'un achat à l'unité : l'achat visé ; nul pour l'abonnement. */
  withdrawalPurchaseId: string | null;
  /** Emails de suivi : état de chaque envoi (`null` : jamais tenté). */
  notifications: {
    operator: NotificationStatus;
    acknowledgement: NotificationStatus;
    closure: NotificationStatus;
  };
  /** Réponse au demandeur envoyée avec l'email de clôture. */
  closureResponse: string | null;
};

export const privacyErasureExecuteSchema = z.object({
  requestId: z.string().guid(),
  /** The operator retypes the requester's email: erasure is irreversible. */
  confirmEmail: z.string().trim().email().max(320),
  /**
   * Confirmation supplémentaire exigée quand la garde (`computeErasureGuard`) relève un abonnement actif,
   * un achat encore rétractable ou un crédit non utilisé : ce qui est payé est perdu avec le compte.
   */
  confirmFinancialImpact: z.literal(true).optional(),
});
export type PrivacyErasureExecuteInput = z.input<typeof privacyErasureExecuteSchema>;

export type PrivacyErasureReport = {
  request: PrivacyRequestAdminSummary;
  stripeCustomerDeleted: boolean;
  deletedRows: Record<string, number>;
  storageObjectsRemoved: number;
  /** Faux pour un professionnel sans compte : seules ses données de l'agent d'information sont effacées. */
  authUserDeleted: boolean;
};

/** Achat à l'unité payé dans le délai de rétractation (14 jours à compter du paiement). */
export type WithdrawablePurchase = {
  id: string;
  paidAt: string;
  amountCents: number;
  currency: string;
};

export type PrivacyRequestListResponse = {
  requests: PrivacyRequestSummary[];
  /** Achats à l'unité du compte dont la rétractation peut être demandée. */
  withdrawablePurchases: WithdrawablePurchase[];
};
export type PrivacyRequestAdminListResponse = {
  requests: PrivacyRequestAdminSummary[];
  total: number;
  openCount: number;
  overdueCount: number;
  truncated: boolean;
  offset: number;
  limit: number;
  hasMore: boolean;
};

type PrivacyRequestRow = Tables<"data_subject_requests">;

const USER_COLUMNS =
  "id,request_type,status,identity_status,message,submitted_at,acknowledged_at,due_at,completed_at,resolution_code";
const ADMIN_COLUMNS = `${USER_COLUMNS},requester_email,user_id,operator_notes,metadata`;
const OPEN_STATUSES = ["received", "identity_verification", "in_review"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Clé de `metadata` qui désigne l'objet d'une rétractation (absente : l'abonnement Analyse). */
const WITHDRAWAL_TARGET_KEY = "withdrawal_target";

function metadataRecord(value: Json | null | undefined): Record<string, Json | undefined> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** L'achat à l'unité visé par une rétractation, ou `null` pour l'abonnement. */
export function withdrawalPurchaseIdOf(metadata: Json | null | undefined): string | null {
  const target = metadataRecord(metadataRecord(metadata)[WITHDRAWAL_TARGET_KEY]);
  return target.kind === "sale_unlock_purchase" && typeof target.purchase_id === "string"
    ? target.purchase_id
    : null;
}

/**
 * Achat à l'unité déduit du premier mois d'un abonnement (`settle_unit_purchase_deduction`, migration
 * 20261122100000) : il reste `paid`, mais son prix a déjà été rendu par la remise. Il n'est plus un
 * crédit (même condition que `app_private.sale_unlock_credit_purchases`) ni remboursable seul.
 */
export function isDeductedPurchase(purchase: {
  deducted_checkout_session_id?: string | null;
}): boolean {
  return Boolean(purchase.deducted_checkout_session_id);
}

/**
 * Achat réservé par un checkout d'abonnement encore ouvert (`reserve_unit_purchase_deduction` : une
 * réservation vit `ANALYSIS_CHECKOUT_EXPIRY_MINUTES` minutes). Le rembourser maintenant laisserait la
 * déduction se régler sur un achat remboursé.
 */
export function hasLiveDeductionReservation(
  purchase: { deduction_reserved_token?: string | null; deduction_reserved_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (!purchase.deduction_reserved_token || !purchase.deduction_reserved_at) return false;
  const reservedAt = new Date(purchase.deduction_reserved_at).getTime();
  return reservedAt > now.getTime() - ANALYSIS_CHECKOUT_EXPIRY_MINUTES * 60_000;
}

type RecentPaidPurchase = WithdrawablePurchase & { deducted: boolean };

/** Achats à l'unité `paid` du compte payés depuis moins de `WITHDRAWAL_PERIOD_DAYS` jours. */
async function listRecentPaidPurchases(
  userId: string,
  now: Date = new Date(),
): Promise<RecentPaidPurchase[]> {
  const since = new Date(now.getTime() - WITHDRAWAL_PERIOD_DAYS * DAY_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("sale_unlock_purchases")
    .select("id,paid_at,amount_cents,currency,deducted_checkout_session_id")
    .eq("user_id", userId)
    .eq("state", "paid")
    .gt("paid_at", since)
    .order("paid_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []).flatMap((row) =>
    row.paid_at
      ? [
          {
            id: row.id,
            paidAt: row.paid_at,
            amountCents: row.amount_cents,
            currency: row.currency,
            deducted: isDeductedPurchase(row),
          },
        ]
      : [],
  );
}

/**
 * Achats à l'unité du compte payés depuis moins de `WITHDRAWAL_PERIOD_DAYS` jours, pas encore
 * remboursés ni déduits d'un abonnement : ceux dont la rétractation peut être demandée.
 */
async function listWithdrawablePurchases(
  userId: string,
  now: Date = new Date(),
): Promise<WithdrawablePurchase[]> {
  return (await listRecentPaidPurchases(userId, now)).flatMap(({ deducted, ...purchase }) =>
    deducted ? [] : [purchase],
  );
}

export async function createPrivacyRequest({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof privacyRequestInputSchema>;
}): Promise<PrivacyRequestSummary> {
  const requesterEmail = typeof auth.claims.email === "string" ? auth.claims.email.trim() : "";
  if (!requesterEmail) throw new PublicApiError("Une adresse email vérifiée est requise.", 400);

  const { count, error: countError } = await supabaseAdmin
    .from("data_subject_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .in("status", OPEN_STATUSES);
  if (countError) throw countError;
  if ((count ?? 0) >= 5) {
    throw new PublicApiError(
      "Trop de demandes ouvertes. Attendez le traitement d’une demande existante.",
      429,
    );
  }

  if (input.purchaseId) {
    const purchases = await listWithdrawablePurchases(auth.userId);
    if (!purchases.some((purchase) => purchase.id === input.purchaseId)) {
      throw new PublicApiError(
        `Cet achat n’est pas rétractable depuis cet espace : il doit avoir été payé il y a moins de ${WITHDRAWAL_PERIOD_DAYS} jours et ne pas avoir été déduit d’un abonnement.`,
        400,
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .insert({
      user_id: auth.userId,
      requester_email: requesterEmail,
      request_type: input.requestType,
      message: input.message || null,
      metadata: {
        source: "authenticated_rights_portal",
        ...(input.purchaseId
          ? {
              [WITHDRAWAL_TARGET_KEY]: {
                kind: "sale_unlock_purchase",
                purchase_id: input.purchaseId,
              },
            }
          : {}),
      },
    })
    .select(`${USER_COLUMNS},requester_email,user_id,metadata`)
    .single();
  if (error) throw error;
  // Exploitation prévenue, accusé de réception au demandeur : jamais une cause d'échec du dépôt.
  await notifyPrivacyRequestReceived(data);
  return toPrivacyRequestSummary(data);
}

export async function listPrivacyRequests(
  auth: SupabaseAuthContext,
): Promise<PrivacyRequestListResponse> {
  const [{ data, error }, withdrawablePurchases] = await Promise.all([
    supabaseAdmin
      .from("data_subject_requests")
      .select(USER_COLUMNS)
      .eq("user_id", auth.userId)
      .order("submitted_at", { ascending: false })
      .limit(50),
    listWithdrawablePurchases(auth.userId),
  ]);
  if (error) throw error;
  return {
    requests: (data ?? []).map((row) =>
      toPrivacyRequestSummary(row as Pick<PrivacyRequestRow, UserColumn>),
    ),
    withdrawablePurchases,
  };
}

export async function listPrivacyRequestsForAdmin(
  auth: SupabaseAuthContext,
  { offset = 0, limit = 100 }: { offset?: number; limit?: number } = {},
): Promise<PrivacyRequestAdminListResponse> {
  assertAdmin(auth);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const now = new Date().toISOString();
  const [
    { data, error, count: totalCount },
    { count: openCount, error: openError },
    { count: overdueCount, error: overdueError },
  ] = await Promise.all([
    supabaseAdmin
      .from("data_subject_requests")
      .select(ADMIN_COLUMNS, { count: "exact" })
      .order("submitted_at", { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1),
    supabaseAdmin
      .from("data_subject_requests")
      .select("id", { count: "exact", head: true })
      .in("status", OPEN_STATUSES),
    supabaseAdmin
      .from("data_subject_requests")
      .select("id", { count: "exact", head: true })
      .in("status", OPEN_STATUSES)
      .lt("due_at", now),
  ]);
  if (error) throw error;
  if (openError) throw openError;
  if (overdueError) throw overdueError;
  return {
    requests: (data ?? []).map((row) =>
      toAdminSummary(row as Pick<PrivacyRequestRow, AdminColumn>),
    ),
    total: totalCount ?? data?.length ?? 0,
    openCount: openCount ?? 0,
    overdueCount: overdueCount ?? 0,
    truncated: (totalCount ?? data?.length ?? 0) > (data?.length ?? 0),
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + (data?.length ?? 0) < (totalCount ?? 0),
  };
}

async function readAdminRequest(requestId: string): Promise<Pick<PrivacyRequestRow, AdminColumn>> {
  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .select(ADMIN_COLUMNS)
    .eq("id", requestId)
    .single();
  if (error) throw error;
  return data as Pick<PrivacyRequestRow, AdminColumn>;
}

function isClosed(status: string): boolean {
  return status === "completed" || status === "rejected";
}

/** F4 : une demande d'effacement n'est « Traitée » que par l'exécution, ou par un code sans exécution. */
function assertErasureClosure(
  current: Pick<PrivacyRequestRow, "request_type" | "status" | "resolution_code">,
  input: PrivacyRequestAdminUpdate,
): void {
  if (current.request_type !== "erasure" || input.status !== "completed") return;
  const code = input.resolutionCode?.trim() ?? "";
  const executed =
    current.status === "completed" &&
    (ERASURE_EXECUTED_CODES as readonly string[]).includes(current.resolution_code ?? "");
  if ((executed && code === current.resolution_code) || isClosedWithoutExecution(code)) return;
  throw new PublicApiError(
    `Une demande d'effacement passe à « Traitée » par « Exécuter l'effacement », ou avec le code ${ERASURE_CLOSED_WITHOUT_EXECUTION_CODES.join(" ou ")} quand rien n'est à effacer.`,
    409,
  );
}

function isClosedWithoutExecution(code: string): boolean {
  return (ERASURE_CLOSED_WITHOUT_EXECUTION_CODES as readonly string[]).includes(code);
}

export async function updatePrivacyRequestForAdmin({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: PrivacyRequestAdminUpdate;
}): Promise<PrivacyRequestAdminSummary> {
  assertAdmin(auth);
  const current = await readAdminRequest(input.requestId);
  assertErasureClosure(current, input);
  const terminal = isClosed(input.status);
  const closing = terminal && !isClosed(current.status);
  // Art. 12.4 RGPD : un refus est motivé auprès du demandeur, dans l'email de clôture.
  if (closing && input.status === "rejected" && !input.response?.trim()) {
    throw new PublicApiError("Indiquez au demandeur les motifs du refus.", 400);
  }
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("data_subject_requests")
    .update({
      status: input.status,
      identity_status: input.identityStatus,
      resolution_code: input.resolutionCode || null,
      operator_notes: input.operatorNotes || null,
      completed_at: terminal ? now : null,
      ...(closing
        ? {
            metadata: withPendingClosure(current.metadata, {
              status: input.status as "completed" | "rejected",
              closedAt: now,
              erasureExecuted: false,
              response: input.response ?? null,
            }),
          }
        : {}),
    })
    .eq("id", input.requestId)
    .select(ADMIN_COLUMNS)
    .single();
  if (error) throw error;
  const typed = data as Pick<PrivacyRequestRow, AdminColumn>;
  if (closing) await notifyPrivacyRequestClosed(typed);
  return toAdminSummary(typed);
}

// Application data owned by the requester, deleted explicitly (with counts for the audit trail)
// before the auth user is removed; every one of these also cascades from auth.users, except
// sale_workspace_collaborators.collaborator_user_id (`on delete set null`: the invitation would stay,
// with the invited address). Records the law obliges us to keep stay out: data_subject_requests
// (proof of handling), commercial_acceptances and valuation_estimates are detached (user_id set null)
// by their foreign keys. `privacy-erasure-tables.test.ts` compares this list with the schema.
export const ERASURE_TABLES: ReadonlyArray<readonly [table: string, column: string]> = [
  ["user_alerts", "user_id"],
  ["user_alert_matches", "user_id"],
  ["user_alert_notifications", "user_id"],
  ["user_favorites", "user_id"],
  ["user_followed_sale_snapshots", "user_id"],
  ["user_investor_profiles", "user_id"],
  ["account_product_events", "user_id"],
  ["sale_signal_feedback", "user_id"],
  ["sale_reminder_dispatches", "user_id"],
  ["weekly_digest_dispatches", "user_id"],
  ["sale_result_dispatches", "user_id"],
  ["launch_offer_end_notices", "user_id"],
  ["launch_offer_end_notice_optouts", "user_id"],
  ["onboarding_email_notices", "user_id"],
  ["onboarding_email_optouts", "user_id"],
  ["user_watched_zones", "user_id"],
  ["user_sale_change_events", "user_id"],
  ["user_sale_unlocks", "user_id"],
  // Achats à l'unité : après les déblocages, qui les référencent.
  ["sale_unlock_purchases", "user_id"],
  ["user_sale_watch_snapshots", "user_id"],
  ["user_sale_analysis_items", "user_id"],
  ["user_sale_analysis_sets", "user_id"],
  ["saved_property_reports", "user_id"],
  ["property_report_exports", "user_id"],
  ["sale_data_exports", "user_id"],
  ["sale_workspace_annotations", "author_id"],
  ["sale_workspace_collaborators", "owner_id"],
  ["sale_workspace_collaborators", "invited_by"],
  // Invitations reçues par le compte (les invitations à son adresse sans compte : voir l'effacement).
  ["sale_workspace_collaborators", "collaborator_user_id"],
  ["sale_workspaces", "user_id"],
  ["lawyer_referral_requests", "requester_id"],
  ["listing_publication_requests", "requester_id"],
  ["data_refresh_requests", "user_id"],
  ["feature_usage_events", "user_id"],
  ["user_api_keys", "user_id"],
  ["user_notification_preferences", "user_id"],
  ["offer_opening_notifications", "user_id"],
  ["email_send_log", "user_id"],
  ["information_agent_messages", "user_id"],
  ["information_agent_missions", "user_id"],
  ["information_agent_case_subscribers", "user_id"],
  ["stripe_checkout_access_grants", "user_id"],
  ["stripe_payment_lifecycle", "user_id"],
  ["user_subscriptions", "user_id"],
  ["user_profiles", "user_id"],
];

/**
 * Lignes qui EMPÊCHENT la suppression du compte (`on delete restrict` vers `auth.users`) : elles sont
 * comptées avant toute suppression, et l'effacement est refusé tant qu'il en reste (sinon il échouerait
 * à la suppression du compte, après avoir déjà effacé ses données). `privacy-erasure-tables.test.ts`
 * vérifie que toute clé `restrict` ou `no action` vers les comptes figure ici.
 */
export const ERASURE_BLOCKING_REFERENCES: ReadonlyArray<
  readonly [table: string, column: string, label: string]
> = [
  [
    "information_agent_cases",
    "created_by",
    "dossier(s) de l'agent d'information créé(s) par ce compte",
  ],
  [
    "outcome_claim_eligibility_decisions",
    "reviewer_user_id",
    "décision(s) de relecture des résultats signée(s) par ce compte",
  ],
  [
    "adjudication_price_statistics_build_reviews",
    "reviewer_id",
    "relecture(s) des statistiques de prix signée(s) par ce compte",
  ],
];

const ERASURE_STORAGE_BUCKETS = ["listing-request-documents"] as const;

type DeleteResult = Promise<{
  count: number | null;
  error: { message?: string; code?: string } | null;
}>;
type DeleteBuilder = {
  from(name: string): {
    delete(options: { count: "exact" }): {
      eq(column: string, value: string): DeleteResult;
    };
  };
};
type CountBuilder = {
  from(name: string): {
    select(
      columns: string,
      options: { count: "exact"; head: true },
    ): {
      eq(column: string, value: string): DeleteResult;
    };
  };
};

export type ErasureGuard = {
  /** Ce qui sera perdu avec le compte, en français ; vide quand rien ne l'est. */
  reasons: string[];
  /** L'exécution exige `confirmFinancialImpact: true`. */
  requiresConfirmation: boolean;
};

/**
 * Garde avant effacement (M2) : abonnement Analyse actif, achat à l'unité encore rétractable, crédit
 * non utilisé. Le crédit se lit par la base (`account_sale_unlock_credits`, migration 20261202100000) ;
 * sans elle, il est « non vérifiable » et la confirmation est exigée quand même. Un achat récent déduit
 * d'un abonnement n'est pas un achat remboursable, mais il signale un abonnement conclu depuis peu, dont
 * la rétractation serait perdue : il exige aussi la confirmation, avec son propre motif.
 */
async function computeErasureGuard(userId: string, now: Date = new Date()): Promise<ErasureGuard> {
  const [subscription, purchases, credits] = await Promise.all([
    supabaseAdmin
      .from("user_subscriptions")
      .select("status,current_period_end")
      .eq("user_id", userId)
      .maybeSingle(),
    listRecentPaidPurchases(userId, now),
    supabaseAdmin.rpc("account_sale_unlock_credits", { p_user_id: userId }),
  ]);
  const withdrawable = purchases.filter((purchase) => !purchase.deducted).length;
  const deducted = purchases.length - withdrawable;
  if (subscription.error) throw subscription.error;
  const reasons: string[] = [];
  const period = subscription.data;
  if (period && isPlanPeriodActive(period.status, period.current_period_end, now)) {
    reasons.push(
      `Abonnement Analyse actif (période payée jusqu'au ${formatDate(period.current_period_end)}) : il sera résilié sans remboursement.`,
    );
  }
  if (withdrawable) {
    reasons.push(
      `${withdrawable} achat(s) à l'unité payé(s) depuis moins de ${WITHDRAWAL_PERIOD_DAYS} jours : une rétractation reste possible et sera perdue.`,
    );
  }
  if (deducted) {
    reasons.push(
      `${deducted} achat(s) à l'unité récent(s) déduit(s) du premier mois d'un abonnement : non remboursable(s) seul(s), mais la rétractation de cet abonnement reste possible et sera perdue.`,
    );
  }
  if (credits.error) {
    if ((credits.error as { code?: string }).code !== "PGRST202") throw credits.error;
    reasons.push(
      "Crédits d'achat à l'unité non vérifiables (migration 20261202100000 en attente).",
    );
  } else if ((credits.data ?? 0) > 0) {
    reasons.push(`${credits.data} crédit(s) d'achat à l'unité non utilisé(s) : ils seront perdus.`);
  }
  return { reasons, requiresConfirmation: reasons.length > 0 };
}

/** La garde d'une demande d'effacement, pour le panneau (avant l'exécution). */
export async function getErasureGuardForRequest({
  auth,
  requestId,
}: {
  auth: SupabaseAuthContext;
  requestId: string;
}): Promise<ErasureGuard> {
  assertAdmin(auth);
  const request = await readAdminRequest(requestId);
  if (request.request_type !== "erasure") {
    throw new PublicApiError("Cette demande n'est pas une demande d'effacement.", 409);
  }
  if (!request.user_id) return { reasons: [], requiresConfirmation: false };
  return computeErasureGuard(request.user_id);
}

/** F2 : refuse l'effacement, avant toute suppression, si une ligne retient le compte. */
async function assertNoBlockingReference(userId: string): Promise<void> {
  const blocking: string[] = [];
  for (const [table, column, label] of ERASURE_BLOCKING_REFERENCES) {
    const { count, error } = await (supabaseAdmin as unknown as CountBuilder)
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq(column, userId);
    if (error) throw new Error(`Erasure check failed in ${table}: ${error.message ?? "unknown"}`);
    if ((count ?? 0) > 0) blocking.push(`${count} ${label} (${table}.${column})`);
  }
  if (blocking.length) {
    throw new PublicApiError(
      `Effacement impossible en l'état, rien n'a été supprimé : ${blocking.join(" ; ")}. Ces lignes empêchent la suppression du compte : à réattribuer ou supprimer avant de relancer.`,
      409,
    );
  }
}

/** Compte visé par un effacement commencé : gardé dans la demande, qui perd `user_id` avec le compte. */
function erasureAccountIdOf(metadata: Json | null | undefined): string | null {
  const erasure = metadataRecord(metadataRecord(metadata).erasure);
  return typeof erasure.account_id === "string" ? erasure.account_id : null;
}

/**
 * Executes an erasure request: Stripe customers first (so a failure leaves the account intact and
 * the operation can be retried), then application data, uploaded files and finally the auth user.
 *
 * Reprise (F1) : la suppression du compte détache la demande (`user_id` nul). Une nouvelle tentative
 * après une clôture manquée retrouve le compte dans `metadata.erasure.account_id` (écrit avant toute
 * suppression), refait ce qui ne dépend pas du compte (clients Stripe, journal des emails et invitations
 * par adresse, fichiers) et clôt la demande au lieu d'échouer.
 */
export async function executePrivacyErasure({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: z.output<typeof privacyErasureExecuteSchema>;
}): Promise<PrivacyErasureReport> {
  assertAdmin(auth);
  const request = await readAdminRequest(input.requestId);

  if (request.request_type !== "erasure") {
    throw new PublicApiError("Cette demande n'est pas une demande d'effacement.", 409);
  }
  if (isClosed(request.status)) {
    throw new PublicApiError("Cette demande est déjà clôturée.", 409);
  }
  if (request.identity_status !== "verified") {
    throw new PublicApiError(
      "Vérifiez l'identité du demandeur avant d'exécuter l'effacement.",
      409,
    );
  }
  if (normalizeEmail(input.confirmEmail) !== normalizeEmail(request.requester_email)) {
    throw new PublicApiError(
      "L'adresse de confirmation ne correspond pas à celle du demandeur.",
      400,
    );
  }
  if (privacyRequestSubjectKind(request) === "information_agent_professional") {
    return executeProfessionalErasure({ auth, request });
  }

  const liveUserId = request.user_id;
  const accountId = liveUserId ?? erasureAccountIdOf(request.metadata);
  if (liveUserId) {
    if (liveUserId === auth.userId) {
      throw new PublicApiError(
        "Un administrateur ne peut pas effacer son propre compte depuis cet écran.",
        409,
      );
    }
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("user_profiles")
      .select("user_role")
      .eq("user_id", liveUserId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (profile?.user_role === "admin") {
      throw new PublicApiError(
        "Un compte administrateur ne peut pas être effacé automatiquement.",
        409,
      );
    }
    const guard = await computeErasureGuard(liveUserId);
    if (guard.requiresConfirmation && input.confirmFinancialImpact !== true) {
      throw new PublicApiError(
        `Confirmation supplémentaire requise : ${guard.reasons.join(" ")}`,
        409,
      );
    }
    await assertNoBlockingReference(liveUserId);
    await recordErasureStart(request, liveUserId, auth.userId);
  }

  const stripeCustomersDeleted = accountId ? await deleteStripeCustomers(accountId) : 0;

  const deletedRows: Record<string, number> = {};
  // Compte déjà supprimé : ses lignes sont parties en cascade avec lui.
  if (liveUserId) {
    for (const [table, column] of ERASURE_TABLES) {
      const { count, error } = await (supabaseAdmin as unknown as DeleteBuilder)
        .from(table)
        .delete({ count: "exact" })
        .eq(column, liveUserId);
      if (error) throw new Error(`Erasure failed in ${table}: ${error.message ?? "unknown error"}`);
      deletedRows[`${table}.${column}`] = count ?? 0;
    }
  }

  // Par l'adresse, en minuscules, que la personne a confirmée ci-dessus : le journal des emails envoyés
  // (envoi avant la création du compte, lien perdu) et les invitations à un espace de travail reçues à
  // cette adresse sans compte. Avant la suppression Auth : l'adresse y est encore.
  const address = normalizeEmail(request.requester_email);
  const { count: logCount, error: logError } = await (supabaseAdmin as unknown as DeleteBuilder)
    .from("email_send_log")
    .delete({ count: "exact" })
    .eq("to_address", address);
  if (logError) {
    throw new Error(`Erasure failed in email_send_log: ${logError.message ?? "unknown error"}`);
  }
  deletedRows["email_send_log.to_address"] = logCount ?? 0;
  deletedRows["sale_workspace_collaborators.invited_email"] =
    await deleteInvitationsToAddress(address);

  let storageObjectsRemoved = 0;
  if (accountId) {
    for (const bucket of ERASURE_STORAGE_BUCKETS) {
      storageObjectsRemoved += await removeUserStorageObjects(bucket, accountId);
    }
  }

  if (liveUserId) {
    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(liveUserId);
    // Déjà supprimé (course entre deux tentatives) : le but est atteint.
    if (deleteUserError && (deleteUserError as { status?: number }).status !== 404) {
      throw deleteUserError;
    }
  }

  const executedAt = new Date().toISOString();
  const report = {
    executed_at: executedAt,
    executed_by: auth.userId,
    account_already_deleted: !liveUserId,
    stripe_customers_deleted: stripeCustomersDeleted,
    storage_objects_removed: storageObjectsRemoved,
    deleted_rows: deletedRows,
  };
  const closed = await closeErasure(request, "erasure_executed", report, executedAt);
  return {
    request: closed,
    stripeCustomerDeleted: stripeCustomersDeleted > 0,
    deletedRows,
    storageObjectsRemoved,
    authUserDeleted: true,
  };
}

const INVITATION_PAGE_SIZE = 1000;
const INVITATION_DELETE_CHUNK = 100;

/**
 * Invitations à un espace de travail envoyées à `address` (déjà normalisée). `ilike` ne fait que réduire
 * la lecture (PostgREST lit `*` comme `%`) : seule l'égalité exacte de l'adresse normalisée retient une
 * ligne, puis la suppression vise ces identifiants. Rend le nombre de lignes supprimées.
 */
async function deleteInvitationsToAddress(address: string): Promise<number> {
  const ids: string[] = [];
  for (let from = 0; ; from += INVITATION_PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("sale_workspace_collaborators")
      .select("id,invited_email")
      .ilike("invited_email", escapeLikePattern(address))
      .order("id")
      .range(from, from + INVITATION_PAGE_SIZE - 1);
    if (error) {
      throw new Error(
        `Erasure failed in sale_workspace_collaborators: ${error.message ?? "unknown error"}`,
      );
    }
    for (const row of data ?? []) {
      if (normalizeEmail(row.invited_email) === address) ids.push(row.id);
    }
    if ((data?.length ?? 0) < INVITATION_PAGE_SIZE) break;
  }
  let deleted = 0;
  for (let index = 0; index < ids.length; index += INVITATION_DELETE_CHUNK) {
    const { count, error } = await supabaseAdmin
      .from("sale_workspace_collaborators")
      .delete({ count: "exact" })
      .in("id", ids.slice(index, index + INVITATION_DELETE_CHUNK));
    if (error) {
      throw new Error(
        `Erasure failed in sale_workspace_collaborators: ${error.message ?? "unknown error"}`,
      );
    }
    deleted += count ?? 0;
  }
  return deleted;
}

/** Garde le compte visé dans la demande, avant toute suppression (reprise F1). */
async function recordErasureStart(
  request: Pick<PrivacyRequestRow, AdminColumn>,
  userId: string,
  adminId: string,
): Promise<void> {
  const metadata = metadataRecord(request.metadata);
  const { error } = await supabaseAdmin
    .from("data_subject_requests")
    .update({
      metadata: {
        ...metadata,
        erasure: { account_id: userId, started_at: new Date().toISOString(), started_by: adminId },
      },
    })
    .eq("id", request.id);
  if (error) throw error;
}

/** Clôt une demande d'effacement exécutée, puis envoie l'email de clôture à `requester_email`. */
async function closeErasure(
  request: Pick<PrivacyRequestRow, AdminColumn>,
  resolutionCode: (typeof ERASURE_EXECUTED_CODES)[number],
  report: Record<string, unknown>,
  executedAt: string,
): Promise<PrivacyRequestAdminSummary> {
  const current = await readAdminRequest(request.id);
  const { data: closed, error: closeError } = await supabaseAdmin
    .from("data_subject_requests")
    .update({
      status: "completed",
      resolution_code: resolutionCode,
      completed_at: executedAt,
      operator_notes: [current.operator_notes, `Effacement exécuté: ${JSON.stringify(report)}`]
        .filter(Boolean)
        .join("\n")
        .slice(0, 8000),
      metadata: withPendingClosure(current.metadata, {
        status: "completed",
        closedAt: executedAt,
        erasureExecuted: true,
        response: null,
      }),
    })
    .eq("id", request.id)
    .select(ADMIN_COLUMNS)
    .single();
  if (closeError) throw closeError;
  const typed = closed as Pick<PrivacyRequestRow, AdminColumn>;
  await notifyPrivacyRequestClosed(typed);
  return toAdminSummary(typed);
}

/**
 * Copie des données d'un professionnel sans compte (demande d'accès ou de portabilité vérifiée par le
 * lien signé de l'email). Réservé aux administrateurs ; l'export est remis à l'adresse du demandeur.
 */
export async function exportProfessionalPrivacyData({
  auth,
  requestId,
}: {
  auth: SupabaseAuthContext;
  requestId: string;
}): Promise<ProfessionalDataExport> {
  assertAdmin(auth);
  const request = await readAdminRequest(requestId);
  if (
    privacyRequestSubjectKind(request) !== "information_agent_professional" ||
    !["access", "portability"].includes(request.request_type)
  ) {
    throw new PublicApiError(
      "Cette demande n'est pas une demande d'accès d'un professionnel.",
      409,
    );
  }
  if (request.identity_status !== "verified") {
    throw new PublicApiError("Vérifiez l'identité du demandeur avant d'exporter ses données.", 409);
  }
  return collectProfessionalData(request.requester_email);
}

/**
 * Effacement demandé par un professionnel sans compte : ses messages, dossiers et pièces de l'agent
 * d'information. L'administrateur retape l'adresse, comme pour un compte (vérifié par l'appelant).
 */
async function executeProfessionalErasure({
  auth,
  request,
}: {
  auth: SupabaseAuthContext;
  request: Pick<PrivacyRequestRow, AdminColumn>;
}): Promise<PrivacyErasureReport> {
  const erased: ProfessionalErasureReport = await eraseProfessionalData(request.requester_email);
  const executedAt = new Date().toISOString();
  const report = {
    executed_at: executedAt,
    executed_by: auth.userId,
    kind: "information_agent_professional",
    storage_objects_queued: erased.storageObjectsQueued,
    deleted_rows: erased.deletedRows,
  };
  const closed = await closeErasure(
    request,
    "information_agent_professional_erasure_executed",
    report,
    executedAt,
  );
  return {
    request: closed,
    stripeCustomerDeleted: false,
    deletedRows: erased.deletedRows,
    storageObjectsRemoved: erased.storageObjectsQueued,
    authUserDeleted: false,
  };
}

/**
 * M1 : tous les clients Stripe du compte, celui de l'abonnement (`user_subscriptions`) et ceux que la
 * recherche par métadonnée `user_id` retrouve (achats à l'unité : la base n'en garde pas l'identifiant).
 * Un client déjà supprimé chez Stripe compte comme supprimé. Rend le nombre de clients supprimés.
 */
async function deleteStripeCustomers(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("user_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const stripe = getStripe();
  const found = await findStripeCustomersOfAccount(stripe, userId);
  const ids = new Set([
    ...(data?.stripe_customer_id ? [data.stripe_customer_id] : []),
    ...found.map((customer) => customer.id),
  ]);
  for (const customerId of ids) {
    try {
      await stripe.customers.del(customerId);
    } catch (stripeError) {
      // Already deleted on the Stripe side: the goal is reached, keep going.
      if ((stripeError as { code?: string }).code !== "resource_missing") throw stripeError;
    }
  }
  return ids.size;
}

async function removeUserStorageObjects(bucket: string, userId: string): Promise<number> {
  const storage = supabaseAdmin.storage.from(bucket);
  const paths: string[] = [];
  const { data: folders, error } = await storage.list(userId, { limit: 1000 });
  if (error) throw error;
  for (const entry of folders ?? []) {
    if (entry.id) {
      paths.push(`${userId}/${entry.name}`);
      continue;
    }
    const { data: files, error: listError } = await storage.list(`${userId}/${entry.name}`, {
      limit: 1000,
    });
    if (listError) throw listError;
    for (const file of files ?? []) paths.push(`${userId}/${entry.name}/${file.name}`);
  }
  if (!paths.length) return 0;
  const { error: removeError } = await storage.remove(paths);
  if (removeError) throw removeError;
  return paths.length;
}

type UserColumn =
  | "id"
  | "request_type"
  | "status"
  | "identity_status"
  | "message"
  | "submitted_at"
  | "acknowledged_at"
  | "due_at"
  | "completed_at"
  | "resolution_code";
type AdminColumn = UserColumn | "requester_email" | "user_id" | "operator_notes" | "metadata";

function notificationStatus(value: Json | undefined): NotificationStatus {
  const status = metadataRecord(value).status;
  return status === "pending" || status === "sent" || status === "failed" ? status : null;
}

function toAdminSummary(row: Pick<PrivacyRequestRow, AdminColumn>): PrivacyRequestAdminSummary {
  const notifications = metadataRecord(metadataRecord(row.metadata).notifications);
  const closureResponse = metadataRecord(notifications.closure).response;
  return {
    ...toPrivacyRequestSummary(row),
    requesterEmail: row.requester_email,
    userId: row.user_id,
    subjectKind: privacyRequestSubjectKind(row),
    operatorNotes: row.operator_notes,
    deadline: privacyDeadlineStatus(row.due_at, row.status),
    withdrawalPurchaseId: withdrawalPurchaseIdOf(row.metadata),
    notifications: {
      operator: notificationStatus(notifications.operator),
      acknowledgement: notificationStatus(notifications.acknowledgement),
      closure: notificationStatus(notifications.closure),
    },
    closureResponse: typeof closureResponse === "string" ? closureResponse : null,
  };
}

function toPrivacyRequestSummary(row: Pick<PrivacyRequestRow, UserColumn>): PrivacyRequestSummary {
  return {
    id: row.id,
    requestType: privacyRequestTypeSchema.parse(row.request_type),
    status: privacyRequestStatusSchema.parse(row.status),
    identityStatus: row.identity_status,
    message: row.message,
    submittedAt: row.submitted_at,
    acknowledgedAt: row.acknowledged_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    resolutionCode: row.resolution_code,
  };
}
