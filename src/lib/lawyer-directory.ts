import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

type LawyerRow = Pick<
  Database["public"]["Tables"]["referenced_lawyers"]["Row"],
  | "id"
  | "display_name"
  | "firm_name"
  | "email"
  | "phone"
  | "website_url"
  | "bar_association"
  | "bar_number"
  | "city"
  | "department"
  | "address"
  | "profile_summary"
  | "practice_tags"
  | "accepts_remote_contact"
  | "priority_weight"
  | "paid_placement_starts_at"
  | "paid_placement_ends_at"
>;

type CoverageRow = Pick<
  Database["public"]["Tables"]["referenced_lawyer_coverage"]["Row"],
  "lawyer_id" | "tribunal_code" | "tribunal_name" | "city" | "department" | "postal_code_prefix"
>;

type SaleSector = Pick<
  Database["public"]["Tables"]["auction_sales"]["Row"],
  "id" | "city" | "department" | "postal_code" | "tribunal" | "tribunal_code"
>;

export const lawyerDirectoryQuerySchema = z.object({
  saleId: z.string().uuid().optional(),
  city: z.string().trim().max(120).optional().transform(emptyToUndefined),
  department: z.string().trim().max(120).optional().transform(emptyToUndefined),
});

export type LawyerDirectoryQuery = z.output<typeof lawyerDirectoryQuerySchema>;

export type LawyerDirectoryProfile = {
  id: string;
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
  acceptsRemoteContact: boolean;
  coverageLabels: string[];
  matchingLabel: string | null;
};

export type LawyerDirectoryResponse = {
  lawyers: LawyerDirectoryProfile[];
  sectorLabel: string | null;
};

const LAWYER_COLUMNS =
  "id,display_name,firm_name,email,phone,website_url,bar_association,bar_number,city,department,address,profile_summary,practice_tags,accepts_remote_contact,priority_weight,paid_placement_starts_at,paid_placement_ends_at";
const COVERAGE_COLUMNS = "lawyer_id,tribunal_code,tribunal_name,city,department,postal_code_prefix";

export async function listLawyerDirectory(
  query: LawyerDirectoryQuery,
  now = new Date(),
): Promise<LawyerDirectoryResponse> {
  const sale = query.saleId ? await getSaleSector(query.saleId) : null;
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select(LAWYER_COLUMNS)
    .eq("status", "active")
    .in("paid_placement_status", ["trial", "active"])
    .eq("accepts_judicial_auctions", true)
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true });

  if (error) throw error;
  const activeLawyers = ((data ?? []) as LawyerRow[]).filter((lawyer) =>
    paidPlacementIsActive(lawyer, now),
  );
  const coverage = await getCoverage(activeLawyers.map((lawyer) => lawyer.id));
  const criteria = buildCriteria(sale, query);
  const matched = activeLawyers
    .map((lawyer) => {
      const lawyerCoverage = coverage.get(lawyer.id) ?? [];
      return {
        lawyer,
        lawyerCoverage,
        match: bestMatch(lawyer, lawyerCoverage, criteria),
      };
    })
    .filter((item) => criteria.length === 0 || item.match != null)
    .sort((left, right) => (right.match?.score ?? 0) - (left.match?.score ?? 0));

  return {
    lawyers: matched.map(({ lawyer, lawyerCoverage, match }) =>
      toDirectoryProfile(lawyer, lawyerCoverage, match?.label ?? null),
    ),
    sectorLabel:
      clean(sale?.tribunal) ??
      clean(sale?.city) ??
      clean(query.city) ??
      clean(sale?.department) ??
      clean(query.department),
  };
}

async function getSaleSector(saleId: string): Promise<SaleSector> {
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select("id,city,department,postal_code,tribunal,tribunal_code")
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) throw new Error("Vente introuvable.");
  return data as SaleSector;
}

async function getCoverage(lawyerIds: string[]): Promise<Map<string, CoverageRow[]>> {
  const rowsByLawyer = new Map<string, CoverageRow[]>();
  if (!lawyerIds.length) return rowsByLawyer;

  const { data, error } = await supabaseAdmin
    .from("referenced_lawyer_coverage")
    .select(COVERAGE_COLUMNS)
    .in("lawyer_id", lawyerIds);

  if (error) throw error;
  for (const row of (data ?? []) as CoverageRow[]) {
    const rows = rowsByLawyer.get(row.lawyer_id) ?? [];
    rows.push(row);
    rowsByLawyer.set(row.lawyer_id, rows);
  }
  return rowsByLawyer;
}

