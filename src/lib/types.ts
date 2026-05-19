export type AuctionSale = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  postal_code: string | null;
  address: string | null;
  tribunal: string | null;
  property_type: string | null;
  starting_price_eur: number | null;
  sale_date: string | null;
  latitude: number | null;
  longitude: number | null;
  occupancy_status: string | null;
  habitable_surface_m2: number | null;
  carrez_surface_m2: number | null;
  land_surface_m2: number | null;
  rooms_count: number | null;
  bedrooms_count: number | null;
  has_garden: boolean | null;
  has_terrace: boolean | null;
  has_garage: boolean | null;
  has_pool: boolean | null;
  has_air_conditioning: boolean | null;
  has_double_glazing: boolean | null;
  investment_score: number | null;
  investment_summary: string | null;
  risk_notes: string | null;
  source_name: string | null;
  source_url: string | null;
  documents: unknown;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type SaleFilters = {
  department?: string;
  city?: string;
  property_type?: string;
  max_price?: number;
  min_surface?: number;
  occupancy_status?: string;
  min_score?: number;
};

export type SortKey = "date_asc" | "date_desc" | "price_asc" | "price_desc" | "score_desc";

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