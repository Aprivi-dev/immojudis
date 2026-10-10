import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { isLawyerEligibleForSale } from "@/lib/lawyer-bar";
import { isPublicationQuarantined } from "@/lib/sale-publication-guard";
import { resolveSaleBarAssociation } from "@/lib/sale-lawyer-bar";

type SaleSectorSource = Pick<
  Database["public"]["Tables"]["auction_sales"]["Row"],
  "id" | "tribunal" | "tribunal_code" | "lawyer_name"
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

// Stored in lawyer_placement_events.matching_basis, whose check constraint predates the bar rule:
// a bar-based match is recorded as "tribunal_code" (the tribunal's bar).
type CoverageColumn = "tribunal_code" | "department" | "postal_code_prefix" | "city";

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

const SALE_SECTOR_COLUMNS = "id,tribunal,tribunal_code,lawyer_name,status,raw_payload";
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
  if (isPublicationQuarantined(sale.raw_payload, sale.status)) {
    throw new Error("Vente introuvable.");
  }

  return {
    lawyer: await findFeaturedReferencedLawyerForSector(sale as SaleSectorSource, now),
  };
}

async function findFeaturedReferencedLawyerForSector(
  sale: SaleSectorSource,
  now: Date,
): Promise<FeaturedReferencedLawyer | null> {
  // Only lawyers registered at the bar of the sale's tribunal judiciaire, never the prosecuting
  // lawyer of the sale. No postal-code, city or department fallback (plan P4-13).
  const saleBar = await resolveSaleBarAssociation(sale);
  if (!saleBar) return null;

  const lawyer = await findEligibleFeaturedLawyer(
    {
      saleBar,
      prosecutingLawyerName: sale.lawyer_name,
    },
    now,
  );
  return lawyer ? lawyerRowToFeatured(lawyer, "tribunal_code", `Barreau de ${saleBar}`) : null;
}

async function findEligibleFeaturedLawyer(
  filter: { saleBar: string; prosecutingLawyerName: string | null },
  now: Date,
): Promise<ReferencedLawyerRow | null> {
  const { data, error } = await supabaseAdmin
    .from("referenced_lawyers")
    .select(FEATURED_LAWYER_COLUMNS)
    .eq("status", "active")
    .in("paid_placement_status", ["trial", "active"])
    .eq("accepts_judicial_auctions", true)
    .order("priority_weight", { ascending: false })
    .order("display_name", { ascending: true })
    .limit(500);

  if (error) throw error;

  const eligible = ((data ?? []) as ReferencedLawyerRow[]).filter((lawyer) =>
    isLawyerEligibleForSale({
      lawyer: {
        displayName: lawyer.display_name,
        firmName: lawyer.firm_name,
        barAssociation: lawyer.bar_association,
      },
      saleBar: filter.saleBar,
      prosecutingLawyerName: filter.prosecutingLawyerName,
    }),
  );
  return selectActivePaidPlacement(eligible, now);
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
