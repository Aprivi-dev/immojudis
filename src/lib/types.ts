export type AuctionSale = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  postal_code: string | null;
  address: string | null;
  tribunal: string | null;
  tribunal_code: string | null;
  tribunal_name: string | null;
  tribunal_city: string | null;
  property_type: string | null;
  starting_price_eur: number | null;
  sale_date: string | null;
  latitude: number | null;
  longitude: number | null;
  occupancy_status: string | null;
  habitable_surface_m2: number | null;
  carrez_surface_m2: number | null;
  land_surface_m2: number | null;
  app_surface_m2: number | null;
  app_surface_kind: string | null;
  surface_scope: string | null;
  surface_source: string | null;
  surface_confidence: number | null;
  surface_evidence: string | null;
  rooms_count: number | null;
  bedrooms_count: number | null;
  bathrooms_count: number | null;
  parking_count: number | null;
  has_garden: boolean | null;
  has_terrace: boolean | null;
  has_garage: boolean | null;
  has_pool: boolean | null;
  has_air_conditioning: boolean | null;
  has_double_glazing: boolean | null;
  investment_score: number | null;
  investment_summary: string | null;
  score_version: string | null;
  score_confidence: number | null;
  score_factors: SaleScoreFactor[] | null;
  risk_notes: string | null;
  source_name: string | null;
  source_url: string | null;
  primary_source: string | null;
  source_urls: unknown;
  dedupe_confidence: string | null;
  quality_flags: unknown;
  documents: unknown;
  documents_rich: SaleDocumentRich[] | null;
  risks: SaleRisk[] | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type AuctionMapPin = Pick<
  AuctionSale,
  | "id"
  | "title"
  | "city"
  | "department"
  | "property_type"
  | "starting_price_eur"
  | "sale_date"
  | "latitude"
  | "longitude"
  | "occupancy_status"
  | "app_surface_m2"
  | "investment_score"
  | "score_confidence"
  | "status"
  | "created_at"
>;

export type SaleFilters = {
  department?: string;
  city?: string;
  property_type?: string;
  max_price?: number;
  min_surface?: number;
  occupancy_status?: string;
  min_score?: number;
  tribunal_code?: string;
  // Client-side advanced filters
  max_price_per_m2?: number;
  min_yield_pct?: number;
  around_address?: string;
  around_radius_km?: number;
  only_new?: boolean;
};

export type SortKey =
  | "date_asc"
  | "date_desc"
  | "price_asc"
  | "price_desc"
  | "score_desc"
  | "surface_desc";

export type UserAlert = {
  id: string;
  user_id: string;
  name: string;
  department: string | null;
  city: string | null;
  property_type: string | null;
  max_price_eur: number | null;
  min_surface_m2: number | null;
  occupancy_status: string | null;
  min_investment_score: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type SaleDocument = {
  url: string;
  name?: string;
  type?: string;
};

export type SaleDocumentRich = {
  url: string;
  label: string | null;
  type: string | null;
  document_type?: string | null;
  extraction_status: string | null;
  download_status?: string | null;
  docling_status?: string | null;
  text_chars?: number | null;
};

export type SaleScoreFactor = {
  factor_order?: number | null;
  factor_key: string;
  label: string | null;
  reason: string | null;
  delta: number | null;
  weight?: number | null;
  raw_value?: unknown;
  normalized_value?: ScoreFactorExplanation | unknown;
  confidence?: number | null;
  evidence?: string | null;
  evidence_refs?: SaleEvidenceRef[] | unknown;
};

export type ScoreFactorExplanation = {
  status?: string | null;
  axis?: string | null;
  axis_label?: string | null;
  question?: string | null;
  decision?: string | null;
  criterion?: string | null;
  reasoning?: string | null;
  calculation?: string | null;
  score_before?: number | null;
  score_after?: number | null;
  confidence_note?: string | null;
  limits?: string | null;
  raw_value_label?: string | null;
  facts?: SaleAnalysisFact[] | unknown;
  proof_level?: string | null;
};

export type SaleEvidenceRef = {
  label?: string | null;
  document_label?: string | null;
  document_type?: string | null;
  page_number?: number | null;
  excerpt?: string | null;
  confidence?: number | null;
};

export type SaleAnalysisFact = {
  status?: string | null;
  statement?: string | null;
  document_label?: string | null;
  document_type?: string | null;
  page_number?: number | null;
  confidence?: number | null;
};

export type SaleRiskOccurrence = {
  document_url: string | null;
  document_label: string | null;
  document_type: string | null;
  page_number: number | null;
  excerpt: string | null;
  confidence: number | null;
  detector?: string | null;
  detector_version?: string | null;
  matched_terms?: unknown;
  score_impact?: number | null;
  updated_at?: string | null;
};

export type SaleRisk = {
  risk_type: string;
  risk_label: string;
  severity: number | null;
  evidence: string | null;
  evidence_json?: RiskEvidenceJson | unknown;
  confidence?: number | null;
  detector?: string | null;
  detector_version?: string | null;
  score_impact?: number | null;
  occurrences?: SaleRiskOccurrence[] | null;
};

export type RiskEvidenceJson = SaleEvidenceRef & {
  source_kind?: string | null;
  matched_terms?: unknown;
  occurrence_count?: number | null;
  risk_status?: string | null;
  source_status?: string | null;
  decision_chain?: Array<{ step?: string | null; decision?: string | null }> | unknown;
  verification_priority?: string | null;
  reasoning?: string | null;
  why_it_matters?: string | null;
  next_action?: string | null;
  document_context?: string | null;
  document_weight?: number | null;
  fact?: string | null;
  status?: string | null;
  question?: string | null;
  decision?: string | null;
  confidence_note?: string | null;
};
