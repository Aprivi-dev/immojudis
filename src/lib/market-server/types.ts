import "server-only";
import type { Database } from "@/integrations/supabase/types";
import type {
  MarketComparableMode,
  MarketEngineCandidate,
  MarketPropertySegment,
} from "@/lib/market-estimation-engine";

export type DvfYearResult = {
  features: DvfFeature[];
  complete: boolean;
  expectedCount: number;
  error: string | null;
};

export type DvfProps = {
  idmutinvar?: string;
  datemut?: string;
  anneemut?: number;
  libnatmut?: string;
  valeurfonc?: string;
  sbati?: string;
  sterr?: string;
  nblocmut?: number;
  nbpar?: number;
  l_idpar?: string[];
  codtypbien?: string;
  libtypbien?: string;
};

export type DvfFeature = {
  properties: DvfProps;
  geometry?: { type?: string; coordinates?: unknown } | null;
};

export type CommuneInfo = {
  code: string;
  nom: string;
  departmentCode: string | null;
  population: number;
};
export type StoredDvfRow = Pick<
  Database["public"]["Tables"]["dvf_transactions"]["Row"],
  | "id"
  | "source_mutation_id"
  | "sale_date"
  | "mutation_nature"
  | "total_price_eur"
  | "built_surface_m2"
  | "land_surface_m2"
  | "price_per_m2"
  | "property_type"
  | "dvf_property_type_code"
  | "parcel_id"
  | "latitude"
  | "longitude"
> & { distance_m?: number | null };

export type MarketAddressSale = {
  date: string;
  totalPrice: number;
  surface: number | null;
  pricePerM2: number | null;
  type: string;
};

export type MarketEstimate = {
  source: "DVF normalisé" | "DVF data.gouv" | "DVF Cerema" | "Statistiques DVF data.gouv";
  sourceUrl?: string | null;
  sourceUpdatedAt?: string | null;
  engineVersion?: "v2" | "v3";
  engineKind?: "comparable_ensemble" | "hybrid_lightgbm";
  modelVersionId?: string | null;
  modelVersion?: string | null;
  segment?: Exclude<MarketPropertySegment, "unsupported"> | "parking";
  surfaceBasis?: "built" | "land" | "unit";
  estimationLevel?: "reliable" | "indicative";
  subjectSurfaceM2?: number | null;
  subjectSurfaceEstimated?: boolean;
  subjectSurfaceAssumption?: string | null;
  subjectSurfaceUncertaintyPct?: number | null;
  locationSource?: "provided" | "geocoded";
  locationApproximate?: boolean;
  estimatedValueEur?: number | null;
  estimatedValueLowEur?: number | null;
  estimatedValueHighEur?: number | null;
  actionable?: boolean;
  collectionComplete?: boolean;
  missingYears?: number[];
  radiusM: number;
  yearsBack: number;
  areaKind: "urban" | "rural";
  commune: string | null;
  sampleSize: number; // nombre de parcelles comparables retenues
  effectiveSampleSize?: number;
  parcelSampleSize: number;
  totalNearbySampleSize: number;
  outliersRemoved: number;
  qualityScore: number;
  qualityLabel: "forte" | "correcte" | "fragile";
  qualityWarnings: string[];
  comparableMode:
    | MarketComparableMode
    | "nearby_type_only"
    | "address_history"
    | "geographic_aggregate"
    | "unit_sales";
  geographyLevel?: "commune" | "epci" | "department" | null;
  geographyCode?: string | null;
  surfaceMinM2: number | null;
  surfaceMaxM2: number | null;
  landSurfaceMinM2?: number | null;
  landSurfaceMaxM2?: number | null;
  medianPricePerM2: number | null;
  p10PricePerM2?: number | null;
  p25PricePerM2: number | null;
  p75PricePerM2: number | null;
  p90PricePerM2?: number | null;
  minPricePerM2: number | null;
  maxPricePerM2: number | null;
  medianUnitPriceEur?: number | null;
  p10UnitPriceEur?: number | null;
  p90UnitPriceEur?: number | null;
  // Si on a un prix de référence (mise à prix, prix d'adjudication)
  deviationPct: number | null; // <0 = sous le marché, >0 = au-dessus
  annualMarketTrendPct?: number;
  marketCell?: string | null;
  predictionInterval?: {
    coverageTarget: number;
    method: string;
    p10PricePerM2: number;
    p50PricePerM2: number;
    p90PricePerM2: number;
    conformalExpansionPct: number;
  };
  modelDiagnostics?: {
    modelWeight: number;
    rawP10PricePerM2: number;
    rawP50PricePerM2: number;
    rawP90PricePerM2: number;
  } | null;
  // Les 5 dernières ventes de la parcelle du bien (historique exact).
  addressHistory: MarketAddressSale[];
  // Dernière vente de chaque parcelle du rayon (base de la fourchette).
  recentTransactions: Array<{
    date: string;
    pricePerM2: number;
    surface: number;
    landSurface?: number | null;
    totalPrice: number;
    type: string;
    distanceM: number | null;
    score?: number;
    adjustedPricePerM2?: number;
    timeAdjustmentFactor?: number;
    marketCell?: string | null;
    unitCount?: number | null;
  }>;
};

export type MarketContext = {
  ok: boolean;
  error: string | null;
  estimate: MarketEstimate | null;
  status?: "ready" | "refreshing" | "queued" | "insufficient_data" | "failed";
  code?: MarketEstimateErrorCode | null;
  retryAfterSeconds?: number | null;
  computedAt?: string | null;
};

export type MarketEstimateErrorCode =
  | "INVALID_INPUT"
  | "MISSING_LOCATION"
  | "MISSING_SURFACE"
  | "UNSUPPORTED_SEGMENT"
  | "NO_COMPARABLES"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type ResolvedMarketLocation = {
  lat: number;
  lng: number;
  source: "provided" | "geocoded";
  approximate: boolean;
};

// ─── Géométrie ────────────────────────────────────────────────────────────

export type Ring = Array<[number, number]>;

// ─── Analyse à un rayon donné ───────────────────────────────────────────────

export type RadiusAnalysis = {
  source: MarketEstimate["source"];
  candidates: MarketEngineCandidate[];
  addressMutations: MarketAddressSale[];
  totalNearby: number;
  collectionComplete: boolean;
  missingYears: number[];
};

// ─── Cœur : estimation ──────────────────────────────────────────────────────

export type BuildEstimateInput = {
  lat: number;
  lng: number;
  locationSource: "provided" | "geocoded";
  locationApproximate: boolean;
  radiusOverride: number | null;
  postalCode: string | null | undefined;
  propertyType: string | null | undefined;
  surfaceKind: string | null | undefined;
  surfaceScope: string | null | undefined;
  surfaceM2: number | null | undefined;
  landSurfaceM2: number | null | undefined;
  roomsCount: number | null | undefined;
  surfaceEstimated: boolean;
  surfaceAssumption: string | null;
  surfaceUncertaintyPct: number | null;
  pricePerM2Ref: number | null | undefined;
};
