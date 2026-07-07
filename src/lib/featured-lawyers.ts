import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";

type SaleSectorSource = Pick<
  Database["public"]["Tables"]["auction_sales"]["Row"],
  "id" | "city" | "department" | "postal_code" | "tribunal" | "tribunal_code"
>;

type ReferencedLawyerRow = Pick<
  Database["public"]["Tables"]["referenced_lawyers"]["Row"],
  | "id"
  | "display_name"
  | "firm_name"
  | "bar_association"
  | "city"
  | "department"
  | "profile_summary"
  | "practice_tags"
  | "priority_weight"
  | "paid_placement_starts_at"
  | "paid_placement_ends_at"
>;

type CoverageColumn = "tribunal_code" | "department" | "postal_code_prefix" | "city";
type SectorCriterion = {
  column: CoverageColumn;
  value: string;
  label: string;
};

export const featuredLawyerQuerySchema = z.object({
  saleId: z.string().uuid(),
});

export type FeaturedReferencedLawyer = {
  id: string;
  displayName: string;
  firmName: string | null;
  barAssociation: string | null;
  city: string | null;
  department: string | null;
  profileSummary: string | null;
  practiceTags: string[];
  matchingBasis: CoverageColumn;
  sectorLabel: string;
};

export type FeaturedReferencedLawyerResponse = {
  lawyer: FeaturedReferencedLawyer | null;
};

const SALE_SECTOR_COLUMNS = "id,city,department,postal_code,tribunal,tribunal_code";
const FEATURED_LAWYER_COLUMNS =
  "id,display_name,firm_name,bar_association,city,department,profile_summary,practice_tags,priority_weight,paid_placement_starts_at,paid_placement_ends_at";

export async function getFeaturedReferencedLawyerForSale({
  saleId,
  now = new Date(),
}: {
  saleId: string;
  now?: Date;
}): Promise<FeaturedReferencedLawyerResponse> {
  const { data: sale, error } = await supabaseAdmin
    .from("auction_sales")
    .select(SALE_SECTOR_COLUMNS)
    .eq("id", saleId)
    .maybeSingle();

  if (error) throw error;
  if (!sale?.id) throw new Error("Vente introuvable.");

  return {
    lawyer: await findFeaturedReferencedLawyerForSector(sale as SaleSectorSource, now),
  };
}

async function findFeaturedReferencedLawyerForSector(
  sale: SaleSectorSource,
  now: Date,
): Promise<FeaturedReferencedLawyer | null> {
  for (const { column, value, label } of buildFeaturedLawyerSectorCriteria(sale)) {
    const lawyerIds = await findCoverageLawyerIds(column, value);
    if (!lawyerIds.length) continue;

    const lawyer = await findEligibleFeaturedLawyer(lawyerIds, now);
    if (!lawyer) continue;

    return lawyerRowToFeatured(lawyer, column, label);
  }

  return null;
}

export function buildFeaturedLawyerSectorCriteria(sale: SaleSectorSource): SectorCriterion[] {
  const criteria: SectorCriterion[] = [];
  const tribunalCode = cleanCriterionValue(sale.tribunal_code);
  if (tribunalCode) {
    criteria.push({
      column: "tribunal_code",
      value: tribunalCode,
      label: cleanCriterionValue(sale.tribunal) ?? tribunalCode,
    });
  }

  const postalCode = cleanCriterionValue(sale.postal_code);
  if (postalCode) {
    for (const prefix of postalCodePrefixes(postalCode)) {
      criteria.push({
        column: "postal_code_prefix",
        value: prefix,
        label: postalCode,
      });
    }
  }

  const city = cleanCriterionValue(sale.city);
  if (city) {
    criteria.push({
      column: "city",
      value: city,
      label: city,
    });
  }

  const department = cleanCriterionValue(sale.department);
  if (department) {
    criteria.push({
      column: "department",
      value: department,
      label: department,
    });
  }

  return criteria;
}

async function findCoverageLawyerIds(column: CoverageColumn, value: string): Promise<string[]> {
  const normalized = cleanCriterionValue(value);
  if (!normalized) return [];

  let query = supabaseAdmin.from("referenced_lawyer_coverage").select("lawyer_id").limit(20);

  query = column === "city" ? query.ilike(column, normalized) : query.eq(column, normalized);

  const { data, error } = await query;

  if (error) throw error;
  return Array.from(new Set((data ?? []).map((row) => row.lawyer_id)));
}

async function findEligibleFeaturedLawyer(
  lawyerIds: string[],
  now: Date,
): Promise<ReferencedLawyerRow | null> {
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select(FEATURED_LAWYER_COLUMNS)
    .in("id", lawyerIds)
    .eq("status", "active")
    .in("paid_placement_status", ["trial", "active"])
    .eq("accepts_judicial_auctions", true)
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true });

  if (error) throw error;

  return selectActivePaidPlacement((data ?? []) as ReferencedLawyerRow[], now);
}

export function selectActivePaidPlacement(
  lawyers: ReferencedLawyerRow[],
  now: Date,
): ReferencedLawyerRow | null {
  const timestamp = now.getTime();
  return (
    lawyers.find((lawyer) => {
      const startsAt = parseDateTime(lawyer.paid_placement_starts_at);
      const endsAt = parseDateTime(lawyer.paid_placement_ends_at);
      return (startsAt == null || startsAt <= timestamp) && (endsAt == null || endsAt >= timestamp);
    }) ?? null
  );
}

function lawyerRowToFeatured(
  lawyer: ReferencedLawyerRow,
  matchingBasis: CoverageColumn,
  sectorLabel: string,
): FeaturedReferencedLawyer {
  return {
    id: lawyer.id,
    displayName: lawyer.display_name,
    firmName: lawyer.firm_name,
    barAssociation: lawyer.bar_association,
    city: lawyer.city,
    department: lawyer.department,
    profileSummary: lawyer.profile_summary,
    practiceTags: lawyer.practice_tags,
    matchingBasis,
    sectorLabel,
  };
}

function parseDateTime(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function postalCodePrefixes(postalCode: string): string[] {
  const normalized = postalCode.replace(/\s+/g, "");
  if (normalized.length < 3) return [];

  const minLength = 3;
  const prefixes: string[] = [];
  for (let length = normalized.length; length >= minLength; length -= 1) {
    prefixes.push(normalized.slice(0, length));
  }
  return Array.from(new Set(prefixes));
}

function cleanCriterionValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
