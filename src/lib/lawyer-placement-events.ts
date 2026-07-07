import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  getFeaturedReferencedLawyerForSale,
  type FeaturedReferencedLawyer,
} from "@/lib/featured-lawyers";

type LawyerPlacementEventInsert = Database["public"]["Tables"]["lawyer_placement_events"]["Insert"];

export const lawyerPlacementEventInputSchema = z.object({
  saleId: z.string().uuid(),
  lawyerId: z.string().uuid(),
  eventType: z.enum(["impression", "cta_click"]),
  placementSlot: z.string().trim().min(1).max(80).default("sale_detail_featured_lawyer"),
  pagePath: z.string().trim().max(300).optional(),
  viewport: z.enum(["desktop", "mobile", "unknown"]).default("unknown"),
});

export type LawyerPlacementEventInput = z.input<typeof lawyerPlacementEventInputSchema>;
export type LawyerPlacementEventPayload = z.output<typeof lawyerPlacementEventInputSchema>;

export type LawyerPlacementEventResponse = {
  ok: true;
  recorded: boolean;
  reason: "recorded" | "not_featured" | "no_featured_lawyer";
};

export async function recordLawyerPlacementEvent({
  input,
}: {
  input: LawyerPlacementEventPayload;
}): Promise<LawyerPlacementEventResponse> {
  const { lawyer } = await getFeaturedReferencedLawyerForSale({ saleId: input.saleId });
  const payload = buildLawyerPlacementEventInsert({ input, featuredLawyer: lawyer });

  if (!payload) {
    return {
      ok: true,
      recorded: false,
      reason: lawyer ? "not_featured" : "no_featured_lawyer",
    };
  }

  const { error } = await supabaseAdmin.from("lawyer_placement_events").insert(payload);
  if (error) throw error;

  return { ok: true, recorded: true, reason: "recorded" };
}

export function buildLawyerPlacementEventInsert({
  input,
  featuredLawyer,
}: {
  input: LawyerPlacementEventPayload;
  featuredLawyer: FeaturedReferencedLawyer | null;
}): LawyerPlacementEventInsert | null {
  if (!featuredLawyer || featuredLawyer.id !== input.lawyerId) return null;

  return {
    lawyer_id: featuredLawyer.id,
    sale_id: input.saleId,
    event_type: input.eventType,
    placement_slot: input.placementSlot,
    matching_basis: featuredLawyer.matchingBasis,
    sector_label: featuredLawyer.sectorLabel,
    metadata: placementEventMetadata(input),
  };
}

function placementEventMetadata(input: LawyerPlacementEventPayload): Json {
  return {
    source: "featured_lawyer_placement",
    viewport: input.viewport,
    page_path: input.pagePath ?? null,
  };
}
