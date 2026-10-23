import "server-only";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  MIN_SCENARIO_STARTING_PRICE,
  mapCourtSummaries,
  mapDvfHistory,
  mapLicitorHistory,
  mapScenarioSet,
  representativeStartingPrice,
  scenarioPropertyGroup,
  startingPriceBand,
  type AuctionScenariosResponse,
  type CourtAuctionSummary,
  type ScenarioPropertyGroup,
  type ScenariosUnavailableReason,
} from "@/lib/auction-scenarios";

type SaleInput = {
  tribunal_code: string | null;
  tribunal: string | null;
  starting_price_eur: number | null;
  property_type: string | null;
};

/** What the database answers for one (court, band, property group): no data of the caller's sale. */
type CourtScenariosPayload = {
  scenarios: Record<string, unknown> | null;
  history: Record<string, unknown>;
  dataAsOf: string | null;
};

/** The copy of the lots changes at most daily; an hour of cache keeps the answers well in step. */
export const AUCTION_SCENARIOS_REVALIDATE_SECONDS = 3_600;
export const AUCTION_SCENARIOS_CACHE_TAG = "auction-scenarios";

/**
 * The answer depends on the court, the starting-price band and the property group only, never on
 * the account or the sale: it is read once per hour and instance for all of them. `band` 0 stands
 * for « no usable starting price » (history only). The cache is read after the caller's rights
 * were checked (the route does that first); an error is never cached.
 */
async function readCourtScenarios(
  courtCode: string,
  band: number,
  propertyGroup: ScenarioPropertyGroup | null,
): Promise<CourtScenariosPayload> {
  const { data, error } = await supabaseAdmin.rpc("get_court_auction_scenarios", {
    p_court_code: courtCode,
    p_starting_price: band > 0 ? representativeStartingPrice(band) : 0,
    ...(propertyGroup ? { p_property_group: propertyGroup } : {}),
  });
  if (error) throw error;
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    scenarios: (raw.scenarios ?? null) as Record<string, unknown> | null,
    history: (raw.history ?? {}) as Record<string, unknown>,
    dataAsOf: typeof raw.data_as_of === "string" ? raw.data_as_of : null,
  };
}

const cachedCourtScenarios = unstable_cache(readCourtScenarios, ["auction-scenarios", "v1"], {
  revalidate: AUCTION_SCENARIOS_REVALIDATE_SECONDS,
  tags: [AUCTION_SCENARIOS_CACHE_TAG],
});

function unavailableReason(sale: SaleInput): ScenariosUnavailableReason | null {
  if (!sale.tribunal_code) return "no_court_code";
  if (sale.starting_price_eur == null || sale.starting_price_eur <= 0) return "no_starting_price";
  if (sale.starting_price_eur < MIN_SCENARIO_STARTING_PRICE) return "starting_price_too_low";
  return null;
}

/** Scenarios and court history of one sale (service role: the plan is checked by the caller). */
export async function getAuctionScenarios(sale: SaleInput): Promise<AuctionScenariosResponse> {
  const empty: AuctionScenariosResponse = {
    courtName: sale.tribunal,
    startingPrice: sale.starting_price_eur,
    propertyType: sale.property_type,
    scenarios: null,
    unavailable: unavailableReason(sale),
    dataAsOf: null,
    history: { licitor: null, dvf: null },
  };
  if (!sale.tribunal_code) return empty;
  const usablePrice = empty.unavailable === null;
  const band = usablePrice ? startingPriceBand(sale.starting_price_eur) : null;
  const payload = await cachedCourtScenarios(
    sale.tribunal_code,
    band ?? 0,
    scenarioPropertyGroup(sale.property_type),
  );
  const scenarios = usablePrice ? mapScenarioSet(payload.scenarios) : null;
  return {
    ...empty,
    scenarios,
    unavailable: empty.unavailable ?? (scenarios?.status === "ok" ? null : "insufficient_data"),
    dataAsOf: payload.dataAsOf,
    history: {
      licitor: mapLicitorHistory(payload.history.licitor as Record<string, unknown> | null),
      dvf: mapDvfHistory(payload.history.dvf as Record<string, unknown> | null),
    },
  };
}

export async function getCourtAuctionSummaries(): Promise<CourtAuctionSummary[]> {
  const { data, error } = await supabaseAdmin.rpc("get_court_auction_summaries");
  if (error) throw error;
  return mapCourtSummaries(data);
}
