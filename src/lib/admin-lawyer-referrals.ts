import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  resolveEmailAlertDeliveryConfig,
  sendResendEmail,
  type ResendEmailMessage,
} from "@/lib/email-alerts";
import { cleanSaleTitle } from "@/lib/sale-title";

type LawyerReferralRow = Database["public"]["Tables"]["lawyer_referral_requests"]["Row"];
type LawyerReferralUpdate = Database["public"]["Tables"]["lawyer_referral_requests"]["Update"];
type ReferencedLawyerRow = Database["public"]["Tables"]["referenced_lawyers"]["Row"];
type ReferencedLawyerEmailTarget = Pick<
  ReferencedLawyerRow,
  "id" | "display_name" | "firm_name" | "email" | "bar_association" | "city" | "department"
>;
type AssignableReferencedLawyer = Pick<
  ReferencedLawyerRow,
  | "id"
  | "status"
  | "paid_placement_status"
  | "accepts_judicial_auctions"
  | "paid_placement_starts_at"
  | "paid_placement_ends_at"
>;

export type AdminLawyerReferralEmailDelivery = {
  status: "sent" | "skipped" | "failed";
  provider: "resend";
  recipient: string | null;
  messageId: string | null;
  detail: string | null;
  attemptedAt: string;
};

type LawyerReferralEmailDeliveryState = Pick<
  LawyerReferralRow,
  "sent_at" | "requested_lawyer_id" | "metadata"
>;

const referralStatusSchema = z.enum([
  "new",
  "manual_review",
  "sent_to_lawyer",
  "responded",
  "closed",
  "cancelled",
]);

const optionalUuidSchema = z
  .string()
  .trim()
  .uuid()
  .nullable()
  .optional()
  .or(z.literal("").transform(() => null));

export const adminLawyerReferralUpdateInputSchema = z.object({
  id: z.string().uuid(),
  status: referralStatusSchema,
  requestedLawyerId: optionalUuidSchema,
  adminNotes: z
    .string()
    .trim()
    .max(2_000)
    .nullable()
    .optional()
    .transform((value) => (value ? value : null)),
});

export type AdminLawyerReferralUpdateInput = z.input<typeof adminLawyerReferralUpdateInputSchema>;
export type AdminLawyerReferralUpdatePayload = z.output<
  typeof adminLawyerReferralUpdateInputSchema
>;

export type AdminLawyerReferralLawyerOption = {
  id: string;
  displayName: string;
  firmName: string | null;
  barAssociation: string | null;
  city: string | null;
  department: string | null;
};

export type AdminLawyerReferralSummary = {
  id: string;
  status: LawyerReferralRow["status"];
  matchingStatus: LawyerReferralRow["matching_status"];
  requestedLawyerId: string | null;
  requestedLawyer: AdminLawyerReferralLawyerOption | null;
  requesterEmail: string | null;
  requesterId: string;
  saleId: string | null;
  sale: {
    id: string | null;
    title: string | null;
    city: string | null;
    department: string | null;
    tribunal: string | null;
    tribunalCode: string | null;
    saleDate: string | null;
    startingPriceEur: number | null;
  };
  preferredContactMethod: LawyerReferralRow["preferred_contact_method"];
  phone: string | null;
  message: string | null;
  financingReady: boolean | null;
  maxBidEur: number | null;
  adminNotes: string | null;
  emailDelivery: AdminLawyerReferralEmailDelivery | null;
  assignedAt: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminLawyerReferralListResponse = {
  requests: AdminLawyerReferralSummary[];
  lawyers: AdminLawyerReferralLawyerOption[];
  totalCount: number;
  openCount: number;
  truncated: boolean;
  offset: number;
  limit: number;
  hasMore: boolean;
};

export type AdminLawyerReferralUpdateResponse = {
  request: AdminLawyerReferralSummary;
};

export async function listAdminLawyerReferralRequests(
  authToken: string,
  { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
): Promise<AdminLawyerReferralListResponse> {
  await assertAdminAuth(authToken);
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));

  const [
    { data: requestRows, error: requestError, count: totalCount },
    { count: openCount, error: openCountError },
    lawyerOptions,
  ] = await Promise.all([
    supabaseAdmin
      .from("lawyer_referral_requests")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1),
    supabaseAdmin
      .from("lawyer_referral_requests")
      .select("id", { count: "exact", head: true })
      .in("status", ["new", "manual_review", "sent_to_lawyer"]),
    listAssignableReferencedLawyers(),
  ]);

  if (requestError) throw requestError;
  if (openCountError) throw openCountError;

  const requestedLawyerIds = (requestRows ?? [])
    .map((request) => request.requested_lawyer_id)
    .filter(Boolean) as string[];
  const lawyerById = await getReferencedLawyersById([
    ...requestedLawyerIds,
    ...lawyerOptions.map((lawyer) => lawyer.id),
  ]);

  return {
    requests: (requestRows ?? []).map((request) =>
      referralRequestToSummary(request, lawyerById.get(request.requested_lawyer_id ?? "") ?? null),
    ),
    lawyers: lawyerOptions,
    totalCount: totalCount ?? requestRows?.length ?? 0,
    openCount: openCount ?? 0,
    truncated: (totalCount ?? requestRows?.length ?? 0) > (requestRows?.length ?? 0),
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + (requestRows?.length ?? 0) < (totalCount ?? 0),
  };
}