type Criterion = {
  kind: "tribunal" | "postal" | "city" | "department";
  value: string;
  score: number;
  label: string;
};

function buildCriteria(sale: SaleSector | null, query: LawyerDirectoryQuery): Criterion[] {
  const criteria: Criterion[] = [];
  pushCriterion(criteria, "tribunal", sale?.tribunal_code, 40, sale?.tribunal ?? undefined);
  const postalCode = clean(sale?.postal_code);
  if (postalCode) {
    for (let length = postalCode.length; length >= 3; length -= 1) {
      pushCriterion(criteria, "postal", postalCode.slice(0, length), 30 + length, postalCode);
    }
  }
  pushCriterion(criteria, "city", sale?.city ?? query.city, 25);
  pushCriterion(criteria, "department", sale?.department ?? query.department, 15);
  return criteria;
}

function pushCriterion(
  criteria: Criterion[],
  kind: Criterion["kind"],
  value: string | null | undefined,
  score: number,
  label = value ?? undefined,
) {
  const normalized = clean(value);
  if (!normalized) return;
  criteria.push({ kind, value: normalized, score, label: clean(label) ?? normalized });
}

function bestMatch(
  lawyer: LawyerRow,
  coverage: CoverageRow[],
  criteria: Criterion[],
): { score: number; label: string } | null {
  let best: { score: number; label: string } | null = null;
  for (const criterion of criteria) {
    const matches =
      coverage.some((row) => coverageMatches(row, criterion)) ||
      (criterion.kind === "city" && equal(lawyer.city, criterion.value)) ||
      (criterion.kind === "department" && equal(lawyer.department, criterion.value));
    if (matches && (!best || criterion.score > best.score)) {
      best = { score: criterion.score, label: criterion.label };
    }
  }
  return best;
}

function coverageMatches(row: CoverageRow, criterion: Criterion): boolean {
  if (criterion.kind === "tribunal") return equal(row.tribunal_code, criterion.value);
  if (criterion.kind === "postal") return equal(row.postal_code_prefix, criterion.value);
  if (criterion.kind === "city") return equal(row.city, criterion.value);
  return equal(row.department, criterion.value);
}

function toDirectoryProfile(
  lawyer: LawyerRow,
  coverage: CoverageRow[],
  matchingLabel: string | null,
): LawyerDirectoryProfile {
  return {
    id: lawyer.id,
    displayName: /^me\b|^ma[iî]tre\b/i.test(lawyer.display_name.trim())
      ? lawyer.display_name
      : `Maître ${lawyer.display_name}`,
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
    acceptsRemoteContact: lawyer.accepts_remote_contact,
    coverageLabels: Array.from(
      new Set(
        coverage
          .flatMap((row) => [row.tribunal_name, row.city, row.department])
          .map(clean)
          .filter((value): value is string => Boolean(value)),
      ),
    ),
    matchingLabel,
  };
}

function paidPlacementIsActive(
  lawyer: Pick<LawyerRow, "paid_placement_starts_at" | "paid_placement_ends_at">,
  now: Date,
) {
  const timestamp = now.getTime();
  const startsAt = lawyer.paid_placement_starts_at
    ? new Date(lawyer.paid_placement_starts_at).getTime()
    : null;
  const endsAt = lawyer.paid_placement_ends_at
    ? new Date(lawyer.paid_placement_ends_at).getTime()
    : null;
  return (
    (startsAt == null || !Number.isFinite(startsAt) || startsAt <= timestamp) &&
    (endsAt == null || !Number.isFinite(endsAt) || endsAt >= timestamp)
  );
}

function equal(left: string | null | undefined, right: string) {
  return clean(left)?.localeCompare(right, "fr", { sensitivity: "base" }) === 0;
}

function clean(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

function emptyToUndefined(value: string | undefined) {
  return value || undefined;
}
