import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { isLawyerEligibleForSale } from "@/lib/lawyer-bar";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
import { enforceDailyOperationLimits } from "@/lib/rate-limit";
import { resolveSaleBarAssociation } from "@/lib/sale-lawyer-bar";
import { cleanSaleTitle } from "@/lib/sale-title";
import { recordFeatureUsageEvent } from "@/lib/usage";

type SupabaseClient = SupabaseAuthContext["supabase"];
type SaleSnapshotSource = Pick<
  Database["public"]["Tables"]["auction_sales"]["Row"],
  | "id"
  | "title"
  | "city"
  | "department"
  | "postal_code"
  | "address"
  | "tribunal"
  | "tribunal_code"
  | "sale_date"
  | "starting_price_eur"
  | "property_type"
  | "lawyer_name"
>;

type ReferralMatchedLawyerRow = Pick<
  Database["public"]["Tables"]["referenced_lawyers"]["Row"],
  | "id"
  | "display_name"
  | "firm_name"
  | "bar_association"
  | "city"
  | "department"
  | "paid_placement_status"
  | "paid_placement_starts_at"
  | "paid_placement_ends_at"
>;

const referralStatusSchema = z.enum([
  "new",
  "manual_review",
  "sent_to_lawyer",
  "responded",
  "closed",
  "cancelled",
]);

const referralMatchingStatusSchema = z.enum(["unmatched", "matched", "manual_review"]);

export type LawyerReferralStatus = z.infer<typeof referralStatusSchema>;
export type LawyerReferralMatchingStatus = z.infer<typeof referralMatchingStatusSchema>;

export const lawyerReferralRequestInputSchema = z.object({
  saleId: z.string().uuid(),
  lawyerId: z.string().uuid().optional(),
  preferredContactMethod: z.enum(["email", "phone", "either"]).default("email"),
  /**
   * The user has seen the recap of the data sent to the lawyer and confirms the transmission
   * (plan P4-13). The server refuses a request without it.
   *
   * The API accepts nothing else than what the recap shows (sale, account email, contact method):
   * a free-text message, phone number, financing or maximum bid sent by a client is dropped by the
   * schema, so no field leaves Immojudis without having been displayed and consented to.
   */
  dataSharingConfirmed: z.literal(true, {
    message: "Confirmez la transmission de vos informations à l'avocat avant l'envoi.",
  }),
});

export const lawyerReferralPreviewQuerySchema = z.object({
  saleId: z.string().uuid(),
  lawyerId: z.string().uuid().optional(),
});

