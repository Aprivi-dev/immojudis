import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

type ReferencedLawyerRow = Database["public"]["Tables"]["referenced_lawyers"]["Row"];
type ReferencedLawyerInsert = Database["public"]["Tables"]["referenced_lawyers"]["Insert"];
type ReferencedLawyerUpdate = Database["public"]["Tables"]["referenced_lawyers"]["Update"];
type ReferencedLawyerCoverageRow =
  Database["public"]["Tables"]["referenced_lawyer_coverage"]["Row"];
type ReferencedLawyerCoverageInsert =
  Database["public"]["Tables"]["referenced_lawyer_coverage"]["Insert"];
type LawyerPlacementEventRow = Pick<
  Database["public"]["Tables"]["lawyer_placement_events"]["Row"],
  "lawyer_id" | "event_type"
>;
type LawyerReferralRequestRow = Pick<
  Database["public"]["Tables"]["lawyer_referral_requests"]["Row"],
  "requested_lawyer_id"
>;

const lawyerStatusSchema = z.enum(["draft", "active", "paused", "archived"]);
const paidPlacementStatusSchema = z.enum([
  "not_started",
  "trial",
  "active",
  "past_due",
  "paused",
  "cancelled",
]);

const optionalTextSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : null));

export const adminReferencedLawyerCoverageInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    tribunalCode: optionalTextSchema,
    tribunalName: optionalTextSchema,
    city: optionalTextSchema,
    department: optionalTextSchema,
    postalCodePrefix: optionalTextSchema,
  })
  .refine(
    (coverage) =>
      Boolean(
        coverage.tribunalCode || coverage.department || coverage.city || coverage.postalCodePrefix,
      ),
    { message: "Chaque zone doit contenir un tribunal, département, code postal ou ville." },
  );

export const adminReferencedLawyerInputSchema = z.object({
  id: z.string().uuid().optional(),
  status: lawyerStatusSchema.default("draft"),
  paidPlacementStatus: paidPlacementStatusSchema.default("not_started"),
  displayName: z.string().trim().min(2).max(160),
  firmName: optionalTextSchema,
  email: optionalTextSchema,
  phone: optionalTextSchema,
  websiteUrl: optionalTextSchema,
  barAssociation: optionalTextSchema,
  barNumber: optionalTextSchema,
  city: optionalTextSchema,
  department: optionalTextSchema,
  address: optionalTextSchema,
  profileSummary: optionalTextSchema,
  practiceTags: z
    .array(z.string().trim().min(1).max(80))
    .max(12)
    .default(["adjudication"])
    .transform((tags) => Array.from(new Set(tags.map((tag) => tag.toLowerCase())))),
  acceptsJudicialAuctions: z.boolean().default(true),
  acceptsRemoteContact: z.boolean().default(true),
  priorityWeight: z.number().int().min(0).max(1_000).default(0),
  paidPlacementStartsAt: optionalTextSchema,
  paidPlacementEndsAt: optionalTextSchema,
  coverage: z.array(adminReferencedLawyerCoverageInputSchema).max(30).default([]),
});

export type AdminReferencedLawyerInput = z.input<typeof adminReferencedLawyerInputSchema>;
export type AdminReferencedLawyerPayload = z.output<typeof adminReferencedLawyerInputSchema>;

export type AdminReferencedLawyerCoverage = {
  id: string;
  tribunalCode: string | null;
  tribunalName: string | null;
  city: string | null;
  department: string | null;
  postalCodePrefix: string | null;
};

export type AdminReferencedLawyerSummary = {
  id: string;
  status: ReferencedLawyerRow["status"];
  paidPlacementStatus: ReferencedLawyerRow["paid_placement_status"];
  displayName: string;
  firmName: string | null;
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  barAssociation: string | null;
  barNumber: string | null;
  city: string | null;
  department: string | null;
  address: string | null;
  profileSummary: string | null;
  practiceTags: string[];
  acceptsJudicialAuctions: boolean;
  acceptsRemoteContact: boolean;
  priorityWeight: number;
  paidPlacementStartsAt: string | null;
  paidPlacementEndsAt: string | null;
  placementMetrics: {
    periodStart: string;
    impressions: number;
    ctaClicks: number;
    referralRequests: number;
  };
  coverage: AdminReferencedLawyerCoverage[];
  createdAt: string;
  updatedAt: string;
};

