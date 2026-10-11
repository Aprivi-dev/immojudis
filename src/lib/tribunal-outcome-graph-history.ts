import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Past hearings archived in the Outcome Graph.
 *
 * Catalogue retention deletes past sales from auction_sales; each one is
 * bridged into the Outcome Graph first. The read-only RPC
 * public.tribunal_outcome_graph_past_hearings returns those hearings once they
 * are attached to a tribunal judiciaire (verified INSEE competence, exact
 * bridge-time code or an explicit source label), excluding quarantined,
 * cancelled or withdrawn announcements and non-judicial sources.
 *
 * A row whose sale is still in the catalogue (auction_sale_id set) is dropped
 * here: the catalogue row, with its verification and quarantine filters, is
 * the only source for a live sale.
 */

const PAGE_SIZE = 1_000;
const MAX_ARCHIVED_HEARINGS = 25_000;

const numericSchema = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/)
    .transform(Number),
]);

const archivedHearingRowSchema = z
  .object({
    round_id: z.string().uuid(),
    court_code: z.string().min(1),
    scheduled_at: z.string().datetime({ offset: true }),
    initial_starting_price_eur: numericSchema.nullable(),
    property_type: z.string().nullable(),
    city: z.string().nullable(),
    publication_first_seen_at: z.string().datetime({ offset: true }).nullable(),
    occupation_status: z.string().nullable(),
    source_name: z.string().min(1),
    auction_sale_id: z.string().uuid().nullable(),
    external_id: z.string().nullable(),
    source_url: z.string().nullable(),
    lot_label: z.string().nullable(),
    lawyer_label: z.string().nullable(),
    legacy_status: z.string().nullable(),
  })
  .passthrough();

export type ArchivedHearing = {
  roundId: string;
  courtCode: string;
  scheduledAt: string;
  startingPriceEur: number | null;
  propertyType: string | null;
  city: string | null;
  firstSeenAt: string | null;
  /** Catalogue vocabulary: vacant, rented, owner_occupied, occupied or null. */
  occupancyStatus: string | null;
  sourceName: string;
  externalId: string | null;
  sourceUrl: string | null;
  lotLabel: string | null;
  lawyerLabel: string | null;
};

export class TribunalOutcomeGraphHistoryUnavailableError extends Error {
  constructor(message = "L’historique archivé des tribunaux est temporairement indisponible.") {
    super(message);
    this.name = "TribunalOutcomeGraphHistoryUnavailableError";
  }
}

export async function loadArchivedPastHearings(input: {
  historyStart: Date;
  asOf: Date;
  courtCode?: string;
}): Promise<{ hearings: ArchivedHearing[]; liveCatalogueRows: number }> {
  const hearings: ArchivedHearing[] = [];
  let liveCatalogueRows = 0;
  for (let offset = 0; offset < MAX_ARCHIVED_HEARINGS; offset += PAGE_SIZE) {
    const result = await supabaseAdmin
      .rpc("tribunal_outcome_graph_past_hearings", {
        p_history_start: input.historyStart.toISOString(),
        p_as_of: input.asOf.toISOString(),
        p_court_code: input.courtCode ?? null,
      })
      .order("scheduled_at", { ascending: true })
      .order("round_id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) {
      throw new TribunalOutcomeGraphHistoryUnavailableError(
        `Archived hearing lookup failed: ${result.error.message}`,
      );
    }
    const page = z.array(archivedHearingRowSchema).parse(result.data ?? []);
    for (const row of page) {
      if (row.auction_sale_id) {
        liveCatalogueRows += 1;
        continue;
      }
      hearings.push(mapArchivedHearing(row));
    }
    if (page.length < PAGE_SIZE) return { hearings, liveCatalogueRows };
  }
  throw new TribunalOutcomeGraphHistoryUnavailableError(
    "The bounded archived hearing scan exceeded 25,000 rows.",
  );
}

function mapArchivedHearing(row: z.infer<typeof archivedHearingRowSchema>): ArchivedHearing {
  return {
    roundId: row.round_id,
    courtCode: row.court_code.trim().toLocaleLowerCase("fr-FR"),
    scheduledAt: row.scheduled_at,
    startingPriceEur:
      row.initial_starting_price_eur != null && Number.isFinite(row.initial_starting_price_eur)
        ? row.initial_starting_price_eur
        : null,
    propertyType: row.property_type?.trim() || null,
    city: row.city?.trim() || null,
    firstSeenAt: row.publication_first_seen_at,
    occupancyStatus: catalogueOccupancyStatus(row.occupation_status),
    sourceName: row.source_name,
    externalId: row.external_id,
    sourceUrl: row.source_url,
    lotLabel: row.lot_label,
    lawyerLabel: row.lawyer_label,
  };
}

/** Outcome Graph lot occupation → catalogue occupancy vocabulary. */
export function catalogueOccupancyStatus(value: string | null | undefined): string | null {
  switch (value?.trim().toLocaleLowerCase("fr-FR")) {
    case "vacant":
      return "vacant";
    case "tenant_occupied":
      return "rented";
    case "owner_occupied":
      return "owner_occupied";
    case "occupied_other":
      return "occupied";
    default:
      return null;
  }
}