export const lawyerReferralListQuerySchema = z.object({
  saleId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type LawyerReferralRequestInput = z.input<typeof lawyerReferralRequestInputSchema>;
export type LawyerReferralRequestPayload = z.output<typeof lawyerReferralRequestInputSchema>;
export type LawyerReferralListQuery = z.output<typeof lawyerReferralListQuerySchema>;
export type LawyerReferralPreviewQuery = z.output<typeof lawyerReferralPreviewQuerySchema>;

export type LawyerReferralResponse = {
  requestId: string;
  status: LawyerReferralStatus;
  matchingStatus: LawyerReferralMatchingStatus;
  matchedLawyer: {
    id: string;
    displayName: string;
    firmName: string | null;
    barAssociation: string | null;
    city: string | null;
    department: string | null;
  } | null;
  reusedExisting: boolean;
};

/**
 * Placement of the lawyer who would receive a request, at the time of the preview: "active" (paid
 * placement), "trial" (free trial of the paid placement, not yet paid) or "none".
 */
export type LawyerReferralPlacement = "active" | "trial" | "none";

export type LawyerReferralPreviewResponse = {
  /** Null when no lawyer can be determined automatically: the request goes to manual review. */
  recipient:
    | (NonNullable<LawyerReferralResponse["matchedLawyer"]> & {
        placement: LawyerReferralPlacement;
      })
    | null;
};

type ReferralRecipient = {
  lawyer: NonNullable<LawyerReferralResponse["matchedLawyer"]>;
  placement: LawyerReferralPlacement;
};

export type LawyerReferralSummary = {
  id: string;
  status: LawyerReferralStatus;
  statusLabel: string;
  matchingStatus: LawyerReferralMatchingStatus;
  requestedLawyerId: string | null;
  matchedLawyer: LawyerReferralResponse["matchedLawyer"];
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
  preferredContactMethod: LawyerReferralRequestPayload["preferredContactMethod"];
  financingReady: boolean | null;
  maxBidEur: number | null;
  assignedAt: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
  nextStep: string;
};

export type LawyerReferralListResponse = {
  requests: LawyerReferralSummary[];
};

const SALE_SNAPSHOT_COLUMNS =
  "id,title,city,department,postal_code,address,tribunal,tribunal_code,sale_date,starting_price_eur,property_type,lawyer_name";

const OPEN_REQUEST_STATUSES = ["new", "manual_review", "sent_to_lawyer"] as const;

const USER_REFERRAL_COLUMNS =
  "id,status,matching_status,requested_lawyer_id,sale_id,sale_snapshot,preferred_contact_method,financing_ready,max_bid_eur,assigned_at,sent_at,responded_at,created_at,updated_at";
const REFERENCED_LAWYER_MATCH_COLUMNS =
  "id,display_name,firm_name,bar_association,city,department,paid_placement_status,paid_placement_starts_at,paid_placement_ends_at";

export async function createLawyerReferralRequest({
  auth,
  input,
  request,
}: {
  auth: SupabaseAuthContext;
  input: LawyerReferralRequestPayload;
  /** Requête HTTP d'origine : sert au plafond journalier par adresse. */
  request: Request;
}): Promise<LawyerReferralResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "lawyers.referrals")) {
    throw new Error("Mise en relation avocat réservée au plan Analyse.");
  }

  const sale = await getSaleSnapshot(auth.supabase, input.saleId);
  const existing = await getExistingOpenRequest(auth.userId, input.saleId);

  if (existing) {
    return {
      requestId: existing.id,
      status: existing.status as LawyerReferralStatus,
      matchingStatus: existing.matching_status as LawyerReferralMatchingStatus,
      matchedLawyer: existing.requested_lawyer_id
        ? await getReferencedLawyerSummary(auth.supabase, existing.requested_lawyer_id)
        : null,
      reusedExisting: true,
    };
  }

  // Après le droit d'accès et la reprise d'une demande déjà ouverte (qui ne crée rien) : seules les
  // créations usent les compteurs du compte, de son adresse et le disjoncteur global.
  await enforceDailyOperationLimits({
    request,
    userId: auth.userId,
    operation: "lawyerReferralCreate",
    launchOffer: plan.launchOffer === true,
  });

  const saleBar = await resolveSaleBarAssociation(sale);
  const matchedLawyer =
    (await resolveReferralRecipient(auth.supabase, sale, saleBar, input.lawyerId))?.lawyer ?? null;
  const matchingStatus = matchedLawyer ? "matched" : "manual_review";
  const status = matchedLawyer ? "new" : "manual_review";

  const { data, error } = await supabaseAdmin
    .from("lawyer_referral_requests")
    .insert({
      requester_id: auth.userId,
      requester_email: typeof auth.claims.email === "string" ? auth.claims.email : null,
      sale_id: input.saleId,
      sale_snapshot: saleSnapshotJson(sale),
      requested_lawyer_id: matchedLawyer?.id ?? null,
      status,
      matching_status: matchingStatus,
      preferred_contact_method: input.preferredContactMethod,
      assigned_at: matchedLawyer ? new Date().toISOString() : null,
      metadata: {
        source: input.lawyerId ? "lawyer_directory" : "sale_detail",
        matching_basis: matchedLawyer ? "tribunal_bar_association" : "manual_review",
        sale_bar_association: saleBar,
        selected_lawyer_id: input.lawyerId ?? null,
        data_sharing_confirmed_at: new Date().toISOString(),
        shared_with_lawyer: [...SHARED_WITH_LAWYER_FIELDS],
      },
    })
    .select("id,status,matching_status")
    .single();

  if (error) throw error;

  await recordFeatureUsageEvent({
    auth,
    eventKey: "lawyer.referral_requested",
    subjectType: "lawyer_referral_request",
    subjectId: data.id,
    metadata: {
      sale_id: input.saleId,
      matching_status: data.matching_status,
      requested_lawyer_id: matchedLawyer?.id ?? null,
    },
  });

  return {
    requestId: data.id,
    status: data.status as LawyerReferralStatus,
    matchingStatus: data.matching_status as LawyerReferralMatchingStatus,
    matchedLawyer,
    reusedExisting: false,
  };
}