export type AdminReferencedLawyerListResponse = {
  lawyers: AdminReferencedLawyerSummary[];
};

export type AdminReferencedLawyerSaveResponse = {
  lawyer: AdminReferencedLawyerSummary;
};

export async function listAdminReferencedLawyers(
  authToken: string,
): Promise<AdminReferencedLawyerListResponse> {
  await assertAdminAuth(authToken);

  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select("*")
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true });

  if (error) throw error;
  const lawyerIds = (data ?? []).map((lawyer) => lawyer.id);
  const [coverageByLawyer, metricsByLawyer] = await Promise.all([
    getCoverageByLawyerId(lawyerIds),
    getPlacementMetricsByLawyerId(lawyerIds),
  ]);

  return {
    lawyers: (data ?? []).map((lawyer) =>
      referencedLawyerToSummary(
        lawyer,
        coverageByLawyer.get(lawyer.id) ?? [],
        metricsByLawyer.get(lawyer.id),
      ),
    ),
  };
}

export async function saveAdminReferencedLawyer({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminReferencedLawyerPayload;
}): Promise<AdminReferencedLawyerSaveResponse> {
  const auth = await assertAdminAuth(authToken);
  const lawyerPayload = referencedLawyerPayload(input);
  const savedLawyer = input.id
    ? await updateReferencedLawyer(input.id, lawyerPayload)
    : await insertReferencedLawyer({
        ...lawyerPayload,
        created_by: auth.userId,
      });

  const coverageRows = referencedLawyerCoverageRows(savedLawyer.id, input.coverage);
  const { error: deleteError } = await supabaseAdmin
    .from("referenced_lawyer_coverage")
    .delete()
    .eq("lawyer_id", savedLawyer.id);

  if (deleteError) throw deleteError;

  if (coverageRows.length) {
    const { error: insertCoverageError } = await supabaseAdmin
      .from("referenced_lawyer_coverage")
      .insert(coverageRows);

    if (insertCoverageError) throw insertCoverageError;
  }

  const coverageByLawyer = await getCoverageByLawyerId([savedLawyer.id]);
  const metricsByLawyer = await getPlacementMetricsByLawyerId([savedLawyer.id]);
  return {
    lawyer: referencedLawyerToSummary(
      savedLawyer,
      coverageByLawyer.get(savedLawyer.id) ?? [],
      metricsByLawyer.get(savedLawyer.id),
    ),
  };
}

export function referencedLawyerPayload(
  input: AdminReferencedLawyerPayload,
): ReferencedLawyerInsert {
  return {
    status: input.status,
    paid_placement_status: input.paidPlacementStatus,
    display_name: input.displayName,
    firm_name: input.firmName,
    email: input.email,
    phone: input.phone,
    website_url: input.websiteUrl,
    bar_association: input.barAssociation,
    bar_number: input.barNumber,
    city: input.city,
    department: input.department,
    address: input.address,
    profile_summary: input.profileSummary,
    practice_tags: input.practiceTags.length ? input.practiceTags : ["adjudication"],
    accepts_judicial_auctions: input.acceptsJudicialAuctions,
    accepts_remote_contact: input.acceptsRemoteContact,
    priority_weight: input.priorityWeight,
    paid_placement_starts_at: input.paidPlacementStartsAt,
    paid_placement_ends_at: input.paidPlacementEndsAt,
  };
}

export function referencedLawyerCoverageRows(
  lawyerId: string,
  coverage: AdminReferencedLawyerPayload["coverage"],
): ReferencedLawyerCoverageInsert[] {
  return coverage.map((row) => ({
    lawyer_id: lawyerId,
    tribunal_code: row.tribunalCode,
    tribunal_name: row.tribunalName,
    city: row.city,
    department: row.department,
    postal_code_prefix: row.postalCodePrefix,
  }));
}

async function assertAdminAuth(authToken: string) {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) {
    throw new Error("Forbidden: ce compte n'a pas les droits administrateur Immojudis.");
  }
  return auth;
}

