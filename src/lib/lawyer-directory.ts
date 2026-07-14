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
  | "paid_placement_status"
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
  bar: z.string().trim().max(120).optional().transform(emptyToUndefined),
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
  isSponsored: boolean;
};

export type LawyerDirectoryResponse = {
  lawyers: LawyerDirectoryProfile[];
  sectorLabel: string | null;
  barAssociation: string | null;
};

const LAWYER_COLUMNS =
  "id,display_name,firm_name,email,phone,website_url,bar_association,bar_number,city,department,address,profile_summary,practice_tags,accepts_remote_contact,priority_weight,paid_placement_status,paid_placement_starts_at,paid_placement_ends_at";
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
    .eq("accepts_judicial_auctions", true)
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true });

  if (error) throw error;
  const activeLawyers = (data ?? []) as LawyerRow[];
  const coverage = await getCoverage(activeLawyers.map((lawyer) => lawyer.id));
  const criteria = buildCriteria(sale, query);
  const resolvedBarAssociation = resolveBarAssociation(sale, query);
  const matched = activeLawyers
    .map((lawyer) => {
      const lawyerCoverage = coverage.get(lawyer.id) ?? [];
      return {
        lawyer,
        lawyerCoverage,
        match: bestMatch(lawyer, lawyerCoverage, criteria),
        isSponsored: paidPlacementIsActive(lawyer, now),
      };
    })
    .filter((item) => criteria.length === 0 || item.match != null)
    .sort((left, right) => {
      const scoreDifference = (right.match?.score ?? 0) - (left.match?.score ?? 0);
      if (scoreDifference) return scoreDifference;
      if (left.isSponsored !== right.isSponsored) return left.isSponsored ? -1 : 1;
      if (left.isSponsored) {
        const priorityDifference = right.lawyer.priority_weight - left.lawyer.priority_weight;
        if (priorityDifference) return priorityDifference;
      }
      return left.lawyer.display_name.localeCompare(right.lawyer.display_name, "fr", {
        sensitivity: "base",
      });
    });

  return {
    lawyers: matched.map(({ lawyer, lawyerCoverage, match, isSponsored }) =>
      toDirectoryProfile(lawyer, lawyerCoverage, match?.label ?? null, isSponsored),
    ),
    sectorLabel: resolvedBarAssociation
      ? `Barreau de ${resolvedBarAssociation}`
      : (clean(sale?.department) ?? clean(query.department)),
    barAssociation: resolvedBarAssociation,
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
  kind: "bar" | "tribunal" | "postal" | "city" | "department";
  value: string;
  score: number;
  label: string;
};

function buildCriteria(sale: SaleSector | null, query: LawyerDirectoryQuery): Criterion[] {
  const criteria: Criterion[] = [];
  const requestedBar = clean(query.bar);
  if (requestedBar) {
    pushCriterion(criteria, "bar", requestedBar, 70, `Barreau de ${cleanBarLabel(requestedBar)}`);
    return criteria;
  }

  const resolvedBarAssociation = resolveBarAssociation(sale, query);
  pushCriterion(
    criteria,
    "bar",
    resolvedBarAssociation,
    60,
    resolvedBarAssociation ? `Barreau de ${resolvedBarAssociation}` : undefined,
  );
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
      (criterion.kind === "bar" && equalBar(lawyer.bar_association, criterion.value)) ||
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
  if (criterion.kind === "bar") return false;
  if (criterion.kind === "tribunal") return equal(row.tribunal_code, criterion.value);
  if (criterion.kind === "postal") return equal(row.postal_code_prefix, criterion.value);
  if (criterion.kind === "city") return equal(row.city, criterion.value);
  return equal(row.department, criterion.value);
}

function toDirectoryProfile(
  lawyer: LawyerRow,
  coverage: CoverageRow[],
  matchingLabel: string | null,
  isSponsored: boolean,
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
    isSponsored,
  };
}

function paidPlacementIsActive(
  lawyer: Pick<
    LawyerRow,
    "paid_placement_status" | "paid_placement_starts_at" | "paid_placement_ends_at"
  >,
  now: Date,
) {
  if (lawyer.paid_placement_status !== "trial" && lawyer.paid_placement_status !== "active") {
    return false;
  }
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

function equalBar(left: string | null | undefined, right: string) {
  const leftKey = normalizedBarKey(left);
  const rightKey = normalizedBarKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function resolveBarAssociation(
  sale: SaleSector | null,
  query: LawyerDirectoryQuery,
): string | null {
  return (
    cleanBarLabel(query.bar) ??
    (sale ? inferBarAssociation(sale.tribunal, sale.city) : null) ??
    cleanBarLabel(query.city)
  );
}

export function inferBarAssociation(
  tribunal: string | null | undefined,
  fallbackCity: string | null | undefined,
): string | null {
  const label = clean(tribunal);
  if (label) {
    const match = label.match(
      /(?:tribunal\s+(?:judiciaire|de\s+grande\s+instance)|\btj\b)\s+(?:de|d[’'])\s*([^,;()]+?)(?:\s*[-–—]|$)/i,
    );
    const inferred = cleanBarLabel(match?.[1]);
    if (inferred) return inferred;
  }
  return cleanBarLabel(fallbackCity);
}

function cleanBarLabel(value: string | null | undefined): string | null {
  const cleaned = clean(value);
  if (!cleaned) return null;
  return (
    clean(
      cleaned
        .replace(/^\s*(?:ordre\s+des\s+avocats\s+du\s+)?barreau\s+(?:de\s+|du\s+|d[’']\s*)?/i, "")
        .replace(/\s+/g, " "),
    ) ?? null
  );
}

function normalizedBarKey(value: string | null | undefined): string | null {
  const cleaned = cleanBarLabel(value);
  if (!cleaned) return null;
  const key = cleaned
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return key || null;
}

function clean(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

function emptyToUndefined(value: string | undefined) {
  return value || undefined;
}