export async function updateAdminLawyerReferralRequest({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminLawyerReferralUpdatePayload;
}): Promise<AdminLawyerReferralUpdateResponse> {
  const auth = await assertAdminAuth(authToken);
  const existing = await getReferralRequest(input.id);
  const requestedLawyerId =
    input.requestedLawyerId === undefined ? existing.requested_lawyer_id : input.requestedLawyerId;
  const assignmentChanged = requestedLawyerId !== existing.requested_lawyer_id;
  const shouldDispatch = shouldDispatchReferencedLawyerEmail({
    existing,
    request: {
      status: input.status,
      requested_lawyer_id: requestedLawyerId,
      metadata: existing.metadata,
    },
  });
  if (
    input.status === "sent_to_lawyer" &&
    (!existing.sent_at || assignmentChanged || shouldDispatch)
  ) {
    await assertAssignableReferencedLawyer(requestedLawyerId);
  }
  const payload = adminLawyerReferralUpdatePayload({
    existing,
    input,
    updatedBy: auth.userId,
  });

  const { data, error } = await supabaseAdmin
    .from("lawyer_referral_requests")
    .update(payload)
    .eq("id", input.id)
    .select("*")
    .single();

  if (error) throw error;

  const emailDelivery = await dispatchReferencedLawyerEmailIfNeeded({
    existing,
    request: data,
  });
  const requestRow = emailDelivery
    ? await recordLawyerReferralEmailDelivery(data, emailDelivery)
    : data;

  const lawyerById = await getReferencedLawyersById(
    requestRow.requested_lawyer_id ? [requestRow.requested_lawyer_id] : [],
  );
  return {
    request: referralRequestToSummary(
      requestRow,
      lawyerById.get(requestRow.requested_lawyer_id ?? "") ?? null,
    ),
  };
}

