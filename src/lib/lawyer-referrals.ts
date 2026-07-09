import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { featureIncluded } from "@/lib/plans";
import { resolvePlanEntitlements } from "@/lib/property-reports";
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
>;

type ReferralMatchedLawyerRow = Pick<
  Database["public"]["Tables"]["referenced_lawyers"]["Row"],
  | "id"
  | "display_name"
  | "firm_name"
  | "bar_association"
  | "city"
  | "department"
  | "paid_placement_starts_at"
  | "paid_placement_ends_at"
>;
type LawyerCoverageColumn = "tribunal_code" | "department" | "postal_code_prefix" | "city";
type LawyerCoverageCriterion = {
  column: LawyerCoverageColumn;
  value: string;
};

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
  preferredContactMethod: z.enum(["email", "phone", "either"]).default("email"),
  phone: z.string().trim().max(40).optional(),
  message: z.string().trim().max(1500).optional(),
  financingReady: z.boolean().optional(),
  maxBidEur: z.number().finite().nonnegative().optional(),
});

export const lawyerReferralListQuerySchema = z.object({
  saleId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type LawyerReferralRequestInput = z.input<typeof lawyerReferralRequestInputSchema>;
export type LawyerReferralRequestPayload = z.output<typeof lawyerReferralRequestInputSchema>;
export type LawyerReferralListQuery = z.output<typeof lawyerReferralListQuerySchema>;

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
  "id,title,city,department,postal_code,address,tribunal,tribunal_code,sale_date,starting_price_eur,property_type";

const OPEN_REQUEST_STATUSES = ["new", "manual_review", "sent_to_lawyer"] as const;

const USER_REFERRAL_COLUMNS =
  "id,status,matching_status,requested_lawyer_id,sale_id,sale_snapshot,preferred_contact_method,financing_ready,max_bid_eur,assigned_at,sent_at,responded_at,created_at,updated_at";
const REFERENCED_LAWYER_MATCH_COLUMNS =
  "id,display_name,firm_name,bar_association,city,department,paid_placement_starts_at,paid_placement_ends_at";

export async function createLawyerReferralRequest({
  auth,
  input,
}: {
  auth: SupabaseAuthContext;
  input: LawyerReferralRequestPayload;
}): Promise<LawyerReferralResponse> {
  const plan = await resolvePlanEntitlements(auth);
  if (!featureIncluded(plan.plan, "lawyers.referrals")) {
    throw new Error("Mise en relation avocat réservée au plan Analyse ou Investisseur.");
  }

  const sale = await getSaleSnapshot(auth.supabase, input.saleId);
  const existing = await getExistingOpenRequest(auth.supabase, auth.userId, input.saleId);

  if (existing) {
    return {
      requestId: existing.id,
      status: existing.status,
      matchingStatus: existing.matching_status,
      matchedLawyer: existing.requested_lawyer_id
        ? await getReferencedLawyerSummary(auth.supabase, existing.requested_lawyer_id)
        : null,
      reusedExisting: true,
    };
  }

  const matchedLawyer = await findMatchingReferencedLawyer(auth.supabase, sale);
  const matchingStatus = matchedLawyer ? "matched" : "manual_review";
  const status = matchedLawyer ? "new" : "manual_review";

  const { data, error } = await auth.supabase
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
      phone: emptyToNull(input.phone),
      message: emptyToNull(input.message),
      financing_ready: input.financingReady ?? null,
      max_bid_eur: input.maxBidEur ?? null,
      assigned_at: matchedLawyer ? new Date().toISOString() : null,
      metadata: {
        source: "sale_detail",
        matching_basis: matchedLawyer ? "referenced_lawyer_coverage" : "manual_review",
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
    status: data.status,
    matchingStatus: data.matching_status,
    matchedLawyer,
    reusedExisting: false,
  };
}

export async function listLawyerReferralRequests({
  auth,
  query,
}: {
  auth: SupabaseAuthContext;
  query: LawyerReferralListQuery;
}): Promise<LawyerReferralListResponse> {
  let requestQuery = auth.supabase
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
  supabase: SupabaseClient,
  userId: string,
  saleId: string,
): Promise<Pick<
  Database["public"]["Tables"]["lawyer_referral_requests"]["Row"],
  "id" | "status" | "matching_status" | "requested_lawyer_id"
> | null> {
  const { data, error } = await supabase
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

async function findMatchingReferencedLawyer(
  supabase: SupabaseClient,
  sale: SaleSnapshotSource,
): Promise<LawyerReferralResponse["matchedLawyer"]> {
  let coverageLawyerIds: string[] = [];

  for (const { column, value } of buildLawyerReferralSectorCriteria(sale)) {
    coverageLawyerIds = await findCoverageLawyerIds(supabase, column, value);
    if (coverageLawyerIds.length) break;
  }

  if (!coverageLawyerIds.length) return null;

  const { data: lawyerRows, error } = await supabase
    .from("referenced_lawyers")
    .select(REFERENCED_LAWYER_MATCH_COLUMNS)
    .in("id", coverageLawyerIds)
    .eq("status", "active")
    .in("paid_placement_status", ["trial", "active"])
    .eq("accepts_judicial_auctions", true)
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true });

  if (error) throw error;
  const lawyer = ((lawyerRows ?? []) as ReferralMatchedLawyerRow[]).find((row) =>
    paidPlacementIsActive(row),
  );
  if (!lawyer) return null;

  return {
    id: lawyer.id,
    displayName: lawyer.display_name,
    firmName: lawyer.firm_name,
    barAssociation: lawyer.bar_association,
    city: lawyer.city,
    department: lawyer.department,
  };
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

async function findCoverageLawyerIds(
  supabase: SupabaseClient,
  column: LawyerCoverageColumn,
  value: string,
): Promise<string[]> {
  const normalized = value.trim();
  if (!normalized) return [];

  let query = supabase.from("referenced_lawyer_coverage").select("lawyer_id");
  query = column === "city" ? query.ilike(column, normalized) : query.eq(column, normalized);

  const { data, error } = await query.limit(12);

  if (error) throw error;
  return Array.from(new Set((data ?? []).map((row) => row.lawyer_id)));
}

export function buildLawyerReferralSectorCriteria(
  sale: Pick<SaleSnapshotSource, "tribunal_code" | "postal_code" | "city" | "department">,
): LawyerCoverageCriterion[] {
  const criteria: LawyerCoverageCriterion[] = [];
  const tribunalCode = cleanCriterionValue(sale.tribunal_code);
  if (tribunalCode) {
    criteria.push({ column: "tribunal_code", value: tribunalCode });
  }

  const postalCode = cleanCriterionValue(sale.postal_code);
  if (postalCode) {
    for (const prefix of postalCodePrefixes(postalCode)) {
      criteria.push({ column: "postal_code_prefix", value: prefix });
    }
  }

  const city = cleanCriterionValue(sale.city);
  if (city) {
    criteria.push({ column: "city", value: city });
  }

  const department = cleanCriterionValue(sale.department);
  if (department) {
    criteria.push({ column: "department", value: department });
  }

  return criteria;
}

function postalCodePrefixes(postalCode: string): string[] {
  const normalized = postalCode.replace(/\s+/g, "");
  if (normalized.length < 3) return [];

  const prefixes: string[] = [];
  for (let length = normalized.length; length >= 3; length -= 1) {
    prefixes.push(normalized.slice(0, length));
  }
  return Array.from(new Set(prefixes));
}

function cleanCriterionValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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

  return {
    id: row.id,
    status: row.status,
    statusLabel: referralStatusLabel(row.status),
    matchingStatus: row.matching_status,
    requestedLawyerId: row.requested_lawyer_id,
    matchedLawyer: matchedLawyer ?? null,
    saleId: row.sale_id,
    sale,
    preferredContactMethod: row.preferred_contact_method,
    financingReady: row.financing_ready,
    maxBidEur: row.max_bid_eur,
    assignedAt: row.assigned_at,
    sentAt: row.sent_at,
    respondedAt: row.responded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextStep: referralNextStep(row.status, Boolean(matchedLawyer), row.matching_status),
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
    return "ImmoJudis vérifie la zone, le tribunal et les avocats référencés disponibles.";
  }
  if (status === "sent_to_lawyer") {
    return "L'avocat référencé a reçu les éléments utiles et peut revenir vers vous.";
  }
  if (status === "responded") {
    return "Un retour avocat est disponible ou en cours de traitement par ImmoJudis.";
  }
  if (status === "closed") {
    return "La demande est terminée. Vous pouvez en créer une nouvelle si le dossier évolue.";
  }
  if (status === "cancelled") {
    return "La demande a été annulée. Vous pouvez relancer une mise en relation si besoin.";
  }
  if (hasMatchedLawyer) {
    return "Votre demande est qualifiée avec un avocat référencé ImmoJudis sur cette zone.";
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

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
