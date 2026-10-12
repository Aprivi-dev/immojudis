import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  mapCourtSummaries,
  mapDvfHistory,
  mapLicitorHistory,
  mapScenarioSet,
  type AuctionScenariosResponse,
  type CourtAuctionSummary,
} from "@/lib/auction-scenarios";

type SaleInput = {
  tribunal_code: string | null;
  tribunal: string | null;
  starting_price_eur: number | null;
  property_type: string | null;
  habitable_surface_m2: number | null;
  app_surface_m2: number | null;
};

/** Scenarios and court history of one sale (service role: the plan is checked by the caller). */
export async function getAuctionScenarios(sale: SaleInput): Promise<AuctionScenariosResponse> {
  const empty: AuctionScenariosResponse = {
    courtName: sale.tribunal,
    startingPrice: sale.starting_price_eur,
    propertyType: sale.property_type,
    surfaceM2: sale.habitable_surface_m2 ?? sale.app_surface_m2,
    scenarios: null,
    history: { licitor: null, dvf: null },
  };
  if (!sale.tribunal_code) return empty;
  const { data, error } = await supabaseAdmin.rpc("get_court_auction_scenarios", {
    p_court_code: sale.tribunal_code,
    p_starting_price: sale.starting_price_eur ?? 0,
  });
  if (error) throw error;
  const raw = (data ?? {}) as Record<string, unknown>;
  const history = (raw.history ?? {}) as Record<string, unknown>;
  return {
    ...empty,
    scenarios: mapScenarioSet(raw.scenarios as Record<string, unknown> | null),
    history: {
      licitor: mapLicitorHistory(history.licitor as Record<string, unknown> | null),
      dvf: mapDvfHistory(history.dvf as Record<string, unknown> | null),
    },
  };
}

export async function getCourtAuctionSummaries(): Promise<CourtAuctionSummary[]> {
  const { data, error } = await supabaseAdmin.rpc("get_court_auction_summaries");
  if (error) throw error;
  return mapCourtSummaries(data);
}