export function adminLawyerReferralUpdatePayload({
  existing,
  input,
  updatedBy,
  now = new Date(),
}: {
  existing: Pick<
    LawyerReferralRow,
    | "status"
    | "matching_status"
    | "requested_lawyer_id"
    | "assigned_at"
    | "sent_at"
    | "responded_at"
    | "metadata"
  >;
  input: AdminLawyerReferralUpdatePayload;
  updatedBy: string;
  now?: Date;
}): LawyerReferralUpdate {
  const assignedLawyerId =
    input.requestedLawyerId === undefined ? existing.requested_lawyer_id : input.requestedLawyerId;
  const timestamp = now.toISOString();
  const assignmentChanged = assignedLawyerId !== existing.requested_lawyer_id;

  return {
    status: input.status,
    requested_lawyer_id: assignedLawyerId,
    matching_status: assignedLawyerId
      ? "matched"
      : input.status === "manual_review"
        ? "manual_review"
        : existing.matching_status,
    admin_notes: input.adminNotes,
    assigned_at: assignedLawyerId && !existing.assigned_at ? timestamp : existing.assigned_at,
    sent_at:
      input.status === "sent_to_lawyer" && (!existing.sent_at || assignmentChanged)
        ? timestamp
        : existing.sent_at,
    responded_at:
      input.status === "responded" && !existing.responded_at ? timestamp : existing.responded_at,
    metadata: asJson({
      ...jsonObject(existing.metadata),
      last_admin_update: {
        updated_by: updatedBy,
        updated_at: timestamp,
        previous_status: existing.status,
        next_status: input.status,
        requested_lawyer_id: assignedLawyerId,
      },
    }),
  };
}

async function assertAdminAuth(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }
  return auth;
}

async function getReferralRequest(id: string): Promise<LawyerReferralRow> {
  const { data, error } = await supabaseAdmin
    .from("lawyer_referral_requests")
    .select("*")
    .eq("id", id)
    .single();

  if (error) throw error;
  return data;
}

async function listAssignableReferencedLawyers(): Promise<AdminLawyerReferralLawyerOption[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select("id,display_name,firm_name,bar_association,city,department,priority_weight")
    .eq("status", "active")
    .in("paid_placement_status", ["trial", "active"])
    .eq("accepts_judicial_auctions", true)
    .or("paid_placement_starts_at.is.null,paid_placement_starts_at.lte." + now)
    .or("paid_placement_ends_at.is.null,paid_placement_ends_at.gte." + now)
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true })
    .limit(100);

  if (error) throw error;
  return (data ?? []).map(referencedLawyerToOption);
}

export function isReferencedLawyerPlacementActive(
  lawyer: Pick<
    AssignableReferencedLawyer,
    | "status"
    | "paid_placement_status"
    | "accepts_judicial_auctions"
    | "paid_placement_starts_at"
    | "paid_placement_ends_at"
  >,
  now = new Date(),
): boolean {
  if (
    lawyer.status !== "active" ||
    !["trial", "active"].includes(lawyer.paid_placement_status) ||
    !lawyer.accepts_judicial_auctions
  ) {
    return false;
  }
  return isPlacementWindowActive(
    lawyer.paid_placement_starts_at,
    lawyer.paid_placement_ends_at,
    now,
  );
}

async function assertAssignableReferencedLawyer(lawyerId: string | null): Promise<void> {
  if (!lawyerId) {
    throw new Error("Un avocat référencé éligible doit être assigné avant l'envoi.");
  }

  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select(
      "id,status,paid_placement_status,accepts_judicial_auctions,paid_placement_starts_at,paid_placement_ends_at",
    )
    .eq("id", lawyerId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !isReferencedLawyerPlacementActive(data)) {
    throw new Error(
      "Cet avocat n'est pas éligible : fiche active, adjudications acceptées et placement payant en cours requis.",
    );
  }
}

function isPlacementWindowActive(
  startsAt: string | null,
  endsAt: string | null,
  now: Date,
): boolean {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return false;
  const startsTime = parsePlacementDate(startsAt);
  const endsTime = parsePlacementDate(endsAt);
  if (startsAt && startsTime == null) return false;
  if (endsAt && endsTime == null) return false;
  return (startsTime == null || startsTime <= nowTime) && (endsTime == null || endsTime >= nowTime);
}