/**
 * Who would receive the request, shown before the user consents. Same selection as
 * `createLawyerReferralRequest` (same eligibility rules), but nothing is created or recorded.
 */
export async function previewLawyerReferralRecipient({
  auth,
  query,
}: {
  auth: SupabaseAuthContext;
  query: LawyerReferralPreviewQuery;
}): Promise<LawyerReferralPreviewResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "lawyers.referrals")) {
    throw new Error("Mise en relation avocat réservée au plan Analyse.");
  }

  const sale = await getSaleSnapshot(auth.supabase, query.saleId);
  const saleBar = await resolveSaleBarAssociation(sale);
  const recipient = await resolveReferralRecipient(auth.supabase, sale, saleBar, query.lawyerId);
  return { recipient: recipient ? { ...recipient.lawyer, placement: recipient.placement } : null };
}

export async function listLawyerReferralRequests({
  auth,
  query,
}: {
  auth: SupabaseAuthContext;
  query: LawyerReferralListQuery;
}): Promise<LawyerReferralListResponse> {
  let requestQuery = supabaseAdmin
    .from("lawyer_referral_requests")
    .select(USER_REFERRAL_COLUMNS)
    .eq("requester_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(query.limit);

  if (query.saleId) {
    requestQuery = requestQuery.eq("sale_id", query.saleId);
  }

  const { data, error } = await requestQuery;
  if (error) throw error;

  const rows = (data ?? []) as Array<
    Pick<
      Database["public"]["Tables"]["lawyer_referral_requests"]["Row"],
      | "id"
      | "status"
      | "matching_status"
      | "requested_lawyer_id"
      | "sale_id"
      | "sale_snapshot"
      | "preferred_contact_method"
      | "financing_ready"
      | "max_bid_eur"
      | "assigned_at"
      | "sent_at"
      | "responded_at"
      | "created_at"
      | "updated_at"
    >
  >;
  const lawyerIds = Array.from(
    new Set(rows.map((row) => row.requested_lawyer_id).filter((id): id is string => Boolean(id))),
  );
  const lawyerMap = await getReferencedLawyerSummaryMap(auth.supabase, lawyerIds);

  return {
    requests: rows.map((row) =>
      referralRowToSummary(row, lawyerMap.get(row.requested_lawyer_id ?? "")),
    ),
  };
}

async function getSaleSnapshot(
  supabase: SupabaseClient,
  saleId: string,
): Promise<SaleSnapshotSource> {
  const { data, error } = await supabase
    .from("auction_sales")
    .select(SALE_SNAPSHOT_COLUMNS)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("Vente introuvable ou inaccessible.");
  return data as SaleSnapshotSource;
}

async function getExistingOpenRequest(
  userId: string,
  saleId: string,
): Promise<Pick<
  Database["public"]["Tables"]["lawyer_referral_requests"]["Row"],
  "id" | "status" | "matching_status" | "requested_lawyer_id"
> | null> {
  const { data, error } = await supabaseAdmin
    .from("lawyer_referral_requests")
    .select("id,status,matching_status,requested_lawyer_id")
    .eq("requester_id", userId)
    .eq("sale_id", saleId)
    .in("status", [...OPEN_REQUEST_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * The lawyer who receives the request: the one chosen by hand (same eligibility rules as an
 * automatic match) or, without a choice, the first eligible lawyer under a paid placement.
 */
async function resolveReferralRecipient(
  supabase: SupabaseClient,
  sale: SaleSnapshotSource,
  saleBar: string | null,
  lawyerId: string | undefined,
): Promise<ReferralRecipient | null> {
  if (!lawyerId) return findMatchingReferencedLawyer(supabase, sale, saleBar);

  const chosen = await getReferencedLawyerRecipient(supabase, lawyerId);
  if (!chosen) throw new Error("Avocat référencé introuvable ou indisponible.");
  // A lawyer chosen by hand obeys the same rules as an automatic match.
  if (
    !isLawyerEligibleForSale({
      lawyer: chosen.lawyer,
      saleBar,
      prosecutingLawyerName: sale.lawyer_name,
    })
  ) {
    throw new Error(
      "Cet avocat n'est pas proposé pour cette vente : seuls les avocats du barreau du tribunal, hors avocat poursuivant, peuvent être sollicités.",
    );
  }
  return chosen;
}

async function findMatchingReferencedLawyer(
  supabase: SupabaseClient,
  sale: SaleSnapshotSource,
  saleBar: string | null,
): Promise<ReferralRecipient | null> {
  // Bar of the sale's tribunal only; the prosecuting lawyer is excluded (conflict of interest).
  if (!saleBar) return null;

  const { data: lawyerRows, error } = await supabase
    .from("referenced_lawyers")
    .select(REFERENCED_LAWYER_MATCH_COLUMNS)
    .eq("status", "active")
    .in("paid_placement_status", ["trial", "active"])
    .eq("accepts_judicial_auctions", true)
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true })
    .limit(500);

  if (error) throw error;
  const lawyer = ((lawyerRows ?? []) as ReferralMatchedLawyerRow[]).find(
    (row) =>
      paidPlacementIsActive(row) &&
      isLawyerEligibleForSale({
        lawyer: {
          displayName: row.display_name,
          firmName: row.firm_name,
          barAssociation: row.bar_association,
        },
        saleBar,
        prosecutingLawyerName: sale.lawyer_name,
      }),
  );
  return lawyer ? lawyerRowToRecipient(lawyer) : null;
}

function lawyerRowToRecipient(row: ReferralMatchedLawyerRow): ReferralRecipient {
  return {
    lawyer: {
      id: row.id,
      displayName: row.display_name,
      firmName: row.firm_name,
      barAssociation: row.bar_association,
      city: row.city,
      department: row.department,
    },
    placement: placementOf(row),
  };
}

/** "active" or "trial" only while the placement window is open; anything else is "none". */
function placementOf(row: ReferralMatchedLawyerRow, now = new Date()): LawyerReferralPlacement {
  const status = row.paid_placement_status;
  if ((status === "active" || status === "trial") && paidPlacementIsActive(row, now)) return status;
  return "none";
}

function paidPlacementIsActive(
  lawyer: Pick<ReferralMatchedLawyerRow, "paid_placement_starts_at" | "paid_placement_ends_at">,
  now = new Date(),
): boolean {
  const timestamp = now.getTime();
  const startsAt = parseDateTime(lawyer.paid_placement_starts_at);
  const endsAt = parseDateTime(lawyer.paid_placement_ends_at);
  return (startsAt == null || startsAt <= timestamp) && (endsAt == null || endsAt >= timestamp);
}

/**
 * Fields that leave Immojudis for the lawyer, recorded for the audit trail. They are exactly the
 * ones the recap displays: the sale (title, location and link to the listing), the account email
 * and the contact method.
 */
const SHARED_WITH_LAWYER_FIELDS = [
  "requester_email",
  "sale_reference",
  "preferred_contact_method",
] as const;

async function getReferencedLawyerRecipient(
  supabase: SupabaseClient,
  lawyerId: string,
): Promise<ReferralRecipient | null> {
  const { data, error } = await supabase
    .from("referenced_lawyers")
    .select(REFERENCED_LAWYER_MATCH_COLUMNS)
    .eq("id", lawyerId)
    .maybeSingle();

  if (error) throw error;
  return data ? lawyerRowToRecipient(data as ReferralMatchedLawyerRow) : null;
}

async function getReferencedLawyerSummary(
  supabase: SupabaseClient,
  lawyerId: string,
): Promise<LawyerReferralResponse["matchedLawyer"]> {
  const { data, error } = await supabase
    .from("referenced_lawyers")
    .select("id,display_name,firm_name,bar_association,city,department")
    .eq("id", lawyerId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    displayName: data.display_name,
    firmName: data.firm_name,
    barAssociation: data.bar_association,
    city: data.city,
    department: data.department,
  };
}

async function getReferencedLawyerSummaryMap(
  supabase: SupabaseClient,
  lawyerIds: string[],
): Promise<Map<string, NonNullable<LawyerReferralResponse["matchedLawyer"]>>> {
  if (!lawyerIds.length) return new Map();

  const { data, error } = await supabase
    .from("referenced_lawyers")
    .select("id,display_name,firm_name,bar_association,city,department")
    .in("id", lawyerIds);

  if (error) throw error;

  return new Map(
    (data ?? []).map((row) => [
      row.id,
      {
        id: row.id,
        displayName: row.display_name,
        firmName: row.firm_name,
        barAssociation: row.bar_association,
        city: row.city,
        department: row.department,
      },
    ]),
  );
}

function referralRowToSummary(
  row: Pick<
    Database["public"]["Tables"]["lawyer_referral_requests"]["Row"],
    | "id"
    | "status"
    | "matching_status"
    | "requested_lawyer_id"
    | "sale_id"
    | "sale_snapshot"
    | "preferred_contact_method"
    | "financing_ready"
    | "max_bid_eur"
    | "assigned_at"
    | "sent_at"
    | "responded_at"
    | "created_at"
    | "updated_at"
  >,
  matchedLawyer: LawyerReferralResponse["matchedLawyer"] | undefined,
): LawyerReferralSummary {
  const sale = referralSaleSummary(row.sale_snapshot, row.sale_id);
  // Colonnes text protégées par des contraintes CHECK : les types générés les exposent en string.
  const status = row.status as LawyerReferralStatus;
  const matchingStatus = row.matching_status as LawyerReferralMatchingStatus;

  return {
    id: row.id,
    status,
    statusLabel: referralStatusLabel(status),
    matchingStatus,
    requestedLawyerId: row.requested_lawyer_id,
    matchedLawyer: matchedLawyer ?? null,
    saleId: row.sale_id,
    sale,
    preferredContactMethod:
      row.preferred_contact_method as LawyerReferralSummary["preferredContactMethod"],
    financingReady: row.financing_ready,
    maxBidEur: row.max_bid_eur,
    assignedAt: row.assigned_at,
    sentAt: row.sent_at,
    respondedAt: row.responded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextStep: referralNextStep(status, Boolean(matchedLawyer), matchingStatus),
  };
}

function referralSaleSummary(snapshot: Json, saleId: string | null): LawyerReferralSummary["sale"] {
  const record = jsonRecord(snapshot);

  return {
    id: stringOrNull(record.id) ?? saleId,
    title: stringOrNull(record.title),
    city: stringOrNull(record.city),
    department: stringOrNull(record.department),
    tribunal: stringOrNull(record.tribunal),
    tribunalCode: stringOrNull(record.tribunal_code),
    saleDate: stringOrNull(record.sale_date),
    startingPriceEur: numberOrNull(record.starting_price_eur),
  };
}

function referralStatusLabel(status: LawyerReferralStatus): string {
  const labels: Record<LawyerReferralStatus, string> = {
    new: "Demande reçue",
    manual_review: "Recherche manuelle",
    sent_to_lawyer: "Transmise à l'avocat référencé",
    responded: "Retour avocat reçu",
    closed: "Demande clôturée",
    cancelled: "Demande annulée",
  };
  return labels[status];
}

function referralNextStep(
  status: LawyerReferralStatus,
  hasMatchedLawyer: boolean,
  matchingStatus: LawyerReferralMatchingStatus,
): string {
  if (status === "manual_review" || matchingStatus === "manual_review") {
    return "Immojudis vérifie la zone, le tribunal et les avocats référencés disponibles.";
  }
  if (status === "sent_to_lawyer") {
    return "L'avocat référencé a reçu les éléments utiles et peut revenir vers vous.";
  }
  if (status === "responded") {
    return "Un retour avocat est disponible ou en cours de traitement par Immojudis.";
  }
  if (status === "closed") {
    return "La demande est terminée. Vous pouvez en créer une nouvelle si le dossier évolue.";
  }
  if (status === "cancelled") {
    return "La demande a été annulée. Vous pouvez relancer une mise en relation si besoin.";
  }
  if (hasMatchedLawyer) {
    return "Votre demande est qualifiée avec un avocat référencé Immojudis sur cette zone.";
  }
  return "Votre demande est enregistrée et attend une attribution à un avocat référencé.";
}

function saleSnapshotJson(sale: SaleSnapshotSource): Json {
  return {
    id: sale.id,
    title: cleanSaleTitle(sale.title),
    city: sale.city,
    department: sale.department,
    postal_code: sale.postal_code,
    address: sale.address,
    tribunal: sale.tribunal,
    tribunal_code: sale.tribunal_code,
    sale_date: sale.sale_date,
    starting_price_eur: sale.starting_price_eur,
    property_type: sale.property_type,
  };
}

function parseDateTime(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function jsonRecord(value: Json): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

function stringOrNull(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