async function insertReferencedLawyer(
  payload: ReferencedLawyerInsert,
): Promise<ReferencedLawyerRow> {
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function updateReferencedLawyer(
  id: string,
  payload: ReferencedLawyerUpdate,
): Promise<ReferencedLawyerRow> {
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .update(payload)
    .eq("id", id)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function getCoverageByLawyerId(
  lawyerIds: string[],
): Promise<Map<string, ReferencedLawyerCoverageRow[]>> {
  if (!lawyerIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from("referenced_lawyer_coverage")
    .select("*")
    .in("lawyer_id", lawyerIds)
    .order("department", { ascending: true, nullsFirst: false })
    .order("city", { ascending: true, nullsFirst: false });

  if (error) throw error;

  const byLawyer = new Map<string, ReferencedLawyerCoverageRow[]>();
  for (const row of data ?? []) {
    const rows = byLawyer.get(row.lawyer_id) ?? [];
    rows.push(row);
    byLawyer.set(row.lawyer_id, rows);
  }
  return byLawyer;
}

function referencedLawyerToSummary(
  lawyer: ReferencedLawyerRow,
  coverage: ReferencedLawyerCoverageRow[],
  metrics = emptyPlacementMetrics(),
): AdminReferencedLawyerSummary {
  return {
    id: lawyer.id,
    status: lawyer.status,
    paidPlacementStatus: lawyer.paid_placement_status,
    displayName: lawyer.display_name,
    firmName: lawyer.firm_name,
    email: lawyer.email,
    phone: lawyer.phone,
    websiteUrl: lawyer.website_url,
    barAssociation: lawyer.bar_association,
    barNumber: lawyer.bar_number,
    city: lawyer.city,
    department: lawyer.department,
    address: lawyer.address,
    profileSummary: lawyer.profile_summary,
    practiceTags: lawyer.practice_tags,
    acceptsJudicialAuctions: lawyer.accepts_judicial_auctions,
    acceptsRemoteContact: lawyer.accepts_remote_contact,
    priorityWeight: lawyer.priority_weight,
    paidPlacementStartsAt: lawyer.paid_placement_starts_at,
    paidPlacementEndsAt: lawyer.paid_placement_ends_at,
    placementMetrics: metrics,
    coverage: coverage.map((row) => ({
      id: row.id,
      tribunalCode: row.tribunal_code,
      tribunalName: row.tribunal_name,
      city: row.city,
      department: row.department,
      postalCodePrefix: row.postal_code_prefix,
    })),
    createdAt: lawyer.created_at,
    updatedAt: lawyer.updated_at,
  };
}

async function getPlacementMetricsByLawyerId(
  lawyerIds: string[],
  now = new Date(),
): Promise<Map<string, AdminReferencedLawyerSummary["placementMetrics"]>> {
  const periodStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const metrics = new Map<string, AdminReferencedLawyerSummary["placementMetrics"]>();
  for (const lawyerId of lawyerIds) {
    metrics.set(lawyerId, emptyPlacementMetrics(periodStart));
  }
  if (!lawyerIds.length) return metrics;

  const [
    { data: placementEvents, error: eventsError },
    { data: referrals, error: referralsError },
  ] = await Promise.all([
    supabaseAdmin
      .from("lawyer_placement_events")
      .select("lawyer_id,event_type")
      .in("lawyer_id", lawyerIds)
      .gte("created_at", periodStart),
    supabaseAdmin
      .from("lawyer_referral_requests")
      .select("requested_lawyer_id")
      .in("requested_lawyer_id", lawyerIds)
      .gte("created_at", periodStart),
  ]);

  if (eventsError) throw eventsError;
  if (referralsError) throw referralsError;

  for (const event of (placementEvents ?? []) as LawyerPlacementEventRow[]) {
    const current = metrics.get(event.lawyer_id) ?? emptyPlacementMetrics(periodStart);
    if (event.event_type === "impression") current.impressions += 1;
    if (event.event_type === "cta_click") current.ctaClicks += 1;
    metrics.set(event.lawyer_id, current);
  }

  for (const referral of (referrals ?? []) as LawyerReferralRequestRow[]) {
    if (!referral.requested_lawyer_id) continue;
    const current = metrics.get(referral.requested_lawyer_id) ?? emptyPlacementMetrics(periodStart);
    current.referralRequests += 1;
    metrics.set(referral.requested_lawyer_id, current);
  }

  return metrics;
}

function emptyPlacementMetrics(
  periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
): AdminReferencedLawyerSummary["placementMetrics"] {
  return {
    periodStart,
    impressions: 0,
    ctaClicks: 0,
    referralRequests: 0,
  };
}