function parsePlacementDate(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function getReferencedLawyersById(
  lawyerIds: string[],
): Promise<Map<string, AdminLawyerReferralLawyerOption>> {
  const uniqueIds = Array.from(new Set(lawyerIds.filter(Boolean)));
  if (!uniqueIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select("id,display_name,firm_name,bar_association,city,department")
    .in("id", uniqueIds);

  if (error) throw error;
  return new Map((data ?? []).map((lawyer) => [lawyer.id, referencedLawyerToOption(lawyer)]));
}

export function shouldDispatchReferencedLawyerEmail({
  existing,
  request,
}: {
  existing: LawyerReferralEmailDeliveryState;
  request: Pick<LawyerReferralRow, "status" | "requested_lawyer_id" | "metadata">;
}): boolean {
  if (request.status !== "sent_to_lawyer") return false;

  const reassigned = request.requested_lawyer_id !== existing.requested_lawyer_id;
  if (reassigned || !existing.sent_at) return true;

  const previousDelivery = normalizeEmailDelivery(
    jsonObject(existing.metadata).lawyer_email_delivery,
  );
  return previousDelivery?.status === "failed" || previousDelivery?.status === "skipped";
}

async function dispatchReferencedLawyerEmailIfNeeded({
  existing,
  request,
  now = new Date(),
  env = process.env,
  fetchImpl = fetch,
}: {
  existing: LawyerReferralEmailDeliveryState;
  request: LawyerReferralRow;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
  fetchImpl?: typeof fetch;
}): Promise<AdminLawyerReferralEmailDelivery | null> {
  if (!shouldDispatchReferencedLawyerEmail({ existing, request })) return null;

  const attemptedAt = now.toISOString();
  if (!request.requested_lawyer_id) {
    return {
      status: "skipped",
      provider: "resend",
      recipient: null,
      messageId: null,
      detail: "Aucun avocat référencé assigné à la demande.",
      attemptedAt,
    };
  }

  const lawyer = await getReferencedLawyerEmailTarget(request.requested_lawyer_id);
  const recipient = lawyer?.email?.trim() || null;
  if (!lawyer || !recipient) {
    return {
      status: "skipped",
      provider: "resend",
      recipient,
      messageId: null,
      detail: "Aucune adresse email renseignée sur la fiche avocat référencée.",
      attemptedAt,
    };
  }

  const config = resolveEmailAlertDeliveryConfig(env);
  if (!config.configured || !config.apiKey || !config.from || !config.appUrl) {
    return {
      status: "skipped",
      provider: "resend",
      recipient,
      messageId: null,
      detail: `Configuration email incomplète: ${config.missing.join(", ")}`,
      attemptedAt,
    };
  }

  const message = buildLawyerReferralEmailMessage({
    request,
    lawyer,
    recipientEmail: recipient,
    from: config.from,
    appUrl: config.appUrl,
  });

  try {
    const sendResult = await sendResendEmail({
      apiKey: config.apiKey,
      message,
      idempotencyKey: `immojudis-lawyer-referral-${request.id}-${request.requested_lawyer_id}`,
      fetchImpl,
    });
    return {
      status: "sent",
      provider: "resend",
      recipient,
      messageId: sendResult.id,
      detail: null,
      attemptedAt,
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "resend",
      recipient,
      messageId: null,
      detail: error instanceof Error ? error.message : "Envoi email avocat impossible.",
      attemptedAt,
    };
  }
}

async function recordLawyerReferralEmailDelivery(
  request: LawyerReferralRow,
  delivery: AdminLawyerReferralEmailDelivery,
): Promise<LawyerReferralRow> {
  const { data, error } = await supabaseAdmin
    .from("lawyer_referral_requests")
    .update({
      metadata: asJson({
        ...jsonObject(request.metadata),
        lawyer_email_delivery: delivery,
      }),
    })
    .eq("id", request.id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function getReferencedLawyerEmailTarget(
  lawyerId: string,
): Promise<ReferencedLawyerEmailTarget | null> {
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select("id,display_name,firm_name,email,bar_association,city,department")
    .eq("id", lawyerId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export function buildLawyerReferralEmailMessage({
  request,
  lawyer,
  recipientEmail,
  from,
  appUrl,
}: {
  request: Pick<
    LawyerReferralRow,
    | "id"
    | "requester_email"
    | "phone"
    | "preferred_contact_method"
    | "message"
    | "financing_ready"
    | "max_bid_eur"
    | "sale_snapshot"
    | "admin_notes"
  >;
  lawyer: Pick<ReferencedLawyerEmailTarget, "display_name">;
  recipientEmail: string;
  from: string;
  appUrl: string;
}): ResendEmailMessage {
  const sale = jsonObject(request.sale_snapshot);
  const title = cleanSaleTitle(stringOrNull(sale.title)) ?? "Vente judiciaire";
  const city = stringOrNull(sale.city);
  const department = stringOrNull(sale.department);
  const location = [city, department].filter(Boolean).join(" · ");
  const saleId = stringOrNull(sale.id);
  const saleUrl = saleId ? `${appUrl}/sales/${encodeURIComponent(saleId)}` : appUrl;
  const subject = `Demande Immojudis - ${title}${city ? ` à ${city}` : ""}`;
  const textLines = [
    `Bonjour ${lawyer.display_name},`,
    "",
    "Une demande de mise en relation Immojudis vous a été assignée.",
    "",
    `${title}${location ? ` - ${location}` : ""}`,
    `Annonce: ${saleUrl}`,
    request.requester_email ? `Demandeur: ${request.requester_email}` : null,
    request.phone ? `Téléphone: ${request.phone}` : null,
    `Contact préféré: ${contactMethodLabel(request.preferred_contact_method)}`,
    request.max_bid_eur ? `Enchère plafond indiquée: ${formatPrice(request.max_bid_eur)}` : null,
    request.financing_ready == null
      ? null
      : `Financement prêt: ${request.financing_ready ? "oui" : "non"}`,
    request.message ? `Message: ${request.message}` : null,
    request.admin_notes ? `Note Immojudis: ${request.admin_notes}` : null,
    "",
    "Les coordonnées et éléments transmis proviennent de la demande utilisateur Immojudis. Merci de vérifier votre disponibilité et les règles applicables avant toute prise en charge.",
  ].filter((line): line is string => typeof line === "string");

  return {
    from,
    to: recipientEmail,
    subject,
    text: textLines.join("\n"),
    html: buildLawyerReferralEmailHtml({
      lawyerName: lawyer.display_name,
      title,
      location,
      saleUrl,
      requesterEmail: request.requester_email,
      phone: request.phone,
      preferredContactMethod: contactMethodLabel(request.preferred_contact_method),
      maxBid: request.max_bid_eur ? formatPrice(request.max_bid_eur) : null,
      financingReady: request.financing_ready,
      message: request.message,
      adminNotes: request.admin_notes,
    }),
  };
}

function referralRequestToSummary(
  request: LawyerReferralRow,
  requestedLawyer: AdminLawyerReferralLawyerOption | null,
): AdminLawyerReferralSummary {
  const sale = jsonObject(request.sale_snapshot);
  return {
    id: request.id,
    status: request.status,
    matchingStatus: request.matching_status,
    requestedLawyerId: request.requested_lawyer_id,
    requestedLawyer,
    requesterEmail: request.requester_email,
    requesterId: request.requester_id,
    saleId: request.sale_id,
    sale: {
      id: stringOrNull(sale.id),
      title: cleanSaleTitle(stringOrNull(sale.title)),
      city: stringOrNull(sale.city),
      department: stringOrNull(sale.department),
      tribunal: stringOrNull(sale.tribunal),
      tribunalCode: stringOrNull(sale.tribunal_code),
      saleDate: stringOrNull(sale.sale_date),
      startingPriceEur: numberOrNull(sale.starting_price_eur),
    },
    preferredContactMethod: request.preferred_contact_method,
    phone: request.phone,
    message: request.message,
    financingReady: request.financing_ready,
    maxBidEur: request.max_bid_eur,
    adminNotes: request.admin_notes,
    emailDelivery: normalizeEmailDelivery(jsonObject(request.metadata).lawyer_email_delivery),
    assignedAt: request.assigned_at,
    sentAt: request.sent_at,
    respondedAt: request.responded_at,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
  };
}

function buildLawyerReferralEmailHtml({
  lawyerName,
  title,
  location,
  saleUrl,
  requesterEmail,
  phone,
  preferredContactMethod,
  maxBid,
  financingReady,
  message,
  adminNotes,
}: {
  lawyerName: string;
  title: string;
  location: string;
  saleUrl: string;
  requesterEmail: string | null;
  phone: string | null;
  preferredContactMethod: string;
  maxBid: string | null;
  financingReady: boolean | null;
  message: string | null;
  adminNotes: string | null;
}): string {
  const rows = [
    ["Demandeur", requesterEmail],
    ["Téléphone", phone],
    ["Contact préféré", preferredContactMethod],
    ["Enchère plafond", maxBid],
    ["Financement prêt", financingReady == null ? null : financingReady ? "Oui" : "Non"],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;color:#6c7280;">${escapeHtml(label ?? "")}</td><td style="padding:8px 0;color:#182033;font-weight:700;">${escapeHtml(value ?? "")}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f6f4ef;color:#182033;font-family:Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;padding:28px 18px;">
      <div style="background:#fff;border:1px solid #e8e1d4;border-radius:10px;padding:24px;">
        <p style="margin:0 0 10px;color:#9b7a2f;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">Mise en relation Immojudis</p>
        <h1 style="margin:0 0 8px;font-size:22px;line-height:1.25;color:#182033;">${escapeHtml(title)}</h1>
        ${location ? `<p style="margin:0 0 18px;color:#6c7280;">${escapeHtml(location)}</p>` : ""}
        <p style="margin:0 0 18px;color:#4b5563;line-height:1.55;">Bonjour ${escapeHtml(lawyerName)}, une demande de mise en relation vous a été assignée depuis Immojudis.</p>
        ${rows ? `<table style="width:100%;border-collapse:collapse;margin:0 0 18px;">${rows}</table>` : ""}
        ${message ? `<p style="margin:0 0 14px;color:#4b5563;line-height:1.55;"><strong>Message utilisateur</strong><br>${escapeHtml(message)}</p>` : ""}
        ${adminNotes ? `<p style="margin:0 0 14px;color:#4b5563;line-height:1.55;"><strong>Note Immojudis</strong><br>${escapeHtml(adminNotes)}</p>` : ""}
        <a href="${escapeAttribute(saleUrl)}" style="display:inline-block;background:#182033;color:#fff;text-decoration:none;border-radius:8px;padding:12px 16px;font-weight:700;">Voir l'annonce</a>
        <p style="margin:22px 0 0;color:#6c7280;font-size:12px;line-height:1.5;">
          Les éléments transmis sont indicatifs et doivent être vérifiés par le cabinet avant toute prise en charge.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

function normalizeEmailDelivery(value: unknown): AdminLawyerReferralEmailDelivery | null {
  const delivery = jsonObject(value);
  const status = stringOrNull(delivery.status);
  if (status !== "sent" && status !== "skipped" && status !== "failed") return null;
  return {
    status,
    provider: "resend",
    recipient: stringOrNull(delivery.recipient),
    messageId: stringOrNull(delivery.messageId),
    detail: stringOrNull(delivery.detail),
    attemptedAt: stringOrNull(delivery.attemptedAt) ?? "",
  };
}

function contactMethodLabel(value: LawyerReferralRow["preferred_contact_method"]): string {
  if (value === "phone") return "Téléphone";
  if (value === "either") return "Email ou téléphone";
  return "Email";
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function referencedLawyerToOption(
  lawyer: Pick<
    ReferencedLawyerRow,
    "id" | "display_name" | "firm_name" | "bar_association" | "city" | "department"
  >,
): AdminLawyerReferralLawyerOption {
  return {
    id: lawyer.id,
    displayName: lawyer.display_name,
    firmName: lawyer.firm_name,
    barAssociation: lawyer.bar_association,
    city: lawyer.city,
    department: lawyer.department,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
