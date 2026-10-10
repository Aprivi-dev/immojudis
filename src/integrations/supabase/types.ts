export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18";
  };
  public: {
    Tables: {
      adjudication_price_statistics_build_reviews: {
        Row: {
          build_id: string;
          court_mappings_approved: boolean;
          created_at: string;
          decision: string;
          methodology_approved: boolean;
          notes: string;
          reviewed_at: string;
          reviewer_id: string;
          rights_basis_confirmed: boolean;
        };
        Insert: {
          build_id: string;
          court_mappings_approved?: boolean;
          created_at?: string;
          decision: string;
          methodology_approved?: boolean;
          notes: string;
          reviewed_at?: string;
          reviewer_id: string;
          rights_basis_confirmed?: boolean;
        };
        Update: {
          build_id?: string;
          court_mappings_approved?: boolean;
          created_at?: string;
          decision?: string;
          methodology_approved?: boolean;
          notes?: string;
          reviewed_at?: string;
          reviewer_id?: string;
          rights_basis_confirmed?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "adjudication_price_statistics_build_reviews_build_id_fkey";
            columns: ["build_id"];
            isOneToOne: true;
            referencedRelation: "adjudication_price_statistics_builds";
            referencedColumns: ["id"];
          },
        ];
      };
      adjudication_price_statistics_builds: {
        Row: {
          active_candidate_lots: number;
          built_at: string;
          canonical_court_count: number;
          created_at: string;
          id: string;
          mapped_sample_size: number;
          methodology_version: string;
          minimum_sample: number;
          national_sample_size: number;
          period_end: string;
          period_start: string;
          source_manifest_hash: string;
          source_name: string;
          source_run_ids: string[];
          unmatched_sample_size: number;
          window_months: number;
        };
        Insert: {
          active_candidate_lots: number;
          built_at?: string;
          canonical_court_count: number;
          created_at?: string;
          id?: string;
          mapped_sample_size: number;
          methodology_version: string;
          minimum_sample: number;
          national_sample_size: number;
          period_end: string;
          period_start: string;
          source_manifest_hash: string;
          source_name: string;
          source_run_ids: string[];
          unmatched_sample_size: number;
          window_months: number;
        };
        Update: {
          active_candidate_lots?: number;
          built_at?: string;
          canonical_court_count?: number;
          created_at?: string;
          id?: string;
          mapped_sample_size?: number;
          methodology_version?: string;
          minimum_sample?: number;
          national_sample_size?: number;
          period_end?: string;
          period_start?: string;
          source_manifest_hash?: string;
          source_name?: string;
          source_run_ids?: string[];
          unmatched_sample_size?: number;
          window_months?: number;
        };
        Relationships: [];
      };
      adjudication_price_statistics_snapshots: {
        Row: {
          above_starting_rate: number | null;
          at_least_double_rate: number | null;
          build_id: string;
          court_code: string | null;
          court_id: string | null;
          created_at: string;
          extra_statistics: Json | null;
          id: string;
          judicial_region: string | null;
          median_hammer_price_eur: number | null;
          median_hammer_to_starting_ratio: number | null;
          median_starting_price_eur: number | null;
          methodology_version: string;
          minimum_sample: number;
          period_end: string;
          period_start: string;
          quality_status: string;
          sample_size: number;
          scope_label: string;
          scope_type: string;
          statistics_hash: string;
        };
        Insert: {
          above_starting_rate?: number | null;
          at_least_double_rate?: number | null;
          build_id: string;
          court_code?: string | null;
          court_id?: string | null;
          created_at?: string;
          extra_statistics?: Json | null;
          id?: string;
          judicial_region?: string | null;
          median_hammer_price_eur?: number | null;
          median_hammer_to_starting_ratio?: number | null;
          median_starting_price_eur?: number | null;
          methodology_version: string;
          minimum_sample: number;
          period_end: string;
          period_start: string;
          quality_status: string;
          sample_size: number;
          scope_label: string;
          scope_type: string;
          statistics_hash: string;
        };
        Update: {
          above_starting_rate?: number | null;
          at_least_double_rate?: number | null;
          build_id?: string;
          court_code?: string | null;
          court_id?: string | null;
          created_at?: string;
          extra_statistics?: Json | null;
          id?: string;
          judicial_region?: string | null;
          median_hammer_price_eur?: number | null;
          median_hammer_to_starting_ratio?: number | null;
          median_starting_price_eur?: number | null;
          methodology_version?: string;
          minimum_sample?: number;
          period_end?: string;
          period_start?: string;
          quality_status?: string;
          sample_size?: number;
          scope_label?: string;
          scope_type?: string;
          statistics_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "adjudication_price_statistics_snapshots_build_id_fkey";
            columns: ["build_id"];
            isOneToOne: false;
            referencedRelation: "adjudication_price_statistics_builds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "adjudication_price_statistics_snapshots_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      adjudication_price_statistics_source_attestations: {
        Row: {
          attested_at: string;
          build_id: string;
          eligible_candidate_count: number;
          eligible_candidate_manifest_hash: string;
          source_gate_version: string;
        };
        Insert: {
          attested_at?: string;
          build_id: string;
          eligible_candidate_count: number;
          eligible_candidate_manifest_hash: string;
          source_gate_version: string;
        };
        Update: {
          attested_at?: string;
          build_id?: string;
          eligible_candidate_count?: number;
          eligible_candidate_manifest_hash?: string;
          source_gate_version?: string;
        };
        Relationships: [
          {
            foreignKeyName: "adjudication_price_statistics_source_attestations_build_id_fkey";
            columns: ["build_id"];
            isOneToOne: true;
            referencedRelation: "adjudication_price_statistics_builds";
            referencedColumns: ["id"];
          },
        ];
      };
      api_ip_rate_limit_buckets: {
        Row: {
          bucket_key: string;
          ip_hash: string;
          request_count: number;
          updated_at: string;
          window_started_at: string;
        };
        Insert: {
          bucket_key: string;
          ip_hash: string;
          request_count?: number;
          updated_at?: string;
          window_started_at: string;
        };
        Update: {
          bucket_key?: string;
          ip_hash?: string;
          request_count?: number;
          updated_at?: string;
          window_started_at?: string;
        };
        Relationships: [];
      };
      api_rate_limit_buckets: {
        Row: {
          bucket_key: string;
          request_count: number;
          updated_at: string;
          user_id: string;
          window_started_at: string;
        };
        Insert: {
          bucket_key: string;
          request_count?: number;
          updated_at?: string;
          user_id: string;
          window_started_at: string;
        };
        Update: {
          bucket_key?: string;
          request_count?: number;
          updated_at?: string;
          user_id?: string;
          window_started_at?: string;
        };
        Relationships: [];
      };
      artifact_extractions: {
        Row: {
          created_at: string;
          error_code: string | null;
          extracted_at: string;
          extracted_data: Json | null;
          extraction_status: string;
          extractor_name: string;
          extractor_version: string;
          field_provenance: Json;
          id: string;
          output_hash: string | null;
          quality_score: number | null;
          raw_artifact_id: string;
          run_number: number;
          sanitized_error_message: string | null;
          schema_version: string;
          source_fetch_id: string | null;
        };
        Insert: {
          created_at?: string;
          error_code?: string | null;
          extracted_at?: string;
          extracted_data?: Json | null;
          extraction_status: string;
          extractor_name: string;
          extractor_version: string;
          field_provenance?: Json;
          id?: string;
          output_hash?: string | null;
          quality_score?: number | null;
          raw_artifact_id: string;
          run_number?: number;
          sanitized_error_message?: string | null;
          schema_version: string;
          source_fetch_id?: string | null;
        };
        Update: {
          created_at?: string;
          error_code?: string | null;
          extracted_at?: string;
          extracted_data?: Json | null;
          extraction_status?: string;
          extractor_name?: string;
          extractor_version?: string;
          field_provenance?: Json;
          id?: string;
          output_hash?: string | null;
          quality_score?: number | null;
          raw_artifact_id?: string;
          run_number?: number;
          sanitized_error_message?: string | null;
          schema_version?: string;
          source_fetch_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "artifact_extractions_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "artifact_extractions_source_fetch_id_fkey";
            columns: ["source_fetch_id"];
            isOneToOne: false;
            referencedRelation: "source_fetches";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_ai_review_case_status: {
        Row: {
          access_reason: string | null;
          access_state: string;
          auction_sale_id: string | null;
          canonical_content_hash_at_import: string | null;
          capture_sha256: string | null;
          case_id: string;
          created_at: string;
          id: string;
          mapping_status: string;
          sample_sha256: string;
          schema_version: string;
          source_name: string;
          source_url: string;
        };
        Insert: {
          access_reason?: string | null;
          access_state: string;
          auction_sale_id?: string | null;
          canonical_content_hash_at_import?: string | null;
          capture_sha256?: string | null;
          case_id: string;
          created_at?: string;
          id?: string;
          mapping_status: string;
          sample_sha256: string;
          schema_version: string;
          source_name: string;
          source_url: string;
        };
        Update: {
          access_reason?: string | null;
          access_state?: string;
          auction_sale_id?: string | null;
          canonical_content_hash_at_import?: string | null;
          capture_sha256?: string | null;
          case_id?: string;
          created_at?: string;
          id?: string;
          mapping_status?: string;
          sample_sha256?: string;
          schema_version?: string;
          source_name?: string;
          source_url?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_ai_review_case_status_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_case_status_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_case_status_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_case_status_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_case_status_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_case_status_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_case_status_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_ai_review_projections: {
        Row: {
          auction_sale_id: string | null;
          block_reason: string | null;
          canonical_content_hash_at_import: string | null;
          capture_sha256: string;
          case_id: string;
          citation_status: string;
          created_at: string;
          evidence_locator: Json;
          field_key: string;
          id: string;
          local_is_publishable: boolean | null;
          mapping_status: string;
          review_state: string;
          sample_sha256: string;
          schema_version: string;
          source_name: string;
          source_url: string;
          value_jsonb: Json | null;
        };
        Insert: {
          auction_sale_id?: string | null;
          block_reason?: string | null;
          canonical_content_hash_at_import?: string | null;
          capture_sha256: string;
          case_id: string;
          citation_status: string;
          created_at?: string;
          evidence_locator?: Json;
          field_key: string;
          id?: string;
          local_is_publishable?: boolean | null;
          mapping_status: string;
          review_state: string;
          sample_sha256: string;
          schema_version: string;
          source_name: string;
          source_url: string;
          value_jsonb?: Json | null;
        };
        Update: {
          auction_sale_id?: string | null;
          block_reason?: string | null;
          canonical_content_hash_at_import?: string | null;
          capture_sha256?: string;
          case_id?: string;
          citation_status?: string;
          created_at?: string;
          evidence_locator?: Json;
          field_key?: string;
          id?: string;
          local_is_publishable?: boolean | null;
          mapping_status?: string;
          review_state?: string;
          sample_sha256?: string;
          schema_version?: string;
          source_name?: string;
          source_url?: string;
          value_jsonb?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_cadastre_parcels: {
        Row: {
          centroid_lat: number | null;
          centroid_lng: number | null;
          city: string | null;
          code_insee: string | null;
          confidence: number;
          created_at: string;
          department: string | null;
          geometry_geojson: Json;
          id: string;
          match_kind: string;
          parcel_id: string | null;
          parcel_key: string;
          parcel_number: string | null;
          raw_payload: Json;
          section: string | null;
          source_api: string;
          source_api_url: string | null;
          source_url: string;
          surface_m2: number | null;
          updated_at: string;
        };
        Insert: {
          centroid_lat?: number | null;
          centroid_lng?: number | null;
          city?: string | null;
          code_insee?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          geometry_geojson?: Json;
          id?: string;
          match_kind?: string;
          parcel_id?: string | null;
          parcel_key: string;
          parcel_number?: string | null;
          raw_payload?: Json;
          section?: string | null;
          source_api?: string;
          source_api_url?: string | null;
          source_url: string;
          surface_m2?: number | null;
          updated_at?: string;
        };
        Update: {
          centroid_lat?: number | null;
          centroid_lng?: number | null;
          city?: string | null;
          code_insee?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          geometry_geojson?: Json;
          id?: string;
          match_kind?: string;
          parcel_id?: string | null;
          parcel_key?: string;
          parcel_number?: string | null;
          raw_payload?: Json;
          section?: string | null;
          source_api?: string;
          source_api_url?: string | null;
          source_url?: string;
          surface_m2?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_cadastre_parcels_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_cadastre_parcels_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_cadastre_parcels_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_cadastre_parcels_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_cadastre_parcels_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_cadastre_parcels_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_cases: {
        Row: {
          case_status: string;
          court_case_number: string | null;
          court_id: string;
          created_at: string;
          id: string;
          portalis_number: string | null;
          procedure_type: string;
          pursuing_law_firm_label: string | null;
          updated_at: string;
        };
        Insert: {
          case_status?: string;
          court_case_number?: string | null;
          court_id: string;
          created_at?: string;
          id?: string;
          portalis_number?: string | null;
          procedure_type?: string;
          pursuing_law_firm_label?: string | null;
          updated_at?: string;
        };
        Update: {
          case_status?: string;
          court_case_number?: string | null;
          court_id?: string;
          created_at?: string;
          id?: string;
          portalis_number?: string | null;
          procedure_type?: string;
          pursuing_law_firm_label?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_cases_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_collection_checkpoints: {
        Row: {
          observed_at: string;
          payload: Json;
          run_id: string;
          signature: string;
          source_url: string;
        };
        Insert: {
          observed_at?: string;
          payload: Json;
          run_id: string;
          signature: string;
          source_url: string;
        };
        Update: {
          observed_at?: string;
          payload?: Json;
          run_id?: string;
          signature?: string;
          source_url?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_collection_checkpoints_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "auction_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_collection_items: {
        Row: {
          canonical_source_url: string | null;
          decision: string;
          discovered_at: string;
          evidence: Json;
          identity_hash: string;
          published_at: string | null;
          reason: string | null;
          run_id: string;
          source_name: string;
          source_url: string;
          updated_at: string;
        };
        Insert: {
          canonical_source_url?: string | null;
          decision?: string;
          discovered_at?: string;
          evidence?: Json;
          identity_hash: string;
          published_at?: string | null;
          reason?: string | null;
          run_id: string;
          source_name: string;
          source_url: string;
          updated_at?: string;
        };
        Update: {
          canonical_source_url?: string | null;
          decision?: string;
          discovered_at?: string;
          evidence?: Json;
          identity_hash?: string;
          published_at?: string | null;
          reason?: string | null;
          run_id?: string;
          source_name?: string;
          source_url?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_collection_items_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "auction_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_documents: {
        Row: {
          created_at: string | null;
          docling_duration_ms: number | null;
          docling_status: string | null;
          document_type: string | null;
          document_url: string;
          download_status: string | null;
          error_message: string | null;
          extraction_status: string | null;
          file_path: string | null;
          id: string;
          label: string | null;
          raw_payload: Json | null;
          sha256: string | null;
          source_url: string;
          text_chars: number | null;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string | null;
          docling_duration_ms?: number | null;
          docling_status?: string | null;
          document_type?: string | null;
          document_url: string;
          download_status?: string | null;
          error_message?: string | null;
          extraction_status?: string | null;
          file_path?: string | null;
          id?: string;
          label?: string | null;
          raw_payload?: Json | null;
          sha256?: string | null;
          source_url: string;
          text_chars?: number | null;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string | null;
          docling_duration_ms?: number | null;
          docling_status?: string | null;
          document_type?: string | null;
          document_url?: string;
          download_status?: string | null;
          error_message?: string | null;
          extraction_status?: string | null;
          file_path?: string | null;
          id?: string;
          label?: string | null;
          raw_payload?: Json | null;
          sha256?: string | null;
          source_url?: string;
          text_chars?: number | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_documents_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_documents_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_documents_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_documents_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_documents_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_documents_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_dpe_diagnostics: {
        Row: {
          address: string | null;
          ban_score: number | null;
          city: string | null;
          confidence: number;
          created_at: string;
          department: string | null;
          diagnostic_number: string;
          dpe_class: string | null;
          emissions_kg_co2_m2_year: number | null;
          energy_consumption_kwh_m2_year: number | null;
          established_at: string | null;
          ges_class: string | null;
          id: string;
          insee_code: string | null;
          last_modified_at: string | null;
          latitude: number | null;
          location: unknown;
          longitude: number | null;
          match_kind: string;
          postal_code: string | null;
          property_type: string | null;
          raw_payload: Json;
          source_api: string;
          source_api_url: string | null;
          source_url: string;
          surface_m2: number | null;
          updated_at: string;
          valid_until: string | null;
        };
        Insert: {
          address?: string | null;
          ban_score?: number | null;
          city?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          diagnostic_number: string;
          dpe_class?: string | null;
          emissions_kg_co2_m2_year?: number | null;
          energy_consumption_kwh_m2_year?: number | null;
          established_at?: string | null;
          ges_class?: string | null;
          id?: string;
          insee_code?: string | null;
          last_modified_at?: string | null;
          latitude?: number | null;
          location?: unknown;
          longitude?: number | null;
          match_kind?: string;
          postal_code?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          source_api?: string;
          source_api_url?: string | null;
          source_url: string;
          surface_m2?: number | null;
          updated_at?: string;
          valid_until?: string | null;
        };
        Update: {
          address?: string | null;
          ban_score?: number | null;
          city?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          diagnostic_number?: string;
          dpe_class?: string | null;
          emissions_kg_co2_m2_year?: number | null;
          energy_consumption_kwh_m2_year?: number | null;
          established_at?: string | null;
          ges_class?: string | null;
          id?: string;
          insee_code?: string | null;
          last_modified_at?: string | null;
          latitude?: number | null;
          location?: unknown;
          longitude?: number | null;
          match_kind?: string;
          postal_code?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          source_api?: string;
          source_api_url?: string | null;
          source_url?: string;
          surface_m2?: number | null;
          updated_at?: string;
          valid_until?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_dpe_diagnostics_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_dpe_diagnostics_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_dpe_diagnostics_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_dpe_diagnostics_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_dpe_diagnostics_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_dpe_diagnostics_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_enrichment_jobs: {
        Row: {
          attempt_count: number;
          completed_at: string | null;
          created_at: string;
          detail_source_name: string | null;
          detail_source_url: string | null;
          fact_claims_snapshot: Json | null;
          id: string;
          input_hash: string;
          job_type: string;
          last_error: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          priority: number;
          request_origin: string;
          requested_by: string | null;
          source_url: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          attempt_count?: number;
          completed_at?: string | null;
          created_at?: string;
          detail_source_name?: string | null;
          detail_source_url?: string | null;
          fact_claims_snapshot?: Json | null;
          id?: string;
          input_hash: string;
          job_type: string;
          last_error?: string | null;
          locked_at?: string | null;
          max_attempts?: number;
          next_attempt_at?: string;
          priority?: number;
          request_origin?: string;
          requested_by?: string | null;
          source_url: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attempt_count?: number;
          completed_at?: string | null;
          created_at?: string;
          detail_source_name?: string | null;
          detail_source_url?: string | null;
          fact_claims_snapshot?: Json | null;
          id?: string;
          input_hash?: string;
          job_type?: string;
          last_error?: string | null;
          locked_at?: string | null;
          max_attempts?: number;
          next_attempt_at?: string;
          priority?: number;
          request_origin?: string;
          requested_by?: string | null;
          source_url?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_enrichment_jobs_detail_source_name_fkey";
            columns: ["detail_source_name"];
            isOneToOne: false;
            referencedRelation: "auction_source_state";
            referencedColumns: ["source_name"];
          },
          {
            foreignKeyName: "auction_enrichment_jobs_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_enrichment_jobs_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_enrichment_jobs_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_enrichment_jobs_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_enrichment_jobs_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_enrichment_jobs_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_events: {
        Row: {
          actor_organization_id: string | null;
          actor_user_id: string | null;
          case_id: string | null;
          confidence_score: number | null;
          correction_reason: string | null;
          created_at: string;
          event_at: string | null;
          event_type: string;
          id: string;
          lot_id: string | null;
          observed_at: string;
          payload: Json;
          raw_artifact_id: string | null;
          round_id: string | null;
          source_id: string | null;
          supersedes_event_id: string | null;
        };
        Insert: {
          actor_organization_id?: string | null;
          actor_user_id?: string | null;
          case_id?: string | null;
          confidence_score?: number | null;
          correction_reason?: string | null;
          created_at?: string;
          event_at?: string | null;
          event_type: string;
          id?: string;
          lot_id?: string | null;
          observed_at?: string;
          payload?: Json;
          raw_artifact_id?: string | null;
          round_id?: string | null;
          source_id?: string | null;
          supersedes_event_id?: string | null;
        };
        Update: {
          actor_organization_id?: string | null;
          actor_user_id?: string | null;
          case_id?: string | null;
          confidence_score?: number | null;
          correction_reason?: string | null;
          created_at?: string;
          event_at?: string | null;
          event_type?: string;
          id?: string;
          lot_id?: string | null;
          observed_at?: string;
          payload?: Json;
          raw_artifact_id?: string | null;
          round_id?: string | null;
          source_id?: string | null;
          supersedes_event_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_events_artifact_source_fk";
            columns: ["raw_artifact_id", "source_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id", "source_id"];
          },
          {
            foreignKeyName: "auction_events_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "auction_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_events_lot_case_fk";
            columns: ["lot_id", "case_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id", "auction_case_id"];
          },
          {
            foreignKeyName: "auction_events_lot_id_fkey";
            columns: ["lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_events_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_events_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_events_round_lot_fk";
            columns: ["round_id", "lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id", "lot_id"];
          },
          {
            foreignKeyName: "auction_events_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_events_supersedes_event_id_fkey";
            columns: ["supersedes_event_id"];
            isOneToOne: false;
            referencedRelation: "auction_events";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_extractions: {
        Row: {
          confidence: Json | null;
          created_at: string | null;
          id: string;
          input_hash: string;
          model: string | null;
          provider: string;
          result: Json | null;
          schema_version: string;
          source_url: string;
          updated_at: string | null;
        };
        Insert: {
          confidence?: Json | null;
          created_at?: string | null;
          id?: string;
          input_hash: string;
          model?: string | null;
          provider: string;
          result?: Json | null;
          schema_version?: string;
          source_url: string;
          updated_at?: string | null;
        };
        Update: {
          confidence?: Json | null;
          created_at?: string | null;
          id?: string;
          input_hash?: string;
          model?: string | null;
          provider?: string;
          result?: Json | null;
          schema_version?: string;
          source_url?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_extractions_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_extractions_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_extractions_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_extractions_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_extractions_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_extractions_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_fact_claims: {
        Row: {
          ai_review_projection_id: string | null;
          artifact_extraction_id: string | null;
          auction_sale_id: string | null;
          captured_at: string;
          claim_status: string;
          confidence_score: number | null;
          conflict_group: string | null;
          created_at: string;
          created_by: string | null;
          created_by_redacted_at: string | null;
          evidence_kind: string;
          evidence_locator: Json;
          extractor_name: string | null;
          extractor_version: string | null;
          field_key: string;
          id: string;
          lot_id: string | null;
          raw_artifact_id: string | null;
          resolution_actor_id: string | null;
          resolution_actor_redacted_at: string | null;
          resolution_actor_type: string | null;
          resolution_note: string | null;
          resolved_at: string | null;
          source_id: string | null;
          source_record_id: string | null;
          source_url: string | null;
          supersedes_claim_id: string | null;
          updated_at: string;
          value_jsonb: Json;
        };
        Insert: {
          ai_review_projection_id?: string | null;
          artifact_extraction_id?: string | null;
          auction_sale_id?: string | null;
          captured_at?: string;
          claim_status?: string;
          confidence_score?: number | null;
          conflict_group?: string | null;
          created_at?: string;
          created_by?: string | null;
          created_by_redacted_at?: string | null;
          evidence_kind: string;
          evidence_locator?: Json;
          extractor_name?: string | null;
          extractor_version?: string | null;
          field_key: string;
          id?: string;
          lot_id?: string | null;
          raw_artifact_id?: string | null;
          resolution_actor_id?: string | null;
          resolution_actor_redacted_at?: string | null;
          resolution_actor_type?: string | null;
          resolution_note?: string | null;
          resolved_at?: string | null;
          source_id?: string | null;
          source_record_id?: string | null;
          source_url?: string | null;
          supersedes_claim_id?: string | null;
          updated_at?: string;
          value_jsonb: Json;
        };
        Update: {
          ai_review_projection_id?: string | null;
          artifact_extraction_id?: string | null;
          auction_sale_id?: string | null;
          captured_at?: string;
          claim_status?: string;
          confidence_score?: number | null;
          conflict_group?: string | null;
          created_at?: string;
          created_by?: string | null;
          created_by_redacted_at?: string | null;
          evidence_kind?: string;
          evidence_locator?: Json;
          extractor_name?: string | null;
          extractor_version?: string | null;
          field_key?: string;
          id?: string;
          lot_id?: string | null;
          raw_artifact_id?: string | null;
          resolution_actor_id?: string | null;
          resolution_actor_redacted_at?: string | null;
          resolution_actor_type?: string | null;
          resolution_note?: string | null;
          resolved_at?: string | null;
          source_id?: string | null;
          source_record_id?: string | null;
          source_url?: string | null;
          supersedes_claim_id?: string | null;
          updated_at?: string;
          value_jsonb?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "auction_fact_claims_ai_review_projection_id_fkey";
            columns: ["ai_review_projection_id"];
            isOneToOne: false;
            referencedRelation: "auction_ai_review_projections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_ai_review_projection_id_fkey";
            columns: ["ai_review_projection_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_ai_review_projection_read_model";
            referencedColumns: ["projection_id"];
          },
          {
            foreignKeyName: "auction_fact_claims_ai_review_projection_id_fkey";
            columns: ["ai_review_projection_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_ai_review_projection_reconciliation";
            referencedColumns: ["projection_id"];
          },
          {
            foreignKeyName: "auction_fact_claims_ai_review_projection_id_fkey";
            columns: ["ai_review_projection_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_ai_review_publishable";
            referencedColumns: ["projection_id"];
          },
          {
            foreignKeyName: "auction_fact_claims_artifact_extraction_id_fkey";
            columns: ["artifact_extraction_id"];
            isOneToOne: false;
            referencedRelation: "artifact_extractions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_lot_id_fkey";
            columns: ["lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_raw_artifact_source_fk";
            columns: ["raw_artifact_id", "source_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id", "source_id"];
          },
          {
            foreignKeyName: "auction_fact_claims_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_source_record_id_fkey";
            columns: ["source_record_id"];
            isOneToOne: false;
            referencedRelation: "judicial_source_records";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_supersedes_claim_id_fkey";
            columns: ["supersedes_claim_id"];
            isOneToOne: false;
            referencedRelation: "auction_fact_claims";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_supersedes_claim_id_fkey";
            columns: ["supersedes_claim_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_fact_claims_read_model";
            referencedColumns: ["claim_id"];
          },
        ];
      };
      auction_feature_snapshots: {
        Row: {
          bdnb_release: string | null;
          built_at: string;
          created_at: string;
          data_completeness_score: number | null;
          data_freshness_score: number | null;
          dpe_release: string | null;
          dvf_release: string | null;
          feature_builder_version: string;
          feature_cutoff_at: string;
          feature_schema_version: string;
          features: Json;
          id: string;
          leakage_check_status: string;
          lot_id: string;
          market_estimate_version: string | null;
          prediction_horizon: string;
          recorded_at: string;
          retrospective: boolean;
          rnic_release: string | null;
          round_id: string;
          snapshot_hash: string;
          source_manifest: Json;
          source_manifest_hash: string;
          training_eligible: boolean;
        };
        Insert: {
          bdnb_release?: string | null;
          built_at?: string;
          created_at?: string;
          data_completeness_score?: number | null;
          data_freshness_score?: number | null;
          dpe_release?: string | null;
          dvf_release?: string | null;
          feature_builder_version: string;
          feature_cutoff_at: string;
          feature_schema_version: string;
          features: Json;
          id?: string;
          leakage_check_status?: string;
          lot_id: string;
          market_estimate_version?: string | null;
          prediction_horizon: string;
          recorded_at?: string;
          retrospective?: boolean;
          rnic_release?: string | null;
          round_id: string;
          snapshot_hash: string;
          source_manifest: Json;
          source_manifest_hash: string;
          training_eligible?: boolean;
        };
        Update: {
          bdnb_release?: string | null;
          built_at?: string;
          created_at?: string;
          data_completeness_score?: number | null;
          data_freshness_score?: number | null;
          dpe_release?: string | null;
          dvf_release?: string | null;
          feature_builder_version?: string;
          feature_cutoff_at?: string;
          feature_schema_version?: string;
          features?: Json;
          id?: string;
          leakage_check_status?: string;
          lot_id?: string;
          market_estimate_version?: string | null;
          prediction_horizon?: string;
          recorded_at?: string;
          retrospective?: boolean;
          rnic_release?: string | null;
          round_id?: string;
          snapshot_hash?: string;
          source_manifest?: Json;
          source_manifest_hash?: string;
          training_eligible?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "auction_feature_snapshots_lot_id_fkey";
            columns: ["lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_feature_snapshots_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_feature_snapshots_round_lot_fk";
            columns: ["round_id", "lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id", "lot_id"];
          },
        ];
      };
      auction_features: {
        Row: {
          bathrooms_count: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          investment_score: number | null;
          investment_summary: string | null;
          parking_count: number | null;
          source_url: string;
          updated_at: string | null;
        };
        Insert: {
          bathrooms_count?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          investment_score?: number | null;
          investment_summary?: string | null;
          parking_count?: number | null;
          source_url: string;
          updated_at?: string | null;
        };
        Update: {
          bathrooms_count?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          investment_score?: number | null;
          investment_summary?: string | null;
          parking_count?: number | null;
          source_url?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_features_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_features_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_features_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_features_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_features_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_features_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_lots: {
        Row: {
          active: boolean;
          address_id: string | null;
          auction_case_id: string;
          auction_sale_id: string | null;
          bedroom_count: number | null;
          carrez_area_m2: number | null;
          created_at: string;
          document_completeness_score: number | null;
          id: string;
          initial_starting_price_eur: number | null;
          land_area_m2: number | null;
          living_area_m2: number | null;
          lot_label: string | null;
          lot_number: string | null;
          occupation_confidence: number | null;
          occupation_status: string;
          parking_count: number | null;
          price_reduction_rules: Json;
          property_type: string;
          room_count: number | null;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          address_id?: string | null;
          auction_case_id: string;
          auction_sale_id?: string | null;
          bedroom_count?: number | null;
          carrez_area_m2?: number | null;
          created_at?: string;
          document_completeness_score?: number | null;
          id?: string;
          initial_starting_price_eur?: number | null;
          land_area_m2?: number | null;
          living_area_m2?: number | null;
          lot_label?: string | null;
          lot_number?: string | null;
          occupation_confidence?: number | null;
          occupation_status?: string;
          parking_count?: number | null;
          price_reduction_rules?: Json;
          property_type?: string;
          room_count?: number | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          address_id?: string | null;
          auction_case_id?: string;
          auction_sale_id?: string | null;
          bedroom_count?: number | null;
          carrez_area_m2?: number | null;
          created_at?: string;
          document_completeness_score?: number | null;
          id?: string;
          initial_starting_price_eur?: number | null;
          land_area_m2?: number | null;
          living_area_m2?: number | null;
          lot_label?: string | null;
          lot_number?: string | null;
          occupation_confidence?: number | null;
          occupation_status?: string;
          parking_count?: number | null;
          price_reduction_rules?: Json;
          property_type?: string;
          room_count?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_lots_address_id_fkey";
            columns: ["address_id"];
            isOneToOne: false;
            referencedRelation: "outcome_addresses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_case_id_fkey";
            columns: ["auction_case_id"];
            isOneToOne: false;
            referencedRelation: "auction_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_lots_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_observations: {
        Row: {
          canonical_source_url: string | null;
          content_hash: string | null;
          external_id: string | null;
          observed_at: string | null;
          raw_payload: Json | null;
          source_name: string;
          source_url: string;
          updated_at: string | null;
        };
        Insert: {
          canonical_source_url?: string | null;
          content_hash?: string | null;
          external_id?: string | null;
          observed_at?: string | null;
          raw_payload?: Json | null;
          source_name: string;
          source_url: string;
          updated_at?: string | null;
        };
        Update: {
          canonical_source_url?: string | null;
          content_hash?: string | null;
          external_id?: string | null;
          observed_at?: string | null;
          raw_payload?: Json | null;
          source_name?: string;
          source_url?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_observations_canonical_source_url_fkey";
            columns: ["canonical_source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_observations_canonical_source_url_fkey";
            columns: ["canonical_source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_observations_canonical_source_url_fkey";
            columns: ["canonical_source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_observations_canonical_source_url_fkey";
            columns: ["canonical_source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_observations_canonical_source_url_fkey";
            columns: ["canonical_source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_observations_canonical_source_url_fkey";
            columns: ["canonical_source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_outcome_evidence: {
        Row: {
          claim_types: string[];
          created_at: string;
          evidence_grade: string;
          evidence_type: string;
          finality_confidence: number | null;
          id: string;
          lot_matching_confidence: number | null;
          outcome_id: string;
          price_extraction_confidence: number | null;
          raw_artifact_id: string | null;
          review_status: string;
          round_matching_confidence: number | null;
          source_id: string;
        };
        Insert: {
          claim_types?: string[];
          created_at?: string;
          evidence_grade: string;
          evidence_type: string;
          finality_confidence?: number | null;
          id?: string;
          lot_matching_confidence?: number | null;
          outcome_id: string;
          price_extraction_confidence?: number | null;
          raw_artifact_id?: string | null;
          review_status?: string;
          round_matching_confidence?: number | null;
          source_id: string;
        };
        Update: {
          claim_types?: string[];
          created_at?: string;
          evidence_grade?: string;
          evidence_type?: string;
          finality_confidence?: number | null;
          id?: string;
          lot_matching_confidence?: number | null;
          outcome_id?: string;
          price_extraction_confidence?: number | null;
          raw_artifact_id?: string | null;
          review_status?: string;
          round_matching_confidence?: number | null;
          source_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_outcome_evidence_artifact_source_fk";
            columns: ["raw_artifact_id", "source_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id", "source_id"];
          },
          {
            foreignKeyName: "auction_outcome_evidence_outcome_id_fkey";
            columns: ["outcome_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcomes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_outcome_evidence_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_outcome_evidence_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_outcomes: {
        Row: {
          bidder_count_bucket: string;
          canonical_confidence: number | null;
          created_at: string;
          created_by: string | null;
          final_hammer_price_eur: number | null;
          finality_status: string;
          id: string;
          initial_hammer_price_eur: number | null;
          outcome_status: string;
          payment_status: string;
          recorded_at: string;
          result_observed_at: string | null;
          round_id: string;
          supersedes_outcome_id: string | null;
          surenchere_amount_eur: number | null;
          surenchere_filed_at: string | null;
          surenchere_status: string;
          taxed_costs_eur: number | null;
          training_eligible: boolean;
          valid_from: string;
          valid_to: string | null;
          version: number;
        };
        Insert: {
          bidder_count_bucket?: string;
          canonical_confidence?: number | null;
          created_at?: string;
          created_by?: string | null;
          final_hammer_price_eur?: number | null;
          finality_status?: string;
          id?: string;
          initial_hammer_price_eur?: number | null;
          outcome_status: string;
          payment_status?: string;
          recorded_at?: string;
          result_observed_at?: string | null;
          round_id: string;
          supersedes_outcome_id?: string | null;
          surenchere_amount_eur?: number | null;
          surenchere_filed_at?: string | null;
          surenchere_status?: string;
          taxed_costs_eur?: number | null;
          training_eligible?: boolean;
          valid_from?: string;
          valid_to?: string | null;
          version: number;
        };
        Update: {
          bidder_count_bucket?: string;
          canonical_confidence?: number | null;
          created_at?: string;
          created_by?: string | null;
          final_hammer_price_eur?: number | null;
          finality_status?: string;
          id?: string;
          initial_hammer_price_eur?: number | null;
          outcome_status?: string;
          payment_status?: string;
          recorded_at?: string;
          result_observed_at?: string | null;
          round_id?: string;
          supersedes_outcome_id?: string | null;
          surenchere_amount_eur?: number | null;
          surenchere_filed_at?: string | null;
          surenchere_status?: string;
          taxed_costs_eur?: number | null;
          training_eligible?: boolean;
          valid_from?: string;
          valid_to?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "auction_outcomes_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_outcomes_superseded_round_fk";
            columns: ["supersedes_outcome_id", "round_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcomes";
            referencedColumns: ["id", "round_id"];
          },
          {
            foreignKeyName: "auction_outcomes_supersedes_outcome_id_fkey";
            columns: ["supersedes_outcome_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcomes";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_pipeline_control: {
        Row: {
          daily_ai_budget_usd: number;
          enabled: boolean;
          enrichment_drain_until: string | null;
          id: boolean;
          last_dispatch_at: string | null;
          max_ai_predictions_per_run: number;
          next_enrichment_at: string;
          observation_started_at: string | null;
          queue_claim_not_before: string | null;
          source_details_enabled: boolean;
          source_dispatch_streak: number;
          updated_at: string;
        };
        Insert: {
          daily_ai_budget_usd?: number;
          enabled?: boolean;
          enrichment_drain_until?: string | null;
          id?: boolean;
          last_dispatch_at?: string | null;
          max_ai_predictions_per_run?: number;
          next_enrichment_at?: string;
          observation_started_at?: string | null;
          queue_claim_not_before?: string | null;
          source_details_enabled?: boolean;
          source_dispatch_streak?: number;
          updated_at?: string;
        };
        Update: {
          daily_ai_budget_usd?: number;
          enabled?: boolean;
          enrichment_drain_until?: string | null;
          id?: boolean;
          last_dispatch_at?: string | null;
          max_ai_predictions_per_run?: number;
          next_enrichment_at?: string;
          observation_started_at?: string | null;
          queue_claim_not_before?: string | null;
          source_details_enabled?: boolean;
          source_dispatch_streak?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      auction_pipeline_observations: {
        Row: {
          id: number;
          metrics: Json;
          observed_at: string;
          source_name: string;
        };
        Insert: {
          id?: never;
          metrics: Json;
          observed_at?: string;
          source_name: string;
        };
        Update: {
          id?: never;
          metrics?: Json;
          observed_at?: string;
          source_name?: string;
        };
        Relationships: [];
      };
      auction_pipeline_usage: {
        Row: {
          created_at: string;
          estimated_usd: number | null;
          id: string;
          metrics: Json;
          model: string;
          prediction_id: string | null;
          rate_source: string | null;
          reserved_usd: number;
          run_id: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          estimated_usd?: number | null;
          id?: string;
          metrics?: Json;
          model: string;
          prediction_id?: string | null;
          rate_source?: string | null;
          reserved_usd?: number;
          run_id: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          estimated_usd?: number | null;
          id?: string;
          metrics?: Json;
          model?: string;
          prediction_id?: string | null;
          rate_source?: string | null;
          reserved_usd?: number;
          run_id?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_pipeline_usage_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "auction_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_predictions: {
        Row: {
          cohort_statistics_id: string | null;
          conditional_on: Json;
          confidence_label: string | null;
          confidence_level: number | null;
          created_at: string;
          expected_value_eur: number | null;
          explanation_factors: Json;
          generated_at: string;
          horizon: string;
          id: string;
          limitations: Json;
          model_version_id: string;
          prediction_hash: string;
          prediction_kind: string;
          prediction_status: string;
          probabilities: Json;
          quantiles: Json;
          refusal_reason: string | null;
          round_id: string;
          sample_size: number | null;
          snapshot_id: string;
          superseded_by: string | null;
          supersedes_prediction_id: string | null;
        };
        Insert: {
          cohort_statistics_id?: string | null;
          conditional_on?: Json;
          confidence_label?: string | null;
          confidence_level?: number | null;
          created_at?: string;
          expected_value_eur?: number | null;
          explanation_factors?: Json;
          generated_at?: string;
          horizon: string;
          id?: string;
          limitations?: Json;
          model_version_id: string;
          prediction_hash: string;
          prediction_kind?: string;
          prediction_status?: string;
          probabilities?: Json;
          quantiles?: Json;
          refusal_reason?: string | null;
          round_id: string;
          sample_size?: number | null;
          snapshot_id: string;
          superseded_by?: string | null;
          supersedes_prediction_id?: string | null;
        };
        Update: {
          cohort_statistics_id?: string | null;
          conditional_on?: Json;
          confidence_label?: string | null;
          confidence_level?: number | null;
          created_at?: string;
          expected_value_eur?: number | null;
          explanation_factors?: Json;
          generated_at?: string;
          horizon?: string;
          id?: string;
          limitations?: Json;
          model_version_id?: string;
          prediction_hash?: string;
          prediction_kind?: string;
          prediction_status?: string;
          probabilities?: Json;
          quantiles?: Json;
          refusal_reason?: string | null;
          round_id?: string;
          sample_size?: number | null;
          snapshot_id?: string;
          superseded_by?: string | null;
          supersedes_prediction_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_predictions_cohort_statistics_id_fkey";
            columns: ["cohort_statistics_id"];
            isOneToOne: false;
            referencedRelation: "cohort_statistics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_predictions_model_version_id_fkey";
            columns: ["model_version_id"];
            isOneToOne: false;
            referencedRelation: "model_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_predictions_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_predictions_snapshot_id_fkey";
            columns: ["snapshot_id"];
            isOneToOne: false;
            referencedRelation: "auction_feature_snapshots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_predictions_snapshot_round_fk";
            columns: ["snapshot_id", "round_id"];
            isOneToOne: false;
            referencedRelation: "auction_feature_snapshots";
            referencedColumns: ["id", "round_id"];
          },
          {
            foreignKeyName: "auction_predictions_superseded_by_fkey";
            columns: ["superseded_by"];
            isOneToOne: false;
            referencedRelation: "auction_predictions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_predictions_supersedes_prediction_id_fkey";
            columns: ["supersedes_prediction_id"];
            isOneToOne: false;
            referencedRelation: "auction_predictions";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_risk_occurrences: {
        Row: {
          confidence: number | null;
          created_at: string | null;
          detector: string | null;
          detector_version: string | null;
          document_label: string | null;
          document_type: string | null;
          document_url: string | null;
          excerpt: string;
          id: string;
          is_negated: boolean;
          matched_terms: Json;
          page_number: number | null;
          risk_label: string;
          risk_type: string;
          score_impact: number | null;
          severity: number | null;
          source_url: string;
          updated_at: string | null;
        };
        Insert: {
          confidence?: number | null;
          created_at?: string | null;
          detector?: string | null;
          detector_version?: string | null;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt: string;
          id?: string;
          is_negated?: boolean;
          matched_terms?: Json;
          page_number?: number | null;
          risk_label: string;
          risk_type: string;
          score_impact?: number | null;
          severity?: number | null;
          source_url: string;
          updated_at?: string | null;
        };
        Update: {
          confidence?: number | null;
          created_at?: string | null;
          detector?: string | null;
          detector_version?: string | null;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string;
          id?: string;
          is_negated?: boolean;
          matched_terms?: Json;
          page_number?: number | null;
          risk_label?: string;
          risk_type?: string;
          score_impact?: number | null;
          severity?: number | null;
          source_url?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_risk_occurrences_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risk_occurrences_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risk_occurrences_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risk_occurrences_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risk_occurrences_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risk_occurrences_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_risks: {
        Row: {
          confidence: number | null;
          detector: string | null;
          detector_version: string | null;
          evidence: string | null;
          evidence_json: Json;
          id: string;
          risk_label: string;
          risk_type: string;
          score_impact: number | null;
          severity: number | null;
          source_url: string;
          updated_at: string | null;
        };
        Insert: {
          confidence?: number | null;
          detector?: string | null;
          detector_version?: string | null;
          evidence?: string | null;
          evidence_json?: Json;
          id?: string;
          risk_label: string;
          risk_type: string;
          score_impact?: number | null;
          severity?: number | null;
          source_url: string;
          updated_at?: string | null;
        };
        Update: {
          confidence?: number | null;
          detector?: string | null;
          detector_version?: string | null;
          evidence?: string | null;
          evidence_json?: Json;
          id?: string;
          risk_label?: string;
          risk_type?: string;
          score_impact?: number | null;
          severity?: number | null;
          source_url?: string;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_risks_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risks_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risks_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risks_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risks_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_risks_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_rounds: {
        Row: {
          actual_ended_at: string | null;
          actual_started_at: string | null;
          court_id: string;
          created_at: string;
          current_status: string;
          effective_starting_price_eur: number | null;
          first_bid_level_eur: number | null;
          hearing_room: string | null;
          id: string;
          initial_starting_price_eur: number | null;
          local_timezone: string;
          lot_id: string;
          previous_round_id: string | null;
          price_steps_eur: number[] | null;
          publication_first_seen_at: string | null;
          recorded_at: string;
          result_first_seen_at: string | null;
          round_kind: string;
          scheduled_at: string | null;
          sequence_number: number;
          status_confidence: number | null;
          updated_at: string;
        };
        Insert: {
          actual_ended_at?: string | null;
          actual_started_at?: string | null;
          court_id: string;
          created_at?: string;
          current_status?: string;
          effective_starting_price_eur?: number | null;
          first_bid_level_eur?: number | null;
          hearing_room?: string | null;
          id?: string;
          initial_starting_price_eur?: number | null;
          local_timezone?: string;
          lot_id: string;
          previous_round_id?: string | null;
          price_steps_eur?: number[] | null;
          publication_first_seen_at?: string | null;
          recorded_at?: string;
          result_first_seen_at?: string | null;
          round_kind: string;
          scheduled_at?: string | null;
          sequence_number: number;
          status_confidence?: number | null;
          updated_at?: string;
        };
        Update: {
          actual_ended_at?: string | null;
          actual_started_at?: string | null;
          court_id?: string;
          created_at?: string;
          current_status?: string;
          effective_starting_price_eur?: number | null;
          first_bid_level_eur?: number | null;
          hearing_room?: string | null;
          id?: string;
          initial_starting_price_eur?: number | null;
          local_timezone?: string;
          lot_id?: string;
          previous_round_id?: string | null;
          price_steps_eur?: number[] | null;
          publication_first_seen_at?: string | null;
          recorded_at?: string;
          result_first_seen_at?: string | null;
          round_kind?: string;
          scheduled_at?: string | null;
          sequence_number?: number;
          status_confidence?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_rounds_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_rounds_lot_id_fkey";
            columns: ["lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_rounds_previous_round_id_fkey";
            columns: ["previous_round_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_rounds_previous_round_lot_fk";
            columns: ["previous_round_id", "lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id", "lot_id"];
          },
        ];
      };
      auction_runs: {
        Row: {
          created_at: string | null;
          errors: Json | null;
          finished_at: string | null;
          id: string;
          scheduler_owned: boolean;
          source: string | null;
          started_at: string | null;
          status: string;
          summary: Json | null;
          updated_at: string | null;
          use_llm: boolean | null;
        };
        Insert: {
          created_at?: string | null;
          errors?: Json | null;
          finished_at?: string | null;
          id?: string;
          scheduler_owned?: boolean;
          source?: string | null;
          started_at?: string | null;
          status?: string;
          summary?: Json | null;
          updated_at?: string | null;
          use_llm?: boolean | null;
        };
        Update: {
          created_at?: string | null;
          errors?: Json | null;
          finished_at?: string | null;
          id?: string;
          scheduler_owned?: boolean;
          source?: string | null;
          started_at?: string | null;
          status?: string;
          summary?: Json | null;
          updated_at?: string | null;
          use_llm?: boolean | null;
        };
        Relationships: [];
      };
      auction_sale_competent_court_assignments: {
        Row: {
          auction_sale_id: string | null;
          commune_name: string;
          court_code: string;
          court_id: string;
          court_name: string;
          court_origin_code: string;
          court_srj_code: string;
          created_at: string;
          evidence: Json;
          id: string;
          insee_code: string;
          mapping_method: string;
          official_court_name: string;
          reference_sha256: string;
          source_key: string;
          source_url_snapshot: string;
        };
        Insert: {
          auction_sale_id?: string | null;
          commune_name: string;
          court_code: string;
          court_id: string;
          court_name: string;
          court_origin_code: string;
          court_srj_code: string;
          created_at?: string;
          evidence: Json;
          id?: string;
          insee_code: string;
          mapping_method: string;
          official_court_name: string;
          reference_sha256: string;
          source_key: string;
          source_url_snapshot: string;
        };
        Update: {
          auction_sale_id?: string | null;
          commune_name?: string;
          court_code?: string;
          court_id?: string;
          court_name?: string;
          court_origin_code?: string;
          court_srj_code?: string;
          created_at?: string;
          evidence?: Json;
          id?: string;
          insee_code?: string;
          mapping_method?: string;
          official_court_name?: string;
          reference_sha256?: string;
          source_key?: string;
          source_url_snapshot?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sale_competent_court_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_competent_court_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_competent_court_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_competent_court_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_competent_court_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_competent_court_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_competent_court_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_competent_court_assignments_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_sale_court_document_assignments: {
        Row: {
          auction_sale_id: string | null;
          candidate_count: number;
          court_code: string;
          court_id: string;
          court_name: string;
          document_label: string | null;
          document_page: number;
          document_sha256: string;
          document_url: string;
          id: string;
          matched_reference_label: string;
          normalized_observed_court_label: string;
          observed_court_label: string;
          resolution_method: string;
          review_method: string;
          reviewed_at: string;
          source_key: string;
          source_url_snapshot: string;
        };
        Insert: {
          auction_sale_id?: string | null;
          candidate_count?: number;
          court_code: string;
          court_id: string;
          court_name: string;
          document_label?: string | null;
          document_page: number;
          document_sha256: string;
          document_url: string;
          id?: string;
          matched_reference_label: string;
          normalized_observed_court_label: string;
          observed_court_label: string;
          resolution_method: string;
          review_method: string;
          reviewed_at?: string;
          source_key: string;
          source_url_snapshot: string;
        };
        Update: {
          auction_sale_id?: string | null;
          candidate_count?: number;
          court_code?: string;
          court_id?: string;
          court_name?: string;
          document_label?: string | null;
          document_page?: number;
          document_sha256?: string;
          document_url?: string;
          id?: string;
          matched_reference_label?: string;
          normalized_observed_court_label?: string;
          observed_court_label?: string;
          resolution_method?: string;
          review_method?: string;
          reviewed_at?: string;
          source_key?: string;
          source_url_snapshot?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sale_court_document_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_document_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_document_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_document_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_document_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_document_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_document_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_document_assignments_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_sale_court_label_assignments: {
        Row: {
          auction_sale_id: string | null;
          candidate_count: number;
          court_code: string;
          court_id: string;
          court_name: string;
          created_at: string;
          id: string;
          mapping_method: string;
          matched_label: string;
          normalized_matched_label: string;
          normalized_source_label: string;
          source_key: string;
          source_label_snapshot: string;
          source_url_snapshot: string;
        };
        Insert: {
          auction_sale_id?: string | null;
          candidate_count?: number;
          court_code: string;
          court_id: string;
          court_name: string;
          created_at?: string;
          id?: string;
          mapping_method: string;
          matched_label: string;
          normalized_matched_label: string;
          normalized_source_label: string;
          source_key: string;
          source_label_snapshot: string;
          source_url_snapshot: string;
        };
        Update: {
          auction_sale_id?: string | null;
          candidate_count?: number;
          court_code?: string;
          court_id?: string;
          court_name?: string;
          created_at?: string;
          id?: string;
          mapping_method?: string;
          matched_label?: string;
          normalized_matched_label?: string;
          normalized_source_label?: string;
          source_key?: string;
          source_label_snapshot?: string;
          source_url_snapshot?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sale_court_label_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_label_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_label_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_label_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_label_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_label_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_label_assignments_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_court_label_assignments_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_sale_history: {
        Row: {
          changed_at: string | null;
          changed_fields: Json;
          id: string;
          source_url: string;
        };
        Insert: {
          changed_at?: string | null;
          changed_fields?: Json;
          id?: string;
          source_url: string;
        };
        Update: {
          changed_at?: string | null;
          changed_fields?: Json;
          id?: string;
          source_url?: string;
        };
        Relationships: [];
      };
      auction_sale_market_estimates: {
        Row: {
          actionable: boolean;
          attempt_count: number;
          auction_sale_id: string;
          comparable_count: number;
          computed_at: string | null;
          confidence_score: number | null;
          created_at: string;
          engine_kind: string | null;
          engine_version: string | null;
          error_message: string | null;
          estimate: Json | null;
          input_fingerprint: string;
          last_error_code: string | null;
          last_finished_at: string | null;
          last_started_at: string | null;
          model_version: string | null;
          model_version_id: string | null;
          next_refresh_at: string;
          priority: number;
          refresh_reason: string;
          requested_at: string | null;
          segment: string | null;
          source_updated_at: string | null;
          status: string;
          updated_at: string;
          value_p10_eur: number | null;
          value_p50_eur: number | null;
          value_p90_eur: number | null;
        };
        Insert: {
          actionable?: boolean;
          attempt_count?: number;
          auction_sale_id: string;
          comparable_count?: number;
          computed_at?: string | null;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind?: string | null;
          engine_version?: string | null;
          error_message?: string | null;
          estimate?: Json | null;
          input_fingerprint: string;
          last_error_code?: string | null;
          last_finished_at?: string | null;
          last_started_at?: string | null;
          model_version?: string | null;
          model_version_id?: string | null;
          next_refresh_at?: string;
          priority?: number;
          refresh_reason?: string;
          requested_at?: string | null;
          segment?: string | null;
          source_updated_at?: string | null;
          status?: string;
          updated_at?: string;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Update: {
          actionable?: boolean;
          attempt_count?: number;
          auction_sale_id?: string;
          comparable_count?: number;
          computed_at?: string | null;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind?: string | null;
          engine_version?: string | null;
          error_message?: string | null;
          estimate?: Json | null;
          input_fingerprint?: string;
          last_error_code?: string | null;
          last_finished_at?: string | null;
          last_started_at?: string | null;
          model_version?: string | null;
          model_version_id?: string | null;
          next_refresh_at?: string;
          priority?: number;
          refresh_reason?: string;
          requested_at?: string | null;
          segment?: string | null;
          source_updated_at?: string | null;
          status?: string;
          updated_at?: string;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_model_version_id_fkey";
            columns: ["model_version_id"];
            isOneToOne: false;
            referencedRelation: "valuation_model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_sale_outcome_bridges: {
        Row: {
          address_mapping_input: Json;
          address_mapping_method: string;
          announcement_event_id: string;
          auction_sale_id: string | null;
          case_id: string;
          case_mapping_method: string;
          catalogue_status: string;
          court_mapping_input: Json;
          court_mapping_method: string;
          created_at: string;
          external_id_snapshot: string | null;
          id: string;
          lot_id: string;
          outcome_status: string;
          round_id: string;
          source_key: string;
          source_name_snapshot: string;
          source_snapshot: Json;
          source_url_snapshot: string;
          training_eligible: boolean;
          unknown_outcome_id: string;
        };
        Insert: {
          address_mapping_input: Json;
          address_mapping_method: string;
          announcement_event_id: string;
          auction_sale_id?: string | null;
          case_id: string;
          case_mapping_method: string;
          catalogue_status?: string;
          court_mapping_input: Json;
          court_mapping_method: string;
          created_at?: string;
          external_id_snapshot?: string | null;
          id?: string;
          lot_id: string;
          outcome_status?: string;
          round_id: string;
          source_key: string;
          source_name_snapshot: string;
          source_snapshot: Json;
          source_url_snapshot: string;
          training_eligible?: boolean;
          unknown_outcome_id: string;
        };
        Update: {
          address_mapping_input?: Json;
          address_mapping_method?: string;
          announcement_event_id?: string;
          auction_sale_id?: string | null;
          case_id?: string;
          case_mapping_method?: string;
          catalogue_status?: string;
          court_mapping_input?: Json;
          court_mapping_method?: string;
          created_at?: string;
          external_id_snapshot?: string | null;
          id?: string;
          lot_id?: string;
          outcome_status?: string;
          round_id?: string;
          source_key?: string;
          source_name_snapshot?: string;
          source_snapshot?: Json;
          source_url_snapshot?: string;
          training_eligible?: boolean;
          unknown_outcome_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sale_outcome_bridges_announcement_event_id_fkey";
            columns: ["announcement_event_id"];
            isOneToOne: true;
            referencedRelation: "auction_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: true;
            referencedRelation: "auction_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_lot_case_fk";
            columns: ["lot_id", "case_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id", "auction_case_id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_lot_id_fkey";
            columns: ["lot_id"];
            isOneToOne: true;
            referencedRelation: "auction_lots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_outcome_round_fk";
            columns: ["unknown_outcome_id", "round_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcomes";
            referencedColumns: ["id", "round_id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: true;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_outcome_bridges_round_lot_fk";
            columns: ["round_id", "lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id", "lot_id"];
          },
        ];
      };
      auction_sale_readiness_history: {
        Row: {
          blockers: Json;
          evaluated_at: string | null;
          factors: Json;
          id: number;
          missing_fields: Json;
          override_at: string | null;
          override_by: string | null;
          override_decision: string | null;
          override_expires_at: string | null;
          override_reason: string | null;
          policy_version: string | null;
          readiness_score: number | null;
          readiness_status: string;
          recorded_at: string;
          sale_id: string;
        };
        Insert: {
          blockers?: Json;
          evaluated_at?: string | null;
          factors?: Json;
          id?: never;
          missing_fields?: Json;
          override_at?: string | null;
          override_by?: string | null;
          override_decision?: string | null;
          override_expires_at?: string | null;
          override_reason?: string | null;
          policy_version?: string | null;
          readiness_score?: number | null;
          readiness_status: string;
          recorded_at?: string;
          sale_id: string;
        };
        Update: {
          blockers?: Json;
          evaluated_at?: string | null;
          factors?: Json;
          id?: never;
          missing_fields?: Json;
          override_at?: string | null;
          override_by?: string | null;
          override_decision?: string | null;
          override_expires_at?: string | null;
          override_reason?: string | null;
          policy_version?: string | null;
          readiness_score?: number | null;
          readiness_status?: string;
          recorded_at?: string;
          sale_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sale_readiness_history_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_readiness_history_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_readiness_history_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_readiness_history_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_readiness_history_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_readiness_history_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_readiness_history_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_sale_retention_tombstones: {
        Row: {
          expired_at: string;
          reason: string;
          sale_date: string | null;
          source_url: string;
        };
        Insert: {
          expired_at?: string;
          reason?: string;
          sale_date?: string | null;
          source_url: string;
        };
        Update: {
          expired_at?: string;
          reason?: string;
          sale_date?: string | null;
          source_url?: string;
        };
        Relationships: [];
      };
      auction_sales: {
        Row: {
          address: string | null;
          adjudication_price_eur: number | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          catalogue_expiry_deadline: string | null;
          catalogue_expiry_materialized: boolean;
          catalogue_quarantined: boolean;
          catalogue_thumbnail_url: string | null;
          city: string | null;
          content_hash: string | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          external_id: string | null;
          first_seen_at: string | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          last_run_id: string | null;
          last_seen_at: string | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          location: unknown;
          longitude: number | null;
          observations: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          premium_readiness_blockers: Json;
          premium_readiness_evaluated_at: string | null;
          premium_readiness_factors: Json;
          premium_readiness_missing_fields: Json;
          premium_readiness_override: string | null;
          premium_readiness_override_at: string | null;
          premium_readiness_override_by: string | null;
          premium_readiness_override_expires_at: string | null;
          premium_readiness_override_reason: string | null;
          premium_readiness_policy_version: string | null;
          premium_readiness_score: number | null;
          premium_readiness_status: string;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          raw_payload: Json | null;
          raw_text: string | null;
          retention_deadline: string | null;
          retention_deadline_materialized: boolean;
          risk_notes: string | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string;
          sale_procedure: Json;
          sale_venue_type: string;
          sale_verification_status: string;
          score_confidence: number | null;
          score_factors: Json;
          score_version: string | null;
          source_name: string;
          source_url: string;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Insert: {
          address?: string | null;
          adjudication_price_eur?: number | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          catalogue_expiry_deadline?: string | null;
          catalogue_expiry_materialized?: boolean;
          catalogue_quarantined?: boolean;
          catalogue_thumbnail_url?: string | null;
          city?: string | null;
          content_hash?: string | null;
          created_at?: string | null;
          dedupe_confidence?: string | null;
          department?: string | null;
          description?: string | null;
          documents?: Json | null;
          external_id?: string | null;
          first_seen_at?: string | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          last_run_id?: string | null;
          last_seen_at?: string | null;
          latitude?: number | null;
          lawyer_contact?: string | null;
          lawyer_name?: string | null;
          location?: unknown;
          longitude?: number | null;
          observations?: Json | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          premium_readiness_blockers?: Json;
          premium_readiness_evaluated_at?: string | null;
          premium_readiness_factors?: Json;
          premium_readiness_missing_fields?: Json;
          premium_readiness_override?: string | null;
          premium_readiness_override_at?: string | null;
          premium_readiness_override_by?: string | null;
          premium_readiness_override_expires_at?: string | null;
          premium_readiness_override_reason?: string | null;
          premium_readiness_policy_version?: string | null;
          premium_readiness_score?: number | null;
          premium_readiness_status?: string;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          raw_payload?: Json | null;
          raw_text?: string | null;
          retention_deadline?: string | null;
          retention_deadline_materialized?: boolean;
          risk_notes?: string | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          sale_legal_framework?: string;
          sale_procedure?: Json;
          sale_venue_type?: string;
          sale_verification_status?: string;
          score_confidence?: number | null;
          score_factors?: Json;
          score_version?: string | null;
          source_name: string;
          source_url: string;
          source_urls?: Json | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string | null;
          visit_dates?: Json | null;
        };
        Update: {
          address?: string | null;
          adjudication_price_eur?: number | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          catalogue_expiry_deadline?: string | null;
          catalogue_expiry_materialized?: boolean;
          catalogue_quarantined?: boolean;
          catalogue_thumbnail_url?: string | null;
          city?: string | null;
          content_hash?: string | null;
          created_at?: string | null;
          dedupe_confidence?: string | null;
          department?: string | null;
          description?: string | null;
          documents?: Json | null;
          external_id?: string | null;
          first_seen_at?: string | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          last_run_id?: string | null;
          last_seen_at?: string | null;
          latitude?: number | null;
          lawyer_contact?: string | null;
          lawyer_name?: string | null;
          location?: unknown;
          longitude?: number | null;
          observations?: Json | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          premium_readiness_blockers?: Json;
          premium_readiness_evaluated_at?: string | null;
          premium_readiness_factors?: Json;
          premium_readiness_missing_fields?: Json;
          premium_readiness_override?: string | null;
          premium_readiness_override_at?: string | null;
          premium_readiness_override_by?: string | null;
          premium_readiness_override_expires_at?: string | null;
          premium_readiness_override_reason?: string | null;
          premium_readiness_policy_version?: string | null;
          premium_readiness_score?: number | null;
          premium_readiness_status?: string;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          raw_payload?: Json | null;
          raw_text?: string | null;
          retention_deadline?: string | null;
          retention_deadline_materialized?: boolean;
          risk_notes?: string | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          sale_legal_framework?: string;
          sale_procedure?: Json;
          sale_venue_type?: string;
          sale_verification_status?: string;
          score_confidence?: number | null;
          score_factors?: Json;
          score_version?: string | null;
          source_name?: string;
          source_url?: string;
          source_urls?: Json | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string | null;
          visit_dates?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      auction_score_factors: {
        Row: {
          confidence: number | null;
          created_at: string | null;
          delta: number;
          evidence: string | null;
          evidence_refs: Json;
          factor_key: string;
          factor_order: number;
          id: string;
          label: string | null;
          normalized_value: Json | null;
          raw_value: Json | null;
          reason: string | null;
          source_url: string;
          updated_at: string | null;
          weight: number;
        };
        Insert: {
          confidence?: number | null;
          created_at?: string | null;
          delta?: number;
          evidence?: string | null;
          evidence_refs?: Json;
          factor_key: string;
          factor_order?: number;
          id?: string;
          label?: string | null;
          normalized_value?: Json | null;
          raw_value?: Json | null;
          reason?: string | null;
          source_url: string;
          updated_at?: string | null;
          weight?: number;
        };
        Update: {
          confidence?: number | null;
          created_at?: string | null;
          delta?: number;
          evidence?: string | null;
          evidence_refs?: Json;
          factor_key?: string;
          factor_order?: number;
          id?: string;
          label?: string | null;
          normalized_value?: Json | null;
          raw_value?: Json | null;
          reason?: string | null;
          source_url?: string;
          updated_at?: string | null;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "auction_score_factors_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_score_factors_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_score_factors_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_score_factors_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_score_factors_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_score_factors_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_scoring_versions: {
        Row: {
          created_at: string | null;
          notes: string | null;
          version: string;
          weights: Json;
        };
        Insert: {
          created_at?: string | null;
          notes?: string | null;
          version: string;
          weights: Json;
        };
        Update: {
          created_at?: string | null;
          notes?: string | null;
          version?: string;
          weights?: Json;
        };
        Relationships: [];
      };
      auction_source_state: {
        Row: {
          availability: string;
          consecutive_failures: number;
          coverage: Json;
          enabled: boolean;
          last_attempt_at: string | null;
          last_detail_claim_at: string | null;
          last_error: string | null;
          last_inventory_complete_at: string | null;
          last_publication_complete_at: string | null;
          last_run_id: string | null;
          next_inventory_at: string;
          source_name: string;
          suspended_until: string | null;
          suspension_reason: string | null;
          updated_at: string;
        };
        Insert: {
          availability?: string;
          consecutive_failures?: number;
          coverage?: Json;
          enabled?: boolean;
          last_attempt_at?: string | null;
          last_detail_claim_at?: string | null;
          last_error?: string | null;
          last_inventory_complete_at?: string | null;
          last_publication_complete_at?: string | null;
          last_run_id?: string | null;
          next_inventory_at?: string;
          source_name: string;
          suspended_until?: string | null;
          suspension_reason?: string | null;
          updated_at?: string;
        };
        Update: {
          availability?: string;
          consecutive_failures?: number;
          coverage?: Json;
          enabled?: boolean;
          last_attempt_at?: string | null;
          last_detail_claim_at?: string | null;
          last_error?: string | null;
          last_inventory_complete_at?: string | null;
          last_publication_complete_at?: string | null;
          last_run_id?: string | null;
          next_inventory_at?: string;
          source_name?: string;
          suspended_until?: string | null;
          suspension_reason?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_source_state_last_run_id_fkey";
            columns: ["last_run_id"];
            isOneToOne: false;
            referencedRelation: "auction_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_surface_derivations: {
        Row: {
          asset_id: string;
          confidence: number;
          created_at: string;
          derivation_key: string;
          explicit_candidate: Json | null;
          formula: string;
          is_selected: boolean;
          kind: string;
          operand_measurement_keys: Json;
          reasoning_version: string;
          source_url: string;
          updated_at: string;
          validation_status: string;
          value_m2: number;
          warnings: Json;
        };
        Insert: {
          asset_id: string;
          confidence?: number;
          created_at?: string;
          derivation_key: string;
          explicit_candidate?: Json | null;
          formula: string;
          is_selected?: boolean;
          kind: string;
          operand_measurement_keys?: Json;
          reasoning_version: string;
          source_url: string;
          updated_at?: string;
          validation_status: string;
          value_m2: number;
          warnings?: Json;
        };
        Update: {
          asset_id?: string;
          confidence?: number;
          created_at?: string;
          derivation_key?: string;
          explicit_candidate?: Json | null;
          formula?: string;
          is_selected?: boolean;
          kind?: string;
          operand_measurement_keys?: Json;
          reasoning_version?: string;
          source_url?: string;
          updated_at?: string;
          validation_status?: string;
          value_m2?: number;
          warnings?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "auction_surface_derivations_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_derivations_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_derivations_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_derivations_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_derivations_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_derivations_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_surface_measurements: {
        Row: {
          asset_id: string;
          category: string;
          confidence: number;
          created_at: string;
          document_label: string | null;
          document_url: string | null;
          evidence_quote: string;
          extraction_method: string;
          included_in_habitable_sum: boolean | null;
          level_label: string | null;
          lot_label: string | null;
          measurement_key: string;
          page_number: number | null;
          reasoning_version: string;
          source_url: string;
          space_label: string;
          updated_at: string;
          value_m2: number;
        };
        Insert: {
          asset_id: string;
          category: string;
          confidence?: number;
          created_at?: string;
          document_label?: string | null;
          document_url?: string | null;
          evidence_quote: string;
          extraction_method: string;
          included_in_habitable_sum?: boolean | null;
          level_label?: string | null;
          lot_label?: string | null;
          measurement_key: string;
          page_number?: number | null;
          reasoning_version: string;
          source_url: string;
          space_label: string;
          updated_at?: string;
          value_m2: number;
        };
        Update: {
          asset_id?: string;
          category?: string;
          confidence?: number;
          created_at?: string;
          document_label?: string | null;
          document_url?: string | null;
          evidence_quote?: string;
          extraction_method?: string;
          included_in_habitable_sum?: boolean | null;
          level_label?: string | null;
          lot_label?: string | null;
          measurement_key?: string;
          page_number?: number | null;
          reasoning_version?: string;
          source_url?: string;
          space_label?: string;
          updated_at?: string;
          value_m2?: number;
        };
        Relationships: [
          {
            foreignKeyName: "auction_surface_measurements_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_measurements_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_measurements_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_measurements_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_measurements_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surface_measurements_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_surfaces: {
        Row: {
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          habitable_surface_m2: number | null;
          land_surface_m2: number | null;
          parking_count: number | null;
          rooms_count: number | null;
          source_url: string;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          updated_at: string | null;
        };
        Insert: {
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          habitable_surface_m2?: number | null;
          land_surface_m2?: number | null;
          parking_count?: number | null;
          rooms_count?: number | null;
          source_url: string;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          updated_at?: string | null;
        };
        Update: {
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          habitable_surface_m2?: number | null;
          land_surface_m2?: number | null;
          parking_count?: number | null;
          rooms_count?: number | null;
          source_url?: string;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          updated_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_surfaces_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surfaces_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surfaces_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surfaces_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surfaces_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_surfaces_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_urban_planning_signals: {
        Row: {
          action: string | null;
          confidence: number;
          created_at: string;
          detector: string;
          detector_version: string;
          document_label: string | null;
          document_type: string | null;
          document_url: string | null;
          excerpt: string | null;
          id: string;
          label: string;
          page_number: number | null;
          priority: string;
          raw_payload: Json;
          signal_key: string;
          signal_kind: string;
          source_kind: string;
          source_name: string | null;
          source_url: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          action?: string | null;
          confidence?: number;
          created_at?: string;
          detector?: string;
          detector_version?: string;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          label: string;
          page_number?: number | null;
          priority?: string;
          raw_payload?: Json;
          signal_key: string;
          signal_kind: string;
          source_kind?: string;
          source_name?: string | null;
          source_url: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          action?: string | null;
          confidence?: number;
          created_at?: string;
          detector?: string;
          detector_version?: string;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          label?: string;
          page_number?: number | null;
          priority?: string;
          raw_payload?: Json;
          signal_key?: string;
          signal_kind?: string;
          source_kind?: string;
          source_name?: string | null;
          source_url?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_urban_planning_signals_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_urban_planning_signals_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_urban_planning_signals_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_urban_planning_signals_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_urban_planning_signals_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "auction_urban_planning_signals_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      catalogue_court_reconciliation_events: {
        Row: {
          auction_sale_id: string | null;
          bridge_id: string;
          created_at: string;
          id: string;
          insee_code: string | null;
          mapping_method: string;
          new_court_id: string;
          old_court_id: string;
          reference_sha256: string | null;
        };
        Insert: {
          auction_sale_id?: string | null;
          bridge_id: string;
          created_at?: string;
          id?: string;
          insee_code?: string | null;
          mapping_method: string;
          new_court_id: string;
          old_court_id: string;
          reference_sha256?: string | null;
        };
        Update: {
          auction_sale_id?: string | null;
          bridge_id?: string;
          created_at?: string;
          id?: string;
          insee_code?: string | null;
          mapping_method?: string;
          new_court_id?: string;
          old_court_id?: string;
          reference_sha256?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "catalogue_court_reconciliation_events_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_bridge_id_fkey";
            columns: ["bridge_id"];
            isOneToOne: false;
            referencedRelation: "auction_sale_outcome_bridges";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_new_court_id_fkey";
            columns: ["new_court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "catalogue_court_reconciliation_events_old_court_id_fkey";
            columns: ["old_court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      catalogue_readiness_policy: {
        Row: {
          enforcement_enabled: boolean;
          internal_only_max: number;
          minimum_score_confidence: number;
          policy_version: string;
          premium_ready_min: number;
          singleton: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          enforcement_enabled?: boolean;
          internal_only_max?: number;
          minimum_score_confidence?: number;
          policy_version?: string;
          premium_ready_min?: number;
          singleton?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          enforcement_enabled?: boolean;
          internal_only_max?: number;
          minimum_score_confidence?: number;
          policy_version?: string;
          premium_ready_min?: number;
          singleton?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      climate_station_months: {
        Row: {
          frost_days: number | null;
          hot_days: number | null;
          mean_max_temperature_c: number | null;
          mean_min_temperature_c: number | null;
          mean_temperature_c: number | null;
          month: string;
          precipitation_mm: number | null;
          rain_days: number | null;
          station_id: string;
          sunshine_minutes: number | null;
        };
        Insert: {
          frost_days?: number | null;
          hot_days?: number | null;
          mean_max_temperature_c?: number | null;
          mean_min_temperature_c?: number | null;
          mean_temperature_c?: number | null;
          month: string;
          precipitation_mm?: number | null;
          rain_days?: number | null;
          station_id: string;
          sunshine_minutes?: number | null;
        };
        Update: {
          frost_days?: number | null;
          hot_days?: number | null;
          mean_max_temperature_c?: number | null;
          mean_min_temperature_c?: number | null;
          mean_temperature_c?: number | null;
          month?: string;
          precipitation_mm?: number | null;
          rain_days?: number | null;
          station_id?: string;
          sunshine_minutes?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "climate_station_months_station_id_fkey";
            columns: ["station_id"];
            isOneToOne: false;
            referencedRelation: "climate_stations";
            referencedColumns: ["station_id"];
          },
        ];
      };
      climate_stations: {
        Row: {
          altitude_m: number | null;
          department_code: string;
          first_month: string;
          has_precipitation: boolean;
          has_sunshine: boolean;
          has_temperature: boolean;
          imported_at: string;
          last_month: string;
          latitude: number;
          longitude: number;
          name: string;
          source_url: string;
          station_id: string;
        };
        Insert: {
          altitude_m?: number | null;
          department_code: string;
          first_month: string;
          has_precipitation?: boolean;
          has_sunshine?: boolean;
          has_temperature?: boolean;
          imported_at?: string;
          last_month: string;
          latitude: number;
          longitude: number;
          name: string;
          source_url: string;
          station_id: string;
        };
        Update: {
          altitude_m?: number | null;
          department_code?: string;
          first_month?: string;
          has_precipitation?: boolean;
          has_sunshine?: boolean;
          has_temperature?: boolean;
          imported_at?: string;
          last_month?: string;
          latitude?: number;
          longitude?: number;
          name?: string;
          source_url?: string;
          station_id?: string;
        };
        Relationships: [];
      };
      cnb_lawyer_directory: {
        Row: {
          address_line_1: string | null;
          address_line_2: string | null;
          bar_association: string;
          bar_key: string;
          city: string | null;
          display_name: string;
          firm_name: string | null;
          firm_siret_siren: string | null;
          first_name: string | null;
          imported_at: string;
          languages: string[];
          last_name: string;
          oath_date: string | null;
          postal_code: string | null;
          source_key: string;
          source_resource_id: string;
          source_updated_at: string;
          specializations: string[];
        };
        Insert: {
          address_line_1?: string | null;
          address_line_2?: string | null;
          bar_association: string;
          bar_key: string;
          city?: string | null;
          display_name: string;
          firm_name?: string | null;
          firm_siret_siren?: string | null;
          first_name?: string | null;
          imported_at?: string;
          languages?: string[];
          last_name: string;
          oath_date?: string | null;
          postal_code?: string | null;
          source_key: string;
          source_resource_id: string;
          source_updated_at: string;
          specializations: string[];
        };
        Update: {
          address_line_1?: string | null;
          address_line_2?: string | null;
          bar_association?: string;
          bar_key?: string;
          city?: string | null;
          display_name?: string;
          firm_name?: string | null;
          firm_siret_siren?: string | null;
          first_name?: string | null;
          imported_at?: string;
          languages?: string[];
          last_name?: string;
          oath_date?: string | null;
          postal_code?: string | null;
          source_key?: string;
          source_resource_id?: string;
          source_updated_at?: string;
          specializations?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "cnb_lawyer_directory_source_resource_id_fkey";
            columns: ["source_resource_id"];
            isOneToOne: false;
            referencedRelation: "cnb_lawyer_directory_imports";
            referencedColumns: ["resource_id"];
          },
        ];
      };
      cnb_lawyer_directory_imports: {
        Row: {
          completed_at: string | null;
          error_message: string | null;
          record_count: number;
          resource_id: string;
          resource_title: string;
          resource_url: string;
          source_published_at: string;
          started_at: string;
          status: string;
        };
        Insert: {
          completed_at?: string | null;
          error_message?: string | null;
          record_count?: number;
          resource_id: string;
          resource_title: string;
          resource_url: string;
          source_published_at: string;
          started_at?: string;
          status: string;
        };
        Update: {
          completed_at?: string | null;
          error_message?: string | null;
          record_count?: number;
          resource_id?: string;
          resource_title?: string;
          resource_url?: string;
          source_published_at?: string;
          started_at?: string;
          status?: string;
        };
        Relationships: [];
      };
      cohort_definitions: {
        Row: {
          active: boolean;
          cohort_key: string;
          cohort_level: string;
          created_at: string;
          definition_version: number;
          filters: Json;
          id: string;
          label: string;
        };
        Insert: {
          active?: boolean;
          cohort_key: string;
          cohort_level: string;
          created_at?: string;
          definition_version: number;
          filters?: Json;
          id?: string;
          label: string;
        };
        Update: {
          active?: boolean;
          cohort_key?: string;
          cohort_level?: string;
          created_at?: string;
          definition_version?: number;
          filters?: Json;
          id?: string;
          label?: string;
        };
        Relationships: [];
      };
      cohort_statistics: {
        Row: {
          cohort_definition_id: string;
          created_at: string;
          delay_probabilities: Json;
          final_price_ratios: Json;
          flow_probabilities: Json;
          has_blocking_conflict: boolean;
          id: string;
          initial_price_ratios: Json;
          period_end: string;
          period_start: string;
          prediction_horizon: string;
          pressure_components: Json;
          sample_size: number;
          statistics_hash: string;
          surenchere_probability: number | null;
          training_eligible: boolean;
          tribunal_sample_size: number;
        };
        Insert: {
          cohort_definition_id: string;
          created_at?: string;
          delay_probabilities?: Json;
          final_price_ratios?: Json;
          flow_probabilities?: Json;
          has_blocking_conflict?: boolean;
          id?: string;
          initial_price_ratios?: Json;
          period_end: string;
          period_start: string;
          prediction_horizon: string;
          pressure_components?: Json;
          sample_size: number;
          statistics_hash: string;
          surenchere_probability?: number | null;
          training_eligible?: boolean;
          tribunal_sample_size?: number;
        };
        Update: {
          cohort_definition_id?: string;
          created_at?: string;
          delay_probabilities?: Json;
          final_price_ratios?: Json;
          flow_probabilities?: Json;
          has_blocking_conflict?: boolean;
          id?: string;
          initial_price_ratios?: Json;
          period_end?: string;
          period_start?: string;
          prediction_horizon?: string;
          pressure_components?: Json;
          sample_size?: number;
          statistics_hash?: string;
          surenchere_probability?: number | null;
          training_eligible?: boolean;
          tribunal_sample_size?: number;
        };
        Relationships: [
          {
            foreignKeyName: "cohort_statistics_cohort_definition_id_fkey";
            columns: ["cohort_definition_id"];
            isOneToOne: false;
            referencedRelation: "cohort_definitions";
            referencedColumns: ["id"];
          },
        ];
      };
      commercial_acceptances: {
        Row: {
          accepted_at: string;
          amount_cents: number | null;
          archived_until: string;
          checkout_created_at: string | null;
          checkout_session_id: string | null;
          currency: string;
          evidence: Json;
          id: string;
          immediate_performance_requested: boolean;
          offer_code: string;
          payment_obligation_acknowledged: boolean;
          privacy_sha256: string;
          privacy_version: string;
          purpose: string;
          request_id: string | null;
          requester_email_hash: string | null;
          terms_accepted: boolean;
          terms_sha256: string;
          terms_version: string;
          user_agent_hash: string | null;
          user_id: string | null;
          withdrawal_information_acknowledged: boolean;
        };
        Insert: {
          accepted_at?: string;
          amount_cents?: number | null;
          archived_until?: string;
          checkout_created_at?: string | null;
          checkout_session_id?: string | null;
          currency: string;
          evidence?: Json;
          id?: string;
          immediate_performance_requested: boolean;
          offer_code: string;
          payment_obligation_acknowledged: boolean;
          privacy_sha256: string;
          privacy_version: string;
          purpose?: string;
          request_id?: string | null;
          requester_email_hash?: string | null;
          terms_accepted: boolean;
          terms_sha256: string;
          terms_version: string;
          user_agent_hash?: string | null;
          user_id?: string | null;
          withdrawal_information_acknowledged: boolean;
        };
        Update: {
          accepted_at?: string;
          amount_cents?: number | null;
          archived_until?: string;
          checkout_created_at?: string | null;
          checkout_session_id?: string | null;
          currency?: string;
          evidence?: Json;
          id?: string;
          immediate_performance_requested?: boolean;
          offer_code?: string;
          payment_obligation_acknowledged?: boolean;
          privacy_sha256?: string;
          privacy_version?: string;
          purpose?: string;
          request_id?: string | null;
          requester_email_hash?: string | null;
          terms_accepted?: boolean;
          terms_sha256?: string;
          terms_version?: string;
          user_agent_hash?: string | null;
          user_id?: string | null;
          withdrawal_information_acknowledged?: boolean;
        };
        Relationships: [];
      };
      commercial_confirmation_deliveries: {
        Row: {
          acceptance_id: string;
          attempt_count: number;
          checkout_session_id: string;
          created_at: string;
          error_message: string | null;
          id: string;
          paid_at: string;
          provider_message_id: string | null;
          recipient_hash: string | null;
          sent_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          acceptance_id: string;
          attempt_count?: number;
          checkout_session_id: string;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          paid_at: string;
          provider_message_id?: string | null;
          recipient_hash?: string | null;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          acceptance_id?: string;
          attempt_count?: number;
          checkout_session_id?: string;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          paid_at?: string;
          provider_message_id?: string | null;
          recipient_hash?: string | null;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commercial_confirmation_deliveries_acceptance_id_fkey";
            columns: ["acceptance_id"];
            isOneToOne: true;
            referencedRelation: "commercial_acceptances";
            referencedColumns: ["id"];
          },
        ];
      };
      commune_risk_profiles: {
        Row: {
          catnat_by_type: Json;
          catnat_recent: Json;
          catnat_total: number;
          code_insee: string;
          commune_name: string;
          gaspar_snapshot: string | null;
          imported_at: string;
          prevention_plans: Json;
          radon_class: number | null;
          risks: Json;
          seismic_zone: number | null;
          source_url: string;
          zoning_checked_at: string | null;
        };
        Insert: {
          catnat_by_type?: Json;
          catnat_recent?: Json;
          catnat_total?: number;
          code_insee: string;
          commune_name: string;
          gaspar_snapshot?: string | null;
          imported_at?: string;
          prevention_plans?: Json;
          radon_class?: number | null;
          risks?: Json;
          seismic_zone?: number | null;
          source_url: string;
          zoning_checked_at?: string | null;
        };
        Update: {
          catnat_by_type?: Json;
          catnat_recent?: Json;
          catnat_total?: number;
          code_insee?: string;
          commune_name?: string;
          gaspar_snapshot?: string | null;
          imported_at?: string;
          prevention_plans?: Json;
          radon_class?: number | null;
          risks?: Json;
          seismic_zone?: number | null;
          source_url?: string;
          zoning_checked_at?: string | null;
        };
        Relationships: [];
      };
      data_refresh_requests: {
        Row: {
          completed_at: string | null;
          created_at: string;
          error_message: string | null;
          id: string;
          priority: number;
          request_kind: string;
          requested_payload: Json;
          result_summary: Json;
          sale_id: string;
          source_url: string;
          started_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          priority?: number;
          request_kind: string;
          requested_payload?: Json;
          result_summary?: Json;
          sale_id: string;
          source_url: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          priority?: number;
          request_kind?: string;
          requested_payload?: Json;
          result_summary?: Json;
          sale_id?: string;
          source_url?: string;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "data_refresh_requests_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "data_refresh_requests_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "data_refresh_requests_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "data_refresh_requests_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "data_refresh_requests_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      data_sources: {
        Row: {
          active: boolean;
          base_url: string | null;
          created_at: string;
          id: string;
          ingestion_policy: string;
          legal_review_status: string;
          license: string | null;
          name: string;
          official: boolean;
          personal_data_possible: boolean;
          publisher: string | null;
          rate_limit: Json;
          terms_url: string | null;
          terms_version: string | null;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          base_url?: string | null;
          created_at?: string;
          id?: string;
          ingestion_policy?: string;
          legal_review_status?: string;
          license?: string | null;
          name: string;
          official?: boolean;
          personal_data_possible?: boolean;
          publisher?: string | null;
          rate_limit?: Json;
          terms_url?: string | null;
          terms_version?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          base_url?: string | null;
          created_at?: string;
          id?: string;
          ingestion_policy?: string;
          legal_review_status?: string;
          license?: string | null;
          name?: string;
          official?: boolean;
          personal_data_possible?: boolean;
          publisher?: string | null;
          rate_limit?: Json;
          terms_url?: string | null;
          terms_version?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      data_subject_requests: {
        Row: {
          acknowledged_at: string;
          completed_at: string | null;
          due_at: string;
          id: string;
          identity_status: string;
          message: string | null;
          metadata: Json;
          operator_notes: string | null;
          request_type: string;
          requester_email: string;
          resolution_code: string | null;
          status: string;
          submitted_at: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          acknowledged_at?: string;
          completed_at?: string | null;
          due_at?: string;
          id?: string;
          identity_status?: string;
          message?: string | null;
          metadata?: Json;
          operator_notes?: string | null;
          request_type: string;
          requester_email: string;
          resolution_code?: string | null;
          status?: string;
          submitted_at?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          acknowledged_at?: string;
          completed_at?: string | null;
          due_at?: string;
          id?: string;
          identity_status?: string;
          message?: string | null;
          metadata?: Json;
          operator_notes?: string | null;
          request_type?: string;
          requester_email?: string;
          resolution_code?: string | null;
          status?: string;
          submitted_at?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      dvf_import_batches: {
        Row: {
          completed_at: string | null;
          created_at: string;
          error_message: string | null;
          file_name: string | null;
          id: string;
          imported_rows: number;
          metadata: Json;
          period_end: string | null;
          period_start: string | null;
          source: string;
          source_url: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          file_name?: string | null;
          id?: string;
          imported_rows?: number;
          metadata?: Json;
          period_end?: string | null;
          period_start?: string | null;
          source?: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          file_name?: string | null;
          id?: string;
          imported_rows?: number;
          metadata?: Json;
          period_end?: string | null;
          period_start?: string | null;
          source?: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      dvf_market_statistics: {
        Row: {
          geography_code: string;
          geography_label: string;
          geography_level: string;
          imported_at: string;
          mean_price_per_m2: number | null;
          median_price_per_m2: number | null;
          parent_code: string | null;
          sales_count: number;
          segment: string;
          source_updated_at: string | null;
          source_url: string;
        };
        Insert: {
          geography_code: string;
          geography_label: string;
          geography_level: string;
          imported_at?: string;
          mean_price_per_m2?: number | null;
          median_price_per_m2?: number | null;
          parent_code?: string | null;
          sales_count: number;
          segment: string;
          source_updated_at?: string | null;
          source_url: string;
        };
        Update: {
          geography_code?: string;
          geography_label?: string;
          geography_level?: string;
          imported_at?: string;
          mean_price_per_m2?: number | null;
          median_price_per_m2?: number | null;
          parent_code?: string | null;
          sales_count?: number;
          segment?: string;
          source_updated_at?: string | null;
          source_url?: string;
        };
        Relationships: [];
      };
      dvf_transactions: {
        Row: {
          address: string | null;
          built_surface_m2: number | null;
          city: string | null;
          department: string | null;
          dvf_property_type_code: string | null;
          id: string;
          import_batch_id: string | null;
          insee_code: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          longitude: number | null;
          lots_count: number | null;
          mutation_nature: string | null;
          parcel_id: string | null;
          postal_code: string | null;
          price_per_m2: number | null;
          property_type: string | null;
          rooms_count: number | null;
          sale_date: string;
          source: string;
          source_mutation_id: string;
          total_price_eur: number;
        };
        Insert: {
          address?: string | null;
          built_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          dvf_property_type_code?: string | null;
          id?: string;
          import_batch_id?: string | null;
          insee_code?: string | null;
          land_surface_m2?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          lots_count?: number | null;
          mutation_nature?: string | null;
          parcel_id?: string | null;
          postal_code?: string | null;
          price_per_m2?: number | null;
          property_type?: string | null;
          rooms_count?: number | null;
          sale_date: string;
          source?: string;
          source_mutation_id: string;
          total_price_eur: number;
        };
        Update: {
          address?: string | null;
          built_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          dvf_property_type_code?: string | null;
          id?: string;
          import_batch_id?: string | null;
          insee_code?: string | null;
          land_surface_m2?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          lots_count?: number | null;
          mutation_nature?: string | null;
          parcel_id?: string | null;
          postal_code?: string | null;
          price_per_m2?: number | null;
          property_type?: string | null;
          rooms_count?: number | null;
          sale_date?: string;
          source?: string;
          source_mutation_id?: string;
          total_price_eur?: number;
        };
        Relationships: [
          {
            foreignKeyName: "dvf_transactions_import_batch_id_fkey";
            columns: ["import_batch_id"];
            isOneToOne: false;
            referencedRelation: "dvf_import_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      evidence_reviews: {
        Row: {
          decision: string;
          evidence_id: string;
          field_decisions: Json;
          id: string;
          independent_review: boolean;
          notes: string | null;
          recorded_at: string;
          review_type: string;
          reviewed_at: string;
          reviewer_user_id: string;
        };
        Insert: {
          decision: string;
          evidence_id: string;
          field_decisions?: Json;
          id?: string;
          independent_review?: boolean;
          notes?: string | null;
          recorded_at?: string;
          review_type: string;
          reviewed_at?: string;
          reviewer_user_id: string;
        };
        Update: {
          decision?: string;
          evidence_id?: string;
          field_decisions?: Json;
          id?: string;
          independent_review?: boolean;
          notes?: string | null;
          recorded_at?: string;
          review_type?: string;
          reviewed_at?: string;
          reviewer_user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "evidence_reviews_evidence_id_fkey";
            columns: ["evidence_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcome_evidence";
            referencedColumns: ["id"];
          },
        ];
      };
      feature_usage_events: {
        Row: {
          created_at: string;
          event_key: string;
          id: string;
          metadata: Json;
          quantity: number;
          subject_id: string | null;
          subject_type: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          event_key: string;
          id?: string;
          metadata?: Json;
          quantity?: number;
          subject_id?: string | null;
          subject_type?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          event_key?: string;
          id?: string;
          metadata?: Json;
          quantity?: number;
          subject_id?: string | null;
          subject_type?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      information_agent_case_subscribers: {
        Row: {
          case_id: string;
          is_initiator: boolean;
          last_notified_at: string | null;
          mission_id: string;
          notify_on_reply: boolean;
          requested_question_keys: string[];
          subscribed_at: string;
          user_id: string;
        };
        Insert: {
          case_id: string;
          is_initiator?: boolean;
          last_notified_at?: string | null;
          mission_id: string;
          notify_on_reply?: boolean;
          requested_question_keys?: string[];
          subscribed_at?: string;
          user_id: string;
        };
        Update: {
          case_id?: string;
          is_initiator?: boolean;
          last_notified_at?: string | null;
          mission_id?: string;
          notify_on_reply?: boolean;
          requested_question_keys?: string[];
          subscribed_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_case_subscribers_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_case_subscribers_mission_id_fkey";
            columns: ["mission_id"];
            isOneToOne: true;
            referencedRelation: "information_agent_missions";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_cases: {
        Row: {
          body_text: string;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          failure_reason: string | null;
          id: string;
          inbound_token: string;
          initiator_mission_id: string | null;
          metadata: Json;
          missing_information: string[];
          normalized_recipient_email: string;
          provider_message_id: string | null;
          question_keys: string[];
          recipient_email: string;
          recipient_kind: string;
          recipient_name: string | null;
          replied_at: string | null;
          sale_id: string;
          sent_at: string | null;
          status: string;
          subject: string;
          updated_at: string;
        };
        Insert: {
          body_text: string;
          completed_at?: string | null;
          created_at?: string;
          created_by: string;
          failure_reason?: string | null;
          id?: string;
          inbound_token?: string;
          initiator_mission_id?: string | null;
          metadata?: Json;
          missing_information?: string[];
          normalized_recipient_email: string;
          provider_message_id?: string | null;
          question_keys?: string[];
          recipient_email: string;
          recipient_kind?: string;
          recipient_name?: string | null;
          replied_at?: string | null;
          sale_id: string;
          sent_at?: string | null;
          status?: string;
          subject: string;
          updated_at?: string;
        };
        Update: {
          body_text?: string;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string;
          failure_reason?: string | null;
          id?: string;
          inbound_token?: string;
          initiator_mission_id?: string | null;
          metadata?: Json;
          missing_information?: string[];
          normalized_recipient_email?: string;
          provider_message_id?: string | null;
          question_keys?: string[];
          recipient_email?: string;
          recipient_kind?: string;
          recipient_name?: string | null;
          replied_at?: string | null;
          sale_id?: string;
          sent_at?: string | null;
          status?: string;
          subject?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_cases_initiator_mission_id_fkey";
            columns: ["initiator_mission_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_missions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_cases_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_cases_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_cases_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_cases_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_cases_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_cases_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_cases_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_contacts: {
        Row: {
          bounce_status: string;
          bounced_at: string | null;
          created_at: string;
          display_name: string | null;
          email: string;
          id: string;
          last_seen_at: string | null;
          last_verified_at: string | null;
          metadata: Json;
          normalized_email: string | null;
          opposed_at: string | null;
          opposition_status: string;
          provenance: Json;
          role: string;
          sale_id: string | null;
          scope_sale_id: string | null;
          source_name: string | null;
          source_url: string | null;
          updated_at: string;
          verification_status: string;
        };
        Insert: {
          bounce_status?: string;
          bounced_at?: string | null;
          created_at?: string;
          display_name?: string | null;
          email: string;
          id?: string;
          last_seen_at?: string | null;
          last_verified_at?: string | null;
          metadata?: Json;
          normalized_email?: string | null;
          opposed_at?: string | null;
          opposition_status?: string;
          provenance?: Json;
          role?: string;
          sale_id?: string | null;
          scope_sale_id?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          updated_at?: string;
          verification_status?: string;
        };
        Update: {
          bounce_status?: string;
          bounced_at?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string;
          id?: string;
          last_seen_at?: string | null;
          last_verified_at?: string | null;
          metadata?: Json;
          normalized_email?: string | null;
          opposed_at?: string | null;
          opposition_status?: string;
          provenance?: Json;
          role?: string;
          sale_id?: string | null;
          scope_sale_id?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          updated_at?: string;
          verification_status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_contacts_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_contacts_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_contacts_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_contacts_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_contacts_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_contacts_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_contacts_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_email_templates: {
        Row: {
          blocks: Json;
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          status: string;
          subject_template: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          blocks: Json;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          status?: string;
          subject_template: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          blocks?: Json;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          status?: string;
          subject_template?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      information_agent_evidence_assets: {
        Row: {
          case_id: string;
          created_at: string;
          id: string;
          message_id: string;
          metadata: Json;
          mime_type: string;
          original_filename: string;
          provider_attachment_id: string | null;
          review_status: string;
          rights_status: string;
          sale_id: string;
          sha256: string;
          size_bytes: number;
          storage_bucket: string;
          storage_path: string;
        };
        Insert: {
          case_id: string;
          created_at?: string;
          id?: string;
          message_id: string;
          metadata?: Json;
          mime_type: string;
          original_filename: string;
          provider_attachment_id?: string | null;
          review_status?: string;
          rights_status?: string;
          sale_id: string;
          sha256: string;
          size_bytes: number;
          storage_bucket?: string;
          storage_path: string;
        };
        Update: {
          case_id?: string;
          created_at?: string;
          id?: string;
          message_id?: string;
          metadata?: Json;
          mime_type?: string;
          original_filename?: string;
          provider_attachment_id?: string | null;
          review_status?: string;
          rights_status?: string;
          sale_id?: string;
          sha256?: string;
          size_bytes?: number;
          storage_bucket?: string;
          storage_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_evidence_assets_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_assets_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_evidence_extractions: {
        Row: {
          asset_id: string;
          attempts: number;
          available_at: string;
          case_id: string;
          completed_at: string | null;
          created_at: string;
          detected_mime_type: string | null;
          document_kind: string | null;
          error_code: string | null;
          error_message: string | null;
          extracted_facts: Json;
          extracted_text: string | null;
          id: string;
          is_encrypted: boolean;
          locked_at: string | null;
          message_id: string;
          metadata: Json;
          page_count: number | null;
          pages: Json;
          processor: string;
          processor_version: string;
          sale_id: string;
          started_at: string | null;
          status: string;
          summary: string | null;
          updated_at: string;
        };
        Insert: {
          asset_id: string;
          attempts?: number;
          available_at?: string;
          case_id: string;
          completed_at?: string | null;
          created_at?: string;
          detected_mime_type?: string | null;
          document_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          extracted_facts?: Json;
          extracted_text?: string | null;
          id?: string;
          is_encrypted?: boolean;
          locked_at?: string | null;
          message_id: string;
          metadata?: Json;
          page_count?: number | null;
          pages?: Json;
          processor?: string;
          processor_version?: string;
          sale_id: string;
          started_at?: string | null;
          status?: string;
          summary?: string | null;
          updated_at?: string;
        };
        Update: {
          asset_id?: string;
          attempts?: number;
          available_at?: string;
          case_id?: string;
          completed_at?: string | null;
          created_at?: string;
          detected_mime_type?: string | null;
          document_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          extracted_facts?: Json;
          extracted_text?: string | null;
          id?: string;
          is_encrypted?: boolean;
          locked_at?: string | null;
          message_id?: string;
          metadata?: Json;
          page_count?: number | null;
          pages?: Json;
          processor?: string;
          processor_version?: string;
          sale_id?: string;
          started_at?: string | null;
          status?: string;
          summary?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_evidence_extractions_asset_id_fkey";
            columns: ["asset_id"];
            isOneToOne: true;
            referencedRelation: "information_agent_evidence_assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_evidence_extractions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_fact_candidates: {
        Row: {
          case_id: string;
          confidence: number;
          created_at: string;
          display_value: string;
          evidence_asset_id: string | null;
          evidence_excerpt: string | null;
          extraction_method: string;
          fact_key: string;
          id: string;
          message_id: string;
          metadata: Json;
          proposed_value: Json;
          review_notes: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          sale_id: string;
          source_locator: string | null;
          source_page: number | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          case_id: string;
          confidence: number;
          created_at?: string;
          display_value: string;
          evidence_asset_id?: string | null;
          evidence_excerpt?: string | null;
          extraction_method?: string;
          fact_key: string;
          id?: string;
          message_id: string;
          metadata?: Json;
          proposed_value: Json;
          review_notes?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          sale_id: string;
          source_locator?: string | null;
          source_page?: number | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          case_id?: string;
          confidence?: number;
          created_at?: string;
          display_value?: string;
          evidence_asset_id?: string | null;
          evidence_excerpt?: string | null;
          extraction_method?: string;
          fact_key?: string;
          id?: string;
          message_id?: string;
          metadata?: Json;
          proposed_value?: Json;
          review_notes?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          sale_id?: string;
          source_locator?: string | null;
          source_page?: number | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_fact_candidates_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_evidence_asset_id_fkey";
            columns: ["evidence_asset_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_evidence_assets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_fact_candidates_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_inbound_jobs: {
        Row: {
          attachment_link_expires_at: string;
          attempts: number;
          available_at: string;
          case_id: string;
          created_at: string;
          id: string;
          last_error: string | null;
          lease_id: string | null;
          locked_at: string | null;
          message_id: string;
          provider_email_id: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          attachment_link_expires_at: string;
          attempts?: number;
          available_at?: string;
          case_id: string;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          lease_id?: string | null;
          locked_at?: string | null;
          message_id: string;
          provider_email_id: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          attachment_link_expires_at?: string;
          attempts?: number;
          available_at?: string;
          case_id?: string;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          lease_id?: string | null;
          locked_at?: string | null;
          message_id?: string;
          provider_email_id?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_inbound_jobs_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_inbound_jobs_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: true;
            referencedRelation: "information_agent_messages";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_messages: {
        Row: {
          attachments: Json;
          body_text: string;
          case_id: string | null;
          created_at: string;
          delivery_status: string;
          direction: string;
          from_email: string | null;
          id: string;
          message_kind: string;
          metadata: Json;
          mission_id: string;
          provider_message_id: string | null;
          received_at: string | null;
          sent_at: string | null;
          subject: string;
          to_email: string | null;
          user_id: string;
        };
        Insert: {
          attachments?: Json;
          body_text: string;
          case_id?: string | null;
          created_at?: string;
          delivery_status: string;
          direction: string;
          from_email?: string | null;
          id?: string;
          message_kind: string;
          metadata?: Json;
          mission_id: string;
          provider_message_id?: string | null;
          received_at?: string | null;
          sent_at?: string | null;
          subject: string;
          to_email?: string | null;
          user_id: string;
        };
        Update: {
          attachments?: Json;
          body_text?: string;
          case_id?: string | null;
          created_at?: string;
          delivery_status?: string;
          direction?: string;
          from_email?: string | null;
          id?: string;
          message_kind?: string;
          metadata?: Json;
          mission_id?: string;
          provider_message_id?: string | null;
          received_at?: string | null;
          sent_at?: string | null;
          subject?: string;
          to_email?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_messages_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_messages_mission_id_fkey";
            columns: ["mission_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_missions";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_missions: {
        Row: {
          ai_disclosure_version: string;
          approved_at: string | null;
          approved_message_sha256: string | null;
          body_text: string;
          case_id: string | null;
          completed_at: string | null;
          contribution_token_version: number;
          created_at: string;
          failure_reason: string | null;
          followup_count: number;
          id: string;
          last_followup_at: string | null;
          metadata: Json;
          missing_information: string[];
          privacy_version: string;
          provider_message_id: string | null;
          question_keys: string[];
          recipient_email: string;
          recipient_kind: string;
          recipient_name: string | null;
          replied_at: string | null;
          reply_to_email: string | null;
          sale_id: string | null;
          sale_snapshot: Json;
          sent_at: string | null;
          share_requester_email: boolean;
          status: string;
          subject: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          ai_disclosure_version?: string;
          approved_at?: string | null;
          approved_message_sha256?: string | null;
          body_text: string;
          case_id?: string | null;
          completed_at?: string | null;
          contribution_token_version?: number;
          created_at?: string;
          failure_reason?: string | null;
          followup_count?: number;
          id?: string;
          last_followup_at?: string | null;
          metadata?: Json;
          missing_information?: string[];
          privacy_version: string;
          provider_message_id?: string | null;
          question_keys?: string[];
          recipient_email: string;
          recipient_kind?: string;
          recipient_name?: string | null;
          replied_at?: string | null;
          reply_to_email?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          share_requester_email?: boolean;
          status?: string;
          subject: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          ai_disclosure_version?: string;
          approved_at?: string | null;
          approved_message_sha256?: string | null;
          body_text?: string;
          case_id?: string | null;
          completed_at?: string | null;
          contribution_token_version?: number;
          created_at?: string;
          failure_reason?: string | null;
          followup_count?: number;
          id?: string;
          last_followup_at?: string | null;
          metadata?: Json;
          missing_information?: string[];
          privacy_version?: string;
          provider_message_id?: string | null;
          question_keys?: string[];
          recipient_email?: string;
          recipient_kind?: string;
          recipient_name?: string | null;
          replied_at?: string | null;
          reply_to_email?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          share_requester_email?: boolean;
          status?: string;
          subject?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_missions_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_portal_upload_reservations: {
        Row: {
          case_id: string;
          consumed_at: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          requested_size_bytes: number;
          size_bytes: number;
          status: string;
          storage_path: string;
        };
        Insert: {
          case_id: string;
          consumed_at?: string | null;
          created_at?: string;
          expires_at: string;
          id?: string;
          requested_size_bytes: number;
          size_bytes: number;
          status?: string;
          storage_path: string;
        };
        Update: {
          case_id?: string;
          consumed_at?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          requested_size_bytes?: number;
          size_bytes?: number;
          status?: string;
          storage_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_portal_upload_reservations_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_cases";
            referencedColumns: ["id"];
          },
        ];
      };
      ingestion_jobs: {
        Row: {
          attempts: number;
          available_at: string;
          completed_at: string | null;
          created_at: string;
          dead_lettered_at: string | null;
          id: string;
          idempotency_key: string;
          job_kind: string;
          last_error_class: string | null;
          last_error_code: string | null;
          lease_expires_at: string | null;
          lease_owner: string | null;
          lease_token: string | null;
          leased_at: string | null;
          max_attempts: number;
          payload: Json;
          priority: number;
          sanitized_error_message: string | null;
          source_id: string;
          status: string;
          stream_key: string;
          updated_at: string;
        };
        Insert: {
          attempts?: number;
          available_at?: string;
          completed_at?: string | null;
          created_at?: string;
          dead_lettered_at?: string | null;
          id?: string;
          idempotency_key: string;
          job_kind: string;
          last_error_class?: string | null;
          last_error_code?: string | null;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          lease_token?: string | null;
          leased_at?: string | null;
          max_attempts?: number;
          payload?: Json;
          priority?: number;
          sanitized_error_message?: string | null;
          source_id: string;
          status?: string;
          stream_key?: string;
          updated_at?: string;
        };
        Update: {
          attempts?: number;
          available_at?: string;
          completed_at?: string | null;
          created_at?: string;
          dead_lettered_at?: string | null;
          id?: string;
          idempotency_key?: string;
          job_kind?: string;
          last_error_class?: string | null;
          last_error_code?: string | null;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          lease_token?: string | null;
          leased_at?: string | null;
          max_attempts?: number;
          payload?: Json;
          priority?: number;
          sanitized_error_message?: string | null;
          source_id?: string;
          status?: string;
          stream_key?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "ingestion_jobs_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      judicial_sales: {
        Row: {
          adjudication_price_eur: number | null;
          content_hash: string | null;
          created_at: string;
          documents_count: number;
          external_id: string | null;
          first_seen_at: string;
          id: string;
          investment_score: number | null;
          investment_summary: string | null;
          last_run_id: string | null;
          last_seen_at: string;
          primary_source: string | null;
          property_source_url: string;
          quality_flags: Json;
          raw_payload: Json;
          sale_date: string | null;
          score_confidence: number | null;
          score_factors: Json;
          score_version: string | null;
          source_lawyer_contact: string | null;
          source_lawyer_name: string | null;
          source_name: string;
          source_url: string;
          source_urls: Json;
          starting_price_eur: number | null;
          status: string;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string;
          visit_dates: Json;
        };
        Insert: {
          adjudication_price_eur?: number | null;
          content_hash?: string | null;
          created_at?: string;
          documents_count?: number;
          external_id?: string | null;
          first_seen_at?: string;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          last_run_id?: string | null;
          last_seen_at?: string;
          primary_source?: string | null;
          property_source_url: string;
          quality_flags?: Json;
          raw_payload?: Json;
          sale_date?: string | null;
          score_confidence?: number | null;
          score_factors?: Json;
          score_version?: string | null;
          source_lawyer_contact?: string | null;
          source_lawyer_name?: string | null;
          source_name: string;
          source_url: string;
          source_urls?: Json;
          starting_price_eur?: number | null;
          status?: string;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string;
          visit_dates?: Json;
        };
        Update: {
          adjudication_price_eur?: number | null;
          content_hash?: string | null;
          created_at?: string;
          documents_count?: number;
          external_id?: string | null;
          first_seen_at?: string;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          last_run_id?: string | null;
          last_seen_at?: string;
          primary_source?: string | null;
          property_source_url?: string;
          quality_flags?: Json;
          raw_payload?: Json;
          sale_date?: string | null;
          score_confidence?: number | null;
          score_factors?: Json;
          score_version?: string | null;
          source_lawyer_contact?: string | null;
          source_lawyer_name?: string | null;
          source_name?: string;
          source_url?: string;
          source_urls?: Json;
          starting_price_eur?: number | null;
          status?: string;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string;
          visit_dates?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "judicial_sales_property_source_url_fkey";
            columns: ["property_source_url"];
            isOneToOne: false;
            referencedRelation: "properties";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      judicial_source_records: {
        Row: {
          artifact_extraction_id: string | null;
          canonical_url: string | null;
          connector_version: string;
          content_hash: string;
          created_at: string;
          decision_date: string | null;
          external_record_id: string;
          id: string;
          normalized_data: Json;
          published_at: string | null;
          raw_artifact_id: string | null;
          record_kind: string;
          record_version: number;
          source_fetch_id: string | null;
          source_id: string;
          source_updated_at: string | null;
          supersedes_record_id: string | null;
          training_eligibility_reason: string;
          training_eligible: boolean;
        };
        Insert: {
          artifact_extraction_id?: string | null;
          canonical_url?: string | null;
          connector_version: string;
          content_hash: string;
          created_at?: string;
          decision_date?: string | null;
          external_record_id: string;
          id?: string;
          normalized_data: Json;
          published_at?: string | null;
          raw_artifact_id?: string | null;
          record_kind: string;
          record_version?: number;
          source_fetch_id?: string | null;
          source_id: string;
          source_updated_at?: string | null;
          supersedes_record_id?: string | null;
          training_eligibility_reason?: string;
          training_eligible?: boolean;
        };
        Update: {
          artifact_extraction_id?: string | null;
          canonical_url?: string | null;
          connector_version?: string;
          content_hash?: string;
          created_at?: string;
          decision_date?: string | null;
          external_record_id?: string;
          id?: string;
          normalized_data?: Json;
          published_at?: string | null;
          raw_artifact_id?: string | null;
          record_kind?: string;
          record_version?: number;
          source_fetch_id?: string | null;
          source_id?: string;
          source_updated_at?: string | null;
          supersedes_record_id?: string | null;
          training_eligibility_reason?: string;
          training_eligible?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "judicial_source_records_artifact_extraction_id_fkey";
            columns: ["artifact_extraction_id"];
            isOneToOne: false;
            referencedRelation: "artifact_extractions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "judicial_source_records_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "judicial_source_records_source_fetch_id_fkey";
            columns: ["source_fetch_id"];
            isOneToOne: false;
            referencedRelation: "source_fetches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "judicial_source_records_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "judicial_source_records_supersedes_record_id_fkey";
            columns: ["supersedes_record_id"];
            isOneToOne: false;
            referencedRelation: "judicial_source_records";
            referencedColumns: ["id"];
          },
        ];
      };
      justice_jurisdiction_activity: {
        Row: {
          activity_year: number;
          canonical_hash: string;
          court_id: string | null;
          created_at: string;
          id: string;
          import_id: string;
          match_details: Json;
          match_status: string;
          new_cases_status: string;
          new_cases_value: number | null;
          source_court_code: string;
          source_court_name: string;
          terminated_cases_status: string;
          terminated_cases_value: number | null;
        };
        Insert: {
          activity_year: number;
          canonical_hash: string;
          court_id?: string | null;
          created_at?: string;
          id?: string;
          import_id: string;
          match_details?: Json;
          match_status: string;
          new_cases_status: string;
          new_cases_value?: number | null;
          source_court_code: string;
          source_court_name: string;
          terminated_cases_status: string;
          terminated_cases_value?: number | null;
        };
        Update: {
          activity_year?: number;
          canonical_hash?: string;
          court_id?: string | null;
          created_at?: string;
          id?: string;
          import_id?: string;
          match_details?: Json;
          match_status?: string;
          new_cases_status?: string;
          new_cases_value?: number | null;
          source_court_code?: string;
          source_court_name?: string;
          terminated_cases_status?: string;
          terminated_cases_value?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "justice_jurisdiction_activity_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "justice_jurisdiction_activity_import_id_fkey";
            columns: ["import_id"];
            isOneToOne: false;
            referencedRelation: "justice_jurisdiction_activity_imports";
            referencedColumns: ["id"];
          },
        ];
      };
      justice_jurisdiction_activity_imports: {
        Row: {
          content_hash: string;
          created_at: string;
          fetched_at: string;
          id: string;
          matched_row_count: number;
          national_new_cases_status: string;
          national_new_cases_value: number | null;
          national_terminated_cases_status: string;
          national_terminated_cases_value: number | null;
          parser_version: string;
          period_end_year: number;
          period_start_year: number;
          source_id: string;
          source_row_count: number;
          source_url: string;
          source_version: string;
          unmatched_row_count: number;
        };
        Insert: {
          content_hash: string;
          created_at?: string;
          fetched_at: string;
          id?: string;
          matched_row_count: number;
          national_new_cases_status: string;
          national_new_cases_value?: number | null;
          national_terminated_cases_status: string;
          national_terminated_cases_value?: number | null;
          parser_version: string;
          period_end_year: number;
          period_start_year: number;
          source_id: string;
          source_row_count: number;
          source_url: string;
          source_version: string;
          unmatched_row_count: number;
        };
        Update: {
          content_hash?: string;
          created_at?: string;
          fetched_at?: string;
          id?: string;
          matched_row_count?: number;
          national_new_cases_status?: string;
          national_new_cases_value?: number | null;
          national_terminated_cases_status?: string;
          national_terminated_cases_value?: number | null;
          parser_version?: string;
          period_end_year?: number;
          period_start_year?: number;
          source_id?: string;
          source_row_count?: number;
          source_url?: string;
          source_version?: string;
          unmatched_row_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "justice_jurisdiction_activity_imports_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      lawyer_placement_events: {
        Row: {
          created_at: string;
          event_type: string;
          id: string;
          lawyer_id: string;
          matching_basis: string | null;
          metadata: Json;
          placement_slot: string;
          sale_id: string | null;
          sector_label: string | null;
        };
        Insert: {
          created_at?: string;
          event_type: string;
          id?: string;
          lawyer_id: string;
          matching_basis?: string | null;
          metadata?: Json;
          placement_slot?: string;
          sale_id?: string | null;
          sector_label?: string | null;
        };
        Update: {
          created_at?: string;
          event_type?: string;
          id?: string;
          lawyer_id?: string;
          matching_basis?: string | null;
          metadata?: Json;
          placement_slot?: string;
          sale_id?: string | null;
          sector_label?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lawyer_placement_events_lawyer_id_fkey";
            columns: ["lawyer_id"];
            isOneToOne: false;
            referencedRelation: "referenced_lawyers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      lawyer_referral_requests: {
        Row: {
          admin_notes: string | null;
          assigned_at: string | null;
          created_at: string;
          financing_ready: boolean | null;
          id: string;
          matching_status: string;
          max_bid_eur: number | null;
          message: string | null;
          metadata: Json;
          phone: string | null;
          preferred_contact_method: string;
          requested_lawyer_id: string | null;
          requester_email: string | null;
          requester_id: string;
          responded_at: string | null;
          sale_id: string | null;
          sale_snapshot: Json;
          sent_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          admin_notes?: string | null;
          assigned_at?: string | null;
          created_at?: string;
          financing_ready?: boolean | null;
          id?: string;
          matching_status?: string;
          max_bid_eur?: number | null;
          message?: string | null;
          metadata?: Json;
          phone?: string | null;
          preferred_contact_method?: string;
          requested_lawyer_id?: string | null;
          requester_email?: string | null;
          requester_id: string;
          responded_at?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          admin_notes?: string | null;
          assigned_at?: string | null;
          created_at?: string;
          financing_ready?: boolean | null;
          id?: string;
          matching_status?: string;
          max_bid_eur?: number | null;
          message?: string | null;
          metadata?: Json;
          phone?: string | null;
          preferred_contact_method?: string;
          requested_lawyer_id?: string | null;
          requester_email?: string | null;
          requester_id?: string;
          responded_at?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lawyer_referral_requests_requested_lawyer_id_fkey";
            columns: ["requested_lawyer_id"];
            isOneToOne: false;
            referencedRelation: "referenced_lawyers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      listing_publication_requests: {
        Row: {
          admin_notes: string | null;
          anonymize_documents: boolean;
          cautions: string | null;
          court: string | null;
          created_at: string;
          description: string | null;
          document_types: string[];
          hearing_date: string | null;
          id: string;
          location: string | null;
          promotion_options: string[];
          published_at: string | null;
          published_sale_id: string | null;
          requester_email: string | null;
          requester_id: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
          starting_price_eur: number | null;
          status: string;
          strengths: string | null;
          submitted_documents: Json;
          title: string;
          updated_at: string;
        };
        Insert: {
          admin_notes?: string | null;
          anonymize_documents?: boolean;
          cautions?: string | null;
          court?: string | null;
          created_at?: string;
          description?: string | null;
          document_types?: string[];
          hearing_date?: string | null;
          id?: string;
          location?: string | null;
          promotion_options?: string[];
          published_at?: string | null;
          published_sale_id?: string | null;
          requester_email?: string | null;
          requester_id: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          starting_price_eur?: number | null;
          status?: string;
          strengths?: string | null;
          submitted_documents?: Json;
          title: string;
          updated_at?: string;
        };
        Update: {
          admin_notes?: string | null;
          anonymize_documents?: boolean;
          cautions?: string | null;
          court?: string | null;
          created_at?: string;
          description?: string | null;
          document_types?: string[];
          hearing_date?: string | null;
          id?: string;
          location?: string | null;
          promotion_options?: string[];
          published_at?: string | null;
          published_sale_id?: string | null;
          requester_email?: string | null;
          requester_id?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          starting_price_eur?: number | null;
          status?: string;
          strengths?: string | null;
          submitted_documents?: Json;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "listing_publication_requests_published_sale_id_fkey";
            columns: ["published_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "listing_publication_requests_published_sale_id_fkey";
            columns: ["published_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "listing_publication_requests_published_sale_id_fkey";
            columns: ["published_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "listing_publication_requests_published_sale_id_fkey";
            columns: ["published_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "listing_publication_requests_published_sale_id_fkey";
            columns: ["published_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "listing_publication_requests_published_sale_id_fkey";
            columns: ["published_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "listing_publication_requests_published_sale_id_fkey";
            columns: ["published_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      llm_analysis_cache: {
        Row: {
          cache_key: string;
          created_at: string;
          model: string;
          result: Json;
          stage: string;
        };
        Insert: {
          cache_key: string;
          created_at?: string;
          model: string;
          result: Json;
          stage: string;
        };
        Update: {
          cache_key?: string;
          created_at?: string;
          model?: string;
          result?: Json;
          stage?: string;
        };
        Relationships: [];
      };
      llm_usage_events: {
        Row: {
          attempt_number: number;
          created_at: string;
          error_message: string | null;
          id: string;
          input_tokens_estimate: number;
          job_id: string | null;
          model: string;
          output_chars: number;
          output_tokens_estimate: number;
          prediction_id: string | null;
          prompt_chars: number;
          provider: string;
          reason: string | null;
          request_key: string | null;
          request_kind: string;
          request_status: string;
          sale_id: string | null;
          source_url: string | null;
          stage: string | null;
          succeeded: boolean;
          system_prompt_chars: number;
        };
        Insert: {
          attempt_number?: number;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          input_tokens_estimate?: number;
          job_id?: string | null;
          model: string;
          output_chars?: number;
          output_tokens_estimate?: number;
          prediction_id?: string | null;
          prompt_chars?: number;
          provider?: string;
          reason?: string | null;
          request_key?: string | null;
          request_kind: string;
          request_status?: string;
          sale_id?: string | null;
          source_url?: string | null;
          stage?: string | null;
          succeeded?: boolean;
          system_prompt_chars?: number;
        };
        Update: {
          attempt_number?: number;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          input_tokens_estimate?: number;
          job_id?: string | null;
          model?: string;
          output_chars?: number;
          output_tokens_estimate?: number;
          prediction_id?: string | null;
          prompt_chars?: number;
          provider?: string;
          reason?: string | null;
          request_key?: string | null;
          request_kind?: string;
          request_status?: string;
          sale_id?: string | null;
          source_url?: string | null;
          stage?: string | null;
          succeeded?: boolean;
          system_prompt_chars?: number;
        };
        Relationships: [];
      };
      meteostat_monthly_cache: {
        Row: {
          cache_key: string;
          expires_at: string | null;
          fetched_at: string | null;
          grid_latitude: number;
          grid_longitude: number;
          last_error: string | null;
          payload: Json | null;
          period_end: string;
          period_start: string;
          retry_after: string | null;
          updated_at: string;
        };
        Insert: {
          cache_key: string;
          expires_at?: string | null;
          fetched_at?: string | null;
          grid_latitude: number;
          grid_longitude: number;
          last_error?: string | null;
          payload?: Json | null;
          period_end: string;
          period_start: string;
          retry_after?: string | null;
          updated_at?: string;
        };
        Update: {
          cache_key?: string;
          expires_at?: string | null;
          fetched_at?: string | null;
          grid_latitude?: number;
          grid_longitude?: number;
          last_error?: string | null;
          payload?: Json | null;
          period_end?: string;
          period_start?: string;
          retry_after?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      model_versions: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          artifact_sha256: string;
          artifact_uri: string | null;
          calibration: Json;
          created_at: string;
          feature_schema_version: string;
          id: string;
          metrics: Json;
          model_key: string;
          model_kind: string;
          segment: string;
          shadow_started_at: string | null;
          status: string;
          training_cutoff_at: string | null;
          training_sample_size: number | null;
          version: string;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          artifact_sha256: string;
          artifact_uri?: string | null;
          calibration: Json;
          created_at?: string;
          feature_schema_version: string;
          id?: string;
          metrics: Json;
          model_key: string;
          model_kind: string;
          segment?: string;
          shadow_started_at?: string | null;
          status?: string;
          training_cutoff_at?: string | null;
          training_sample_size?: number | null;
          version: string;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          artifact_sha256?: string;
          artifact_uri?: string | null;
          calibration?: Json;
          created_at?: string;
          feature_schema_version?: string;
          id?: string;
          metrics?: Json;
          model_key?: string;
          model_kind?: string;
          segment?: string;
          shadow_started_at?: string | null;
          status?: string;
          training_cutoff_at?: string | null;
          training_sample_size?: number | null;
          version?: string;
        };
        Relationships: [];
      };
      operational_alerts: {
        Row: {
          alert_key: string;
          category: string;
          details: Json;
          first_seen_at: string;
          inactive_since: string | null;
          last_seen_at: string;
          notification_attempt_count: number;
          notification_claimed_at: string | null;
          notification_error: string | null;
          notification_event: string;
          notification_next_attempt_at: string;
          notification_status: string;
          notification_version: number;
          notified_at: string | null;
          occurrence_count: number;
          reopened_at: string | null;
          resolved_at: string | null;
          severity: string;
          status: string;
        };
        Insert: {
          alert_key: string;
          category: string;
          details?: Json;
          first_seen_at?: string;
          inactive_since?: string | null;
          last_seen_at?: string;
          notification_attempt_count?: number;
          notification_claimed_at?: string | null;
          notification_error?: string | null;
          notification_event?: string;
          notification_next_attempt_at?: string;
          notification_status?: string;
          notification_version?: number;
          notified_at?: string | null;
          occurrence_count?: number;
          reopened_at?: string | null;
          resolved_at?: string | null;
          severity: string;
          status?: string;
        };
        Update: {
          alert_key?: string;
          category?: string;
          details?: Json;
          first_seen_at?: string;
          inactive_since?: string | null;
          last_seen_at?: string;
          notification_attempt_count?: number;
          notification_claimed_at?: string | null;
          notification_error?: string | null;
          notification_event?: string;
          notification_next_attempt_at?: string;
          notification_status?: string;
          notification_version?: number;
          notified_at?: string | null;
          occurrence_count?: number;
          reopened_at?: string | null;
          resolved_at?: string | null;
          severity?: string;
          status?: string;
        };
        Relationships: [];
      };
      operational_job_runs: {
        Row: {
          duration_ms: number | null;
          error_message: string | null;
          finished_at: string | null;
          id: string;
          job_name: string;
          started_at: string;
          status: string;
          summary: Json;
        };
        Insert: {
          duration_ms?: number | null;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          job_name: string;
          started_at?: string;
          status?: string;
          summary?: Json;
        };
        Update: {
          duration_ms?: number | null;
          error_message?: string | null;
          finished_at?: string | null;
          id?: string;
          job_name?: string;
          started_at?: string;
          status?: string;
          summary?: Json;
        };
        Relationships: [];
      };
      outcome_addresses: {
        Row: {
          city: string | null;
          created_at: string;
          geocoding_score: number | null;
          geocoding_source: string | null;
          id: string;
          insee_code: string | null;
          label: string | null;
          latitude: number | null;
          longitude: number | null;
          postal_code: string | null;
          street: string | null;
          updated_at: string;
        };
        Insert: {
          city?: string | null;
          created_at?: string;
          geocoding_score?: number | null;
          geocoding_source?: string | null;
          id?: string;
          insee_code?: string | null;
          label?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          postal_code?: string | null;
          street?: string | null;
          updated_at?: string;
        };
        Update: {
          city?: string | null;
          created_at?: string;
          geocoding_score?: number | null;
          geocoding_source?: string | null;
          id?: string;
          insee_code?: string | null;
          label?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          postal_code?: string | null;
          street?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      outcome_claim_eligibility_decisions: {
        Row: {
          claim_type: string;
          created_at: string;
          decided_at: string;
          decision: string;
          decision_reason: string | null;
          evidence_ids: string[];
          evidence_manifest_hash: string;
          id: string;
          outcome_id: string;
          review_manifest_hash: string;
          reviewer_user_id: string;
          supersedes_decision_id: string | null;
          version: number;
        };
        Insert: {
          claim_type: string;
          created_at?: string;
          decided_at: string;
          decision: string;
          decision_reason?: string | null;
          evidence_ids?: string[];
          evidence_manifest_hash: string;
          id?: string;
          outcome_id: string;
          review_manifest_hash: string;
          reviewer_user_id: string;
          supersedes_decision_id?: string | null;
          version: number;
        };
        Update: {
          claim_type?: string;
          created_at?: string;
          decided_at?: string;
          decision?: string;
          decision_reason?: string | null;
          evidence_ids?: string[];
          evidence_manifest_hash?: string;
          id?: string;
          outcome_id?: string;
          review_manifest_hash?: string;
          reviewer_user_id?: string;
          supersedes_decision_id?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "outcome_claim_eligibility_decisions_outcome_id_fkey";
            columns: ["outcome_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcomes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "outcome_claim_eligibility_decisions_supersedes_decision_id_fkey";
            columns: ["supersedes_decision_id"];
            isOneToOne: false;
            referencedRelation: "outcome_claim_eligibility_decisions";
            referencedColumns: ["id"];
          },
        ];
      };
      outcome_claim_eligibility_evidence: {
        Row: {
          created_at: string;
          eligibility_decision_id: string;
          evidence_id: string;
          outcome_id: string;
        };
        Insert: {
          created_at?: string;
          eligibility_decision_id: string;
          evidence_id: string;
          outcome_id: string;
        };
        Update: {
          created_at?: string;
          eligibility_decision_id?: string;
          evidence_id?: string;
          outcome_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "outcome_claim_eligibility_evidence_decision_fk";
            columns: ["eligibility_decision_id", "outcome_id"];
            isOneToOne: false;
            referencedRelation: "outcome_claim_eligibility_decisions";
            referencedColumns: ["id", "outcome_id"];
          },
          {
            foreignKeyName: "outcome_claim_eligibility_evidence_evidence_fk";
            columns: ["evidence_id", "outcome_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcome_evidence";
            referencedColumns: ["id", "outcome_id"];
          },
        ];
      };
      outcome_court_official_references: {
        Row: {
          court_code: string;
          court_id: string;
          created_at: string;
          id: string;
          judicial_region: string;
          judicial_region_origin_code: string;
          judicial_region_srj_code: string;
          observed_on: string;
          official_name: string;
          official_origin_code: string;
          official_srj_code: string;
          reference_sha256: string;
          source_name: string;
          source_url: string;
        };
        Insert: {
          court_code: string;
          court_id: string;
          created_at?: string;
          id?: string;
          judicial_region: string;
          judicial_region_origin_code: string;
          judicial_region_srj_code: string;
          observed_on: string;
          official_name: string;
          official_origin_code: string;
          official_srj_code: string;
          reference_sha256: string;
          source_name: string;
          source_url: string;
        };
        Update: {
          court_code?: string;
          court_id?: string;
          created_at?: string;
          id?: string;
          judicial_region?: string;
          judicial_region_origin_code?: string;
          judicial_region_srj_code?: string;
          observed_on?: string;
          official_name?: string;
          official_origin_code?: string;
          official_srj_code?: string;
          reference_sha256?: string;
          source_name?: string;
          source_url?: string;
        };
        Relationships: [
          {
            foreignKeyName: "outcome_court_official_references_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      outcome_courts: {
        Row: {
          active: boolean;
          address_id: string | null;
          code: string;
          court_type: string;
          created_at: string;
          id: string;
          judicial_region: string | null;
          name: string;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          address_id?: string | null;
          code: string;
          court_type?: string;
          created_at?: string;
          id?: string;
          judicial_region?: string | null;
          name: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          address_id?: string | null;
          code?: string;
          court_type?: string;
          created_at?: string;
          id?: string;
          judicial_region?: string | null;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "outcome_courts_address_id_fkey";
            columns: ["address_id"];
            isOneToOne: false;
            referencedRelation: "outcome_addresses";
            referencedColumns: ["id"];
          },
        ];
      };
      outcome_model_evaluations: {
        Row: {
          created_at: string;
          eligible_observation_count: number;
          evaluation_hash: string;
          evaluation_mode: string;
          evaluation_period_end: string;
          evaluation_period_start: string;
          evaluation_rule_version: string;
          evaluation_status: string;
          excluded_observation_count: number;
          feature_cutoff_at: string;
          id: string;
          invalid_observation_count: number;
          knowledge_cutoff_at: string;
          known_outcome_count: number;
          model_status_at_evaluation: string;
          model_version_id: string;
          observation_count: number;
          outcome_cutoff_at: string;
          outcome_manifest_hash: string;
          prediction_manifest_hash: string;
          report: Json;
          report_hash: string;
          required_observation_count: number;
          scored_observation_count: number;
          source_manifest_hash: string;
        };
        Insert: {
          created_at: string;
          eligible_observation_count: number;
          evaluation_hash: string;
          evaluation_mode: string;
          evaluation_period_end: string;
          evaluation_period_start: string;
          evaluation_rule_version: string;
          evaluation_status: string;
          excluded_observation_count: number;
          feature_cutoff_at: string;
          id?: string;
          invalid_observation_count: number;
          knowledge_cutoff_at: string;
          known_outcome_count: number;
          model_status_at_evaluation: string;
          model_version_id: string;
          observation_count: number;
          outcome_cutoff_at: string;
          outcome_manifest_hash: string;
          prediction_manifest_hash: string;
          report: Json;
          report_hash: string;
          required_observation_count: number;
          scored_observation_count: number;
          source_manifest_hash: string;
        };
        Update: {
          created_at?: string;
          eligible_observation_count?: number;
          evaluation_hash?: string;
          evaluation_mode?: string;
          evaluation_period_end?: string;
          evaluation_period_start?: string;
          evaluation_rule_version?: string;
          evaluation_status?: string;
          excluded_observation_count?: number;
          feature_cutoff_at?: string;
          id?: string;
          invalid_observation_count?: number;
          knowledge_cutoff_at?: string;
          known_outcome_count?: number;
          model_status_at_evaluation?: string;
          model_version_id?: string;
          observation_count?: number;
          outcome_cutoff_at?: string;
          outcome_manifest_hash?: string;
          prediction_manifest_hash?: string;
          report?: Json;
          report_hash?: string;
          required_observation_count?: number;
          scored_observation_count?: number;
          source_manifest_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: "outcome_model_evaluations_model_version_id_fkey";
            columns: ["model_version_id"];
            isOneToOne: false;
            referencedRelation: "model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      properties: {
        Row: {
          address: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string;
          department: string | null;
          description: string | null;
          external_id: string | null;
          first_seen_at: string;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string;
          land_surface_m2: number | null;
          last_seen_at: string;
          latitude: number | null;
          location: unknown;
          longitude: number | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          raw_payload: Json;
          rooms_count: number | null;
          source_name: string;
          source_url: string;
          source_urls: Json;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          updated_at: string;
        };
        Insert: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          description?: string | null;
          external_id?: string | null;
          first_seen_at?: string;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          id?: string;
          land_surface_m2?: number | null;
          last_seen_at?: string;
          latitude?: number | null;
          location?: unknown;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          rooms_count?: number | null;
          source_name: string;
          source_url: string;
          source_urls?: Json;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Update: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          description?: string | null;
          external_id?: string | null;
          first_seen_at?: string;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          id?: string;
          land_surface_m2?: number | null;
          last_seen_at?: string;
          latitude?: number | null;
          location?: unknown;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          rooms_count?: number | null;
          source_name?: string;
          source_url?: string;
          source_urls?: Json;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "properties_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "properties_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_investment_candidates";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "properties_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales_quality_issues";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "properties_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "public_auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "properties_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "properties_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["source_url"];
          },
        ];
      };
      property_report_exports: {
        Row: {
          created_at: string;
          export_format: string;
          id: string;
          report_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          export_format?: string;
          id?: string;
          report_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          export_format?: string;
          id?: string;
          report_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "property_report_exports_report_id_fkey";
            columns: ["report_id"];
            isOneToOne: false;
            referencedRelation: "saved_property_reports";
            referencedColumns: ["id"];
          },
        ];
      };
      raw_artifacts: {
        Row: {
          byte_size: number;
          canonical_url: string | null;
          captured_at: string;
          connector_version: string;
          content_hash: string;
          created_at: string;
          external_record_id: string | null;
          id: string;
          metadata: Json;
          mime_type: string;
          published_at: string | null;
          source_id: string;
          storage_object_path: string;
        };
        Insert: {
          byte_size: number;
          canonical_url?: string | null;
          captured_at: string;
          connector_version: string;
          content_hash: string;
          created_at?: string;
          external_record_id?: string | null;
          id?: string;
          metadata?: Json;
          mime_type: string;
          published_at?: string | null;
          source_id: string;
          storage_object_path: string;
        };
        Update: {
          byte_size?: number;
          canonical_url?: string | null;
          captured_at?: string;
          connector_version?: string;
          content_hash?: string;
          created_at?: string;
          external_record_id?: string | null;
          id?: string;
          metadata?: Json;
          mime_type?: string;
          published_at?: string | null;
          source_id?: string;
          storage_object_path?: string;
        };
        Relationships: [
          {
            foreignKeyName: "raw_artifacts_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      reference_communes: {
        Row: {
          code_insee: string;
          department_code: string;
          imported_at: string;
          latitude: number | null;
          longitude: number | null;
          name: string;
          name_normalized: string;
          postal_codes: string[];
          source_url: string;
        };
        Insert: {
          code_insee: string;
          department_code: string;
          imported_at?: string;
          latitude?: number | null;
          longitude?: number | null;
          name: string;
          name_normalized: string;
          postal_codes?: string[];
          source_url: string;
        };
        Update: {
          code_insee?: string;
          department_code?: string;
          imported_at?: string;
          latitude?: number | null;
          longitude?: number | null;
          name?: string;
          name_normalized?: string;
          postal_codes?: string[];
          source_url?: string;
        };
        Relationships: [];
      };
      referenced_lawyer_coverage: {
        Row: {
          city: string | null;
          created_at: string;
          department: string | null;
          id: string;
          lawyer_id: string;
          postal_code_prefix: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
        };
        Insert: {
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          lawyer_id: string;
          postal_code_prefix?: string | null;
          tribunal_code?: string | null;
          tribunal_name?: string | null;
        };
        Update: {
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          lawyer_id?: string;
          postal_code_prefix?: string | null;
          tribunal_code?: string | null;
          tribunal_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "referenced_lawyer_coverage_lawyer_id_fkey";
            columns: ["lawyer_id"];
            isOneToOne: false;
            referencedRelation: "referenced_lawyers";
            referencedColumns: ["id"];
          },
        ];
      };
      referenced_lawyers: {
        Row: {
          accepts_judicial_auctions: boolean;
          accepts_remote_contact: boolean;
          address: string | null;
          bar_association: string | null;
          bar_number: string | null;
          city: string | null;
          created_at: string;
          created_by: string | null;
          department: string | null;
          display_name: string;
          email: string | null;
          firm_name: string | null;
          id: string;
          paid_placement_ends_at: string | null;
          paid_placement_starts_at: string | null;
          paid_placement_status: string;
          phone: string | null;
          practice_tags: string[];
          priority_weight: number;
          profile_summary: string | null;
          status: string;
          updated_at: string;
          website_url: string | null;
        };
        Insert: {
          accepts_judicial_auctions?: boolean;
          accepts_remote_contact?: boolean;
          address?: string | null;
          bar_association?: string | null;
          bar_number?: string | null;
          city?: string | null;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          display_name: string;
          email?: string | null;
          firm_name?: string | null;
          id?: string;
          paid_placement_ends_at?: string | null;
          paid_placement_starts_at?: string | null;
          paid_placement_status?: string;
          phone?: string | null;
          practice_tags?: string[];
          priority_weight?: number;
          profile_summary?: string | null;
          status?: string;
          updated_at?: string;
          website_url?: string | null;
        };
        Update: {
          accepts_judicial_auctions?: boolean;
          accepts_remote_contact?: boolean;
          address?: string | null;
          bar_association?: string | null;
          bar_number?: string | null;
          city?: string | null;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          display_name?: string;
          email?: string | null;
          firm_name?: string | null;
          id?: string;
          paid_placement_ends_at?: string | null;
          paid_placement_starts_at?: string | null;
          paid_placement_status?: string;
          phone?: string | null;
          practice_tags?: string[];
          priority_weight?: number;
          profile_summary?: string | null;
          status?: string;
          updated_at?: string;
          website_url?: string | null;
        };
        Relationships: [];
      };
      sale_data_exports: {
        Row: {
          created_at: string;
          export_kind: string;
          id: string;
          row_count: number;
          search_snapshot: Json;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          export_kind?: string;
          id?: string;
          row_count?: number;
          search_snapshot?: Json;
          user_id: string;
        };
        Update: {
          created_at?: string;
          export_kind?: string;
          id?: string;
          row_count?: number;
          search_snapshot?: Json;
          user_id?: string;
        };
        Relationships: [];
      };
      sale_retention_storage_queue: {
        Row: {
          bucket: string;
          created_at: string;
          id: string;
          object_path: string;
        };
        Insert: {
          bucket: string;
          created_at?: string;
          id?: string;
          object_path: string;
        };
        Update: {
          bucket?: string;
          created_at?: string;
          id?: string;
          object_path?: string;
        };
        Relationships: [];
      };
      sale_workspace_annotations: {
        Row: {
          author_id: string;
          body: string;
          created_at: string;
          document_key: string | null;
          document_label: string | null;
          document_type: string | null;
          document_url: string | null;
          excerpt: string | null;
          id: string;
          page_number: number | null;
          resolved_at: string | null;
          sale_id: string;
          status: string;
          target_kind: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          author_id: string;
          body: string;
          created_at?: string;
          document_key?: string | null;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          page_number?: number | null;
          resolved_at?: string | null;
          sale_id: string;
          status?: string;
          target_kind?: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          author_id?: string;
          body?: string;
          created_at?: string;
          document_key?: string | null;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          page_number?: number | null;
          resolved_at?: string | null;
          sale_id?: string;
          status?: string;
          target_kind?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sale_workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_workspace_collaborators: {
        Row: {
          accepted_at: string | null;
          collaborator_user_id: string | null;
          created_at: string;
          id: string;
          invited_at: string;
          invited_by: string;
          invited_email: string;
          owner_id: string;
          revoked_at: string | null;
          role: string;
          status: string;
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          accepted_at?: string | null;
          collaborator_user_id?: string | null;
          created_at?: string;
          id?: string;
          invited_at?: string;
          invited_by: string;
          invited_email: string;
          owner_id: string;
          revoked_at?: string | null;
          role?: string;
          status?: string;
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          accepted_at?: string | null;
          collaborator_user_id?: string | null;
          created_at?: string;
          id?: string;
          invited_at?: string;
          invited_by?: string;
          invited_email?: string;
          owner_id?: string;
          revoked_at?: string | null;
          role?: string;
          status?: string;
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sale_workspace_collaborators_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sale_workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_workspaces: {
        Row: {
          alert_preferences: Json;
          checklist: Json;
          created_at: string;
          document_reviews: Json;
          id: string;
          last_synced_at: string;
          next_action: string | null;
          next_action_due_at: string | null;
          private_notes: Json;
          sale_id: string;
          target_yield_pct: number | null;
          tracking_status: string;
          updated_at: string;
          user_id: string;
          user_max_bid_eur: number | null;
        };
        Insert: {
          alert_preferences?: Json;
          checklist?: Json;
          created_at?: string;
          document_reviews?: Json;
          id?: string;
          last_synced_at?: string;
          next_action?: string | null;
          next_action_due_at?: string | null;
          private_notes?: Json;
          sale_id: string;
          target_yield_pct?: number | null;
          tracking_status?: string;
          updated_at?: string;
          user_id: string;
          user_max_bid_eur?: number | null;
        };
        Update: {
          alert_preferences?: Json;
          checklist?: Json;
          created_at?: string;
          document_reviews?: Json;
          id?: string;
          last_synced_at?: string;
          next_action?: string | null;
          next_action_due_at?: string | null;
          private_notes?: Json;
          sale_id?: string;
          target_yield_pct?: number | null;
          tracking_status?: string;
          updated_at?: string;
          user_id?: string;
          user_max_bid_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      saved_property_reports: {
        Row: {
          ceiling_snapshot: Json;
          created_at: string;
          environmental_snapshot: Json | null;
          export_count: number;
          id: string;
          last_exported_at: string | null;
          market_snapshot: Json;
          report_kind: string;
          report_snapshot: Json;
          sale_id: string;
          share_enabled: boolean;
          share_expires_at: string | null;
          share_token: string | null;
          share_token_hash: string | null;
          share_view_count: number;
          shared_at: string | null;
          title: string;
          updated_at: string;
          user_id: string;
          user_notes: string | null;
        };
        Insert: {
          ceiling_snapshot?: Json;
          created_at?: string;
          environmental_snapshot?: Json | null;
          export_count?: number;
          id?: string;
          last_exported_at?: string | null;
          market_snapshot?: Json;
          report_kind?: string;
          report_snapshot?: Json;
          sale_id: string;
          share_enabled?: boolean;
          share_expires_at?: string | null;
          share_token?: string | null;
          share_token_hash?: string | null;
          share_view_count?: number;
          shared_at?: string | null;
          title: string;
          updated_at?: string;
          user_id: string;
          user_notes?: string | null;
        };
        Update: {
          ceiling_snapshot?: Json;
          created_at?: string;
          environmental_snapshot?: Json | null;
          export_count?: number;
          id?: string;
          last_exported_at?: string | null;
          market_snapshot?: Json;
          report_kind?: string;
          report_snapshot?: Json;
          sale_id?: string;
          share_enabled?: boolean;
          share_expires_at?: string | null;
          share_token?: string | null;
          share_token_hash?: string | null;
          share_view_count?: number;
          shared_at?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
          user_notes?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      source_detail_exclusions: {
        Row: {
          active: boolean;
          created_at: string;
          expires_at: string | null;
          metadata: Json;
          reason: string;
          source_name: string;
          source_url: string;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          expires_at?: string | null;
          metadata?: Json;
          reason: string;
          source_name: string;
          source_url: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          expires_at?: string | null;
          metadata?: Json;
          reason?: string;
          source_name?: string;
          source_url?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      source_fetches: {
        Row: {
          byte_size: number | null;
          capture_transport: string;
          completed_at: string;
          connector_version: string;
          content_hash: string | null;
          created_at: string;
          error_class: string | null;
          error_code: string | null;
          etag: string | null;
          fetch_status: string;
          http_method: string | null;
          http_status: number | null;
          id: string;
          ingestion_job_id: string | null;
          last_modified_at: string | null;
          mime_type: string | null;
          raw_artifact_id: string | null;
          request_fingerprint: string;
          requested_url: string;
          sanitized_error_message: string | null;
          source_cursor: Json;
          source_id: string;
          started_at: string;
        };
        Insert: {
          byte_size?: number | null;
          capture_transport?: string;
          completed_at: string;
          connector_version: string;
          content_hash?: string | null;
          created_at?: string;
          error_class?: string | null;
          error_code?: string | null;
          etag?: string | null;
          fetch_status: string;
          http_method?: string | null;
          http_status?: number | null;
          id?: string;
          ingestion_job_id?: string | null;
          last_modified_at?: string | null;
          mime_type?: string | null;
          raw_artifact_id?: string | null;
          request_fingerprint: string;
          requested_url: string;
          sanitized_error_message?: string | null;
          source_cursor?: Json;
          source_id: string;
          started_at: string;
        };
        Update: {
          byte_size?: number | null;
          capture_transport?: string;
          completed_at?: string;
          connector_version?: string;
          content_hash?: string | null;
          created_at?: string;
          error_class?: string | null;
          error_code?: string | null;
          etag?: string | null;
          fetch_status?: string;
          http_method?: string | null;
          http_status?: number | null;
          id?: string;
          ingestion_job_id?: string | null;
          last_modified_at?: string | null;
          mime_type?: string | null;
          raw_artifact_id?: string | null;
          request_fingerprint?: string;
          requested_url?: string;
          sanitized_error_message?: string | null;
          source_cursor?: Json;
          source_id?: string;
          started_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "source_fetches_ingestion_job_id_fkey";
            columns: ["ingestion_job_id"];
            isOneToOne: false;
            referencedRelation: "ingestion_jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_fetches_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_fetches_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      source_purge_events: {
        Row: {
          actor_user_id: string | null;
          created_at: string;
          details: Json;
          event_at: string;
          event_type: string;
          evidence_hash: string | null;
          external_record_id: string | null;
          id: string;
          raw_artifact_id: string | null;
          reason_code: string;
          request_reference: string | null;
          source_fetch_id: string | null;
          source_id: string;
          source_record_id: string | null;
          storage_object_path: string | null;
          supersedes_event_id: string | null;
        };
        Insert: {
          actor_user_id?: string | null;
          created_at?: string;
          details?: Json;
          event_at?: string;
          event_type: string;
          evidence_hash?: string | null;
          external_record_id?: string | null;
          id?: string;
          raw_artifact_id?: string | null;
          reason_code: string;
          request_reference?: string | null;
          source_fetch_id?: string | null;
          source_id: string;
          source_record_id?: string | null;
          storage_object_path?: string | null;
          supersedes_event_id?: string | null;
        };
        Update: {
          actor_user_id?: string | null;
          created_at?: string;
          details?: Json;
          event_at?: string;
          event_type?: string;
          evidence_hash?: string | null;
          external_record_id?: string | null;
          id?: string;
          raw_artifact_id?: string | null;
          reason_code?: string;
          request_reference?: string | null;
          source_fetch_id?: string | null;
          source_id?: string;
          source_record_id?: string | null;
          storage_object_path?: string | null;
          supersedes_event_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "source_purge_events_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_purge_events_source_fetch_id_fkey";
            columns: ["source_fetch_id"];
            isOneToOne: false;
            referencedRelation: "source_fetches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_purge_events_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_purge_events_source_record_id_fkey";
            columns: ["source_record_id"];
            isOneToOne: false;
            referencedRelation: "judicial_source_records";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_purge_events_supersedes_event_id_fkey";
            columns: ["supersedes_event_id"];
            isOneToOne: false;
            referencedRelation: "source_purge_events";
            referencedColumns: ["id"];
          },
        ];
      };
      source_record_matches: {
        Row: {
          case_id: string | null;
          created_at: string;
          decided_at: string | null;
          decision_notes: string | null;
          id: string;
          lot_id: string | null;
          match_method: string;
          match_score: number;
          match_signals: Json;
          outcome_id: string | null;
          reviewer_user_id: string | null;
          round_id: string | null;
          source_record_id: string;
          status: string;
          supersedes_match_id: string | null;
        };
        Insert: {
          case_id?: string | null;
          created_at?: string;
          decided_at?: string | null;
          decision_notes?: string | null;
          id?: string;
          lot_id?: string | null;
          match_method: string;
          match_score: number;
          match_signals?: Json;
          outcome_id?: string | null;
          reviewer_user_id?: string | null;
          round_id?: string | null;
          source_record_id: string;
          status?: string;
          supersedes_match_id?: string | null;
        };
        Update: {
          case_id?: string | null;
          created_at?: string;
          decided_at?: string | null;
          decision_notes?: string | null;
          id?: string;
          lot_id?: string | null;
          match_method?: string;
          match_score?: number;
          match_signals?: Json;
          outcome_id?: string | null;
          reviewer_user_id?: string | null;
          round_id?: string | null;
          source_record_id?: string;
          status?: string;
          supersedes_match_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "source_record_matches_case_id_fkey";
            columns: ["case_id"];
            isOneToOne: false;
            referencedRelation: "auction_cases";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_record_matches_lot_id_fkey";
            columns: ["lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_record_matches_outcome_id_fkey";
            columns: ["outcome_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcomes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_record_matches_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_record_matches_source_record_id_fkey";
            columns: ["source_record_id"];
            isOneToOne: false;
            referencedRelation: "judicial_source_records";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_record_matches_supersedes_match_id_fkey";
            columns: ["supersedes_match_id"];
            isOneToOne: false;
            referencedRelation: "source_record_matches";
            referencedColumns: ["id"];
          },
        ];
      };
      source_sync_checkpoints: {
        Row: {
          connector_version: string;
          created_at: string;
          id: string;
          last_successful_fetch_id: string | null;
          revision: number;
          source_cursor: Json;
          source_id: string;
          stream_key: string;
          updated_at: string;
          watermark_at: string | null;
        };
        Insert: {
          connector_version: string;
          created_at?: string;
          id?: string;
          last_successful_fetch_id?: string | null;
          revision?: number;
          source_cursor?: Json;
          source_id: string;
          stream_key?: string;
          updated_at?: string;
          watermark_at?: string | null;
        };
        Update: {
          connector_version?: string;
          created_at?: string;
          id?: string;
          last_successful_fetch_id?: string | null;
          revision?: number;
          source_cursor?: Json;
          source_id?: string;
          stream_key?: string;
          updated_at?: string;
          watermark_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "source_sync_checkpoints_last_successful_fetch_id_fkey";
            columns: ["last_successful_fetch_id"];
            isOneToOne: false;
            referencedRelation: "source_fetches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "source_sync_checkpoints_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      spatial_ref_sys: {
        Row: {
          auth_name: string | null;
          auth_srid: number | null;
          proj4text: string | null;
          srid: number;
          srtext: string | null;
        };
        Insert: {
          auth_name?: string | null;
          auth_srid?: number | null;
          proj4text?: string | null;
          srid: number;
          srtext?: string | null;
        };
        Update: {
          auth_name?: string | null;
          auth_srid?: number | null;
          proj4text?: string | null;
          srid?: number;
          srtext?: string | null;
        };
        Relationships: [];
      };
      stripe_checkout_access_grants: {
        Row: {
          access_end: string;
          access_start: string;
          amount_total: number | null;
          checkout_session_id: string;
          created_at: string;
          currency: string | null;
          paid_at: string;
          plan_code: string;
          stripe_customer_id: string | null;
          user_id: string;
        };
        Insert: {
          access_end: string;
          access_start: string;
          amount_total?: number | null;
          checkout_session_id: string;
          created_at?: string;
          currency?: string | null;
          paid_at: string;
          plan_code?: string;
          stripe_customer_id?: string | null;
          user_id: string;
        };
        Update: {
          access_end?: string;
          access_start?: string;
          amount_total?: number | null;
          checkout_session_id?: string;
          created_at?: string;
          currency?: string | null;
          paid_at?: string;
          plan_code?: string;
          stripe_customer_id?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      stripe_payment_lifecycle: {
        Row: {
          checkout_session_id: string | null;
          created_at: string;
          last_event_created: number;
          last_event_id: string;
          last_event_type: string;
          metadata: Json;
          payment_intent_id: string;
          state: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          checkout_session_id?: string | null;
          created_at?: string;
          last_event_created: number;
          last_event_id: string;
          last_event_type: string;
          metadata?: Json;
          payment_intent_id: string;
          state: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          checkout_session_id?: string | null;
          created_at?: string;
          last_event_created?: number;
          last_event_id?: string;
          last_event_type?: string;
          metadata?: Json;
          payment_intent_id?: string;
          state?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      stripe_webhook_events: {
        Row: {
          attempt_count: number;
          error_message: string | null;
          event_id: string;
          event_type: string;
          livemode: boolean;
          processed_at: string | null;
          processing_status: string;
          received_at: string;
          updated_at: string;
        };
        Insert: {
          attempt_count?: number;
          error_message?: string | null;
          event_id: string;
          event_type: string;
          livemode: boolean;
          processed_at?: string | null;
          processing_status?: string;
          received_at?: string;
          updated_at?: string;
        };
        Update: {
          attempt_count?: number;
          error_message?: string | null;
          event_id?: string;
          event_type?: string;
          livemode?: boolean;
          processed_at?: string | null;
          processing_status?: string;
          received_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      tribunal_statistics_members: {
        Row: {
          court_id: string;
          created_at: string;
          double_reviewed: boolean;
          effective_starting_price_claim_eligible: boolean;
          exclusion_reasons: string[];
          feature_snapshot_id: string;
          final_hammer_price_claim_eligible: boolean;
          finality_status_claim_eligible: boolean;
          initial_hammer_price_claim_eligible: boolean;
          initial_starting_price_claim_eligible: boolean;
          market_price_claim_eligible: boolean;
          member_hash: string;
          outcome_id: string | null;
          postponement_delay_eligible: boolean;
          result_observed_at_claim_eligible: boolean;
          round_id: string;
          snapshot_id: string;
          status_claim_eligible: boolean;
          surenchere_claim_eligible: boolean;
        };
        Insert: {
          court_id: string;
          created_at?: string;
          double_reviewed?: boolean;
          effective_starting_price_claim_eligible?: boolean;
          exclusion_reasons?: string[];
          feature_snapshot_id: string;
          final_hammer_price_claim_eligible?: boolean;
          finality_status_claim_eligible?: boolean;
          initial_hammer_price_claim_eligible?: boolean;
          initial_starting_price_claim_eligible?: boolean;
          market_price_claim_eligible?: boolean;
          member_hash: string;
          outcome_id?: string | null;
          postponement_delay_eligible?: boolean;
          result_observed_at_claim_eligible?: boolean;
          round_id: string;
          snapshot_id: string;
          status_claim_eligible?: boolean;
          surenchere_claim_eligible?: boolean;
        };
        Update: {
          court_id?: string;
          created_at?: string;
          double_reviewed?: boolean;
          effective_starting_price_claim_eligible?: boolean;
          exclusion_reasons?: string[];
          feature_snapshot_id?: string;
          final_hammer_price_claim_eligible?: boolean;
          finality_status_claim_eligible?: boolean;
          initial_hammer_price_claim_eligible?: boolean;
          initial_starting_price_claim_eligible?: boolean;
          market_price_claim_eligible?: boolean;
          member_hash?: string;
          outcome_id?: string | null;
          postponement_delay_eligible?: boolean;
          result_observed_at_claim_eligible?: boolean;
          round_id?: string;
          snapshot_id?: string;
          status_claim_eligible?: boolean;
          surenchere_claim_eligible?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "tribunal_statistics_members_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tribunal_statistics_members_feature_snapshot_fk";
            columns: ["feature_snapshot_id", "round_id"];
            isOneToOne: false;
            referencedRelation: "auction_feature_snapshots";
            referencedColumns: ["id", "round_id"];
          },
          {
            foreignKeyName: "tribunal_statistics_members_outcome_id_fkey";
            columns: ["outcome_id"];
            isOneToOne: false;
            referencedRelation: "auction_outcomes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tribunal_statistics_members_round_id_fkey";
            columns: ["round_id"];
            isOneToOne: false;
            referencedRelation: "auction_rounds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tribunal_statistics_members_snapshot_id_fkey";
            columns: ["snapshot_id"];
            isOneToOne: false;
            referencedRelation: "tribunal_statistics_snapshots";
            referencedColumns: ["id"];
          },
        ];
      };
      tribunal_statistics_snapshots: {
        Row: {
          builder_version: string;
          computed_at: string;
          court_code: string | null;
          court_id: string | null;
          court_name: string | null;
          created_at: string;
          double_reviewed_count: number;
          effective_price_sample_size: number;
          eligibility_rule_version: string;
          eligible_round_count: number;
          freeze_coverage: number;
          id: string;
          initial_price_sample_size: number;
          judicial_region: string | null;
          knowledge_cutoff_at: string;
          market_price_sample_size: number;
          maturity_days: number;
          outcome_coverage: number;
          parent_snapshot_id: string | null;
          period_end: string;
          period_start: string;
          postponement_delay_sample_size: number;
          quality_gate_passed: boolean;
          reliability_status: string;
          result_delay_sample_size: number;
          round_kind: string;
          scope_type: string;
          smoothing_rule_version: string;
          source_manifest_hash: string;
          statistics: Json;
          statistics_hash: string;
          status_sample_size: number;
          surenchere_sample_size: number;
          unfrozen_round_count: number;
          window_months: number;
        };
        Insert: {
          builder_version: string;
          computed_at?: string;
          court_code?: string | null;
          court_id?: string | null;
          court_name?: string | null;
          created_at?: string;
          double_reviewed_count: number;
          effective_price_sample_size: number;
          eligibility_rule_version: string;
          eligible_round_count: number;
          freeze_coverage?: number;
          id?: string;
          initial_price_sample_size: number;
          judicial_region?: string | null;
          knowledge_cutoff_at: string;
          market_price_sample_size?: number;
          maturity_days?: number;
          outcome_coverage: number;
          parent_snapshot_id?: string | null;
          period_end: string;
          period_start: string;
          postponement_delay_sample_size?: number;
          quality_gate_passed?: boolean;
          reliability_status: string;
          result_delay_sample_size: number;
          round_kind: string;
          scope_type: string;
          smoothing_rule_version: string;
          source_manifest_hash: string;
          statistics: Json;
          statistics_hash: string;
          status_sample_size: number;
          surenchere_sample_size: number;
          unfrozen_round_count?: number;
          window_months: number;
        };
        Update: {
          builder_version?: string;
          computed_at?: string;
          court_code?: string | null;
          court_id?: string | null;
          court_name?: string | null;
          created_at?: string;
          double_reviewed_count?: number;
          effective_price_sample_size?: number;
          eligibility_rule_version?: string;
          eligible_round_count?: number;
          freeze_coverage?: number;
          id?: string;
          initial_price_sample_size?: number;
          judicial_region?: string | null;
          knowledge_cutoff_at?: string;
          market_price_sample_size?: number;
          maturity_days?: number;
          outcome_coverage?: number;
          parent_snapshot_id?: string | null;
          period_end?: string;
          period_start?: string;
          postponement_delay_sample_size?: number;
          quality_gate_passed?: boolean;
          reliability_status?: string;
          result_delay_sample_size?: number;
          round_kind?: string;
          scope_type?: string;
          smoothing_rule_version?: string;
          source_manifest_hash?: string;
          statistics?: Json;
          statistics_hash?: string;
          status_sample_size?: number;
          surenchere_sample_size?: number;
          unfrozen_round_count?: number;
          window_months?: number;
        };
        Relationships: [
          {
            foreignKeyName: "tribunal_statistics_snapshots_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tribunal_statistics_snapshots_parent_snapshot_id_fkey";
            columns: ["parent_snapshot_id"];
            isOneToOne: false;
            referencedRelation: "tribunal_statistics_snapshots";
            referencedColumns: ["id"];
          },
        ];
      };
      tribunals: {
        Row: {
          aliases: Json | null;
          canonical_name: string;
          city: string;
          code: string;
          created_at: string | null;
          department: string;
          updated_at: string | null;
        };
        Insert: {
          aliases?: Json | null;
          canonical_name: string;
          city: string;
          code: string;
          created_at?: string | null;
          department: string;
          updated_at?: string | null;
        };
        Update: {
          aliases?: Json | null;
          canonical_name?: string;
          city?: string;
          code?: string;
          created_at?: string | null;
          department?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      user_alert_matches: {
        Row: {
          alert_id: string;
          dismissed_at: string | null;
          id: string;
          match_reasons: string[];
          match_snapshot: Json;
          matched_at: string;
          read_at: string | null;
          sale_id: string;
          user_id: string;
        };
        Insert: {
          alert_id: string;
          dismissed_at?: string | null;
          id?: string;
          match_reasons?: string[];
          match_snapshot?: Json;
          matched_at?: string;
          read_at?: string | null;
          sale_id: string;
          user_id: string;
        };
        Update: {
          alert_id?: string;
          dismissed_at?: string | null;
          id?: string;
          match_reasons?: string[];
          match_snapshot?: Json;
          matched_at?: string;
          read_at?: string | null;
          sale_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_alert_matches_alert_id_fkey";
            columns: ["alert_id"];
            isOneToOne: false;
            referencedRelation: "user_alerts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      user_alert_notifications: {
        Row: {
          alert_id: string;
          created_at: string;
          delivery_channel: string;
          delivery_status: string;
          dismissed_at: string | null;
          id: string;
          match_id: string;
          notification_kind: string;
          notification_snapshot: Json;
          read_at: string | null;
          sale_id: string;
          scheduled_for: string;
          sent_at: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          alert_id: string;
          created_at?: string;
          delivery_channel?: string;
          delivery_status?: string;
          dismissed_at?: string | null;
          id?: string;
          match_id: string;
          notification_kind?: string;
          notification_snapshot?: Json;
          read_at?: string | null;
          sale_id: string;
          scheduled_for?: string;
          sent_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          alert_id?: string;
          created_at?: string;
          delivery_channel?: string;
          delivery_status?: string;
          dismissed_at?: string | null;
          id?: string;
          match_id?: string;
          notification_kind?: string;
          notification_snapshot?: Json;
          read_at?: string | null;
          sale_id?: string;
          scheduled_for?: string;
          sent_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_alert_notifications_alert_id_fkey";
            columns: ["alert_id"];
            isOneToOne: false;
            referencedRelation: "user_alerts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_match_id_fkey";
            columns: ["match_id"];
            isOneToOne: false;
            referencedRelation: "user_alert_matches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      user_alerts: {
        Row: {
          advanced_criteria: Json;
          alert_frequency: string;
          city: string | null;
          created_at: string;
          department: string | null;
          dpe_classes: string[];
          id: string;
          is_active: boolean;
          last_evaluated_at: string | null;
          last_match_count: number;
          max_price_eur: number | null;
          max_price_per_m2: number | null;
          min_investment_score: number | null;
          min_market_discount_pct: number | null;
          min_surface_m2: number | null;
          min_yield_pct: number | null;
          name: string;
          occupancy_status: string | null;
          property_type: string | null;
          require_house_with_land: boolean;
          updated_at: string;
          user_id: string;
          watched_zone_id: string | null;
        };
        Insert: {
          advanced_criteria?: Json;
          alert_frequency?: string;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          dpe_classes?: string[];
          id?: string;
          is_active?: boolean;
          last_evaluated_at?: string | null;
          last_match_count?: number;
          max_price_eur?: number | null;
          max_price_per_m2?: number | null;
          min_investment_score?: number | null;
          min_market_discount_pct?: number | null;
          min_surface_m2?: number | null;
          min_yield_pct?: number | null;
          name: string;
          occupancy_status?: string | null;
          property_type?: string | null;
          require_house_with_land?: boolean;
          updated_at?: string;
          user_id: string;
          watched_zone_id?: string | null;
        };
        Update: {
          advanced_criteria?: Json;
          alert_frequency?: string;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          dpe_classes?: string[];
          id?: string;
          is_active?: boolean;
          last_evaluated_at?: string | null;
          last_match_count?: number;
          max_price_eur?: number | null;
          max_price_per_m2?: number | null;
          min_investment_score?: number | null;
          min_market_discount_pct?: number | null;
          min_surface_m2?: number | null;
          min_yield_pct?: number | null;
          name?: string;
          occupancy_status?: string | null;
          property_type?: string | null;
          require_house_with_land?: boolean;
          updated_at?: string;
          user_id?: string;
          watched_zone_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_alerts_watched_zone_owner_fkey";
            columns: ["user_id", "watched_zone_id"];
            isOneToOne: false;
            referencedRelation: "user_watched_zones";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      user_api_keys: {
        Row: {
          created_at: string;
          expires_at: string | null;
          id: string;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          name: string;
          revoked_at: string | null;
          scopes: string[];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          name: string;
          revoked_at?: string | null;
          scopes?: string[];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          name?: string;
          revoked_at?: string | null;
          scopes?: string[];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_favorites: {
        Row: {
          created_at: string;
          id: string;
          sale_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          sale_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          sale_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      user_notification_preferences: {
        Row: {
          alert_email_consented_at: string | null;
          alert_email_enabled: boolean;
          alert_email_revoked_at: string | null;
          consent_source: string;
          created_at: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          alert_email_consented_at?: string | null;
          alert_email_enabled?: boolean;
          alert_email_revoked_at?: string | null;
          consent_source?: string;
          created_at?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          alert_email_consented_at?: string | null;
          alert_email_enabled?: boolean;
          alert_email_revoked_at?: string | null;
          consent_source?: string;
          created_at?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_profiles: {
        Row: {
          account_tier: string;
          account_type: string;
          created_at: string;
          email: string | null;
          full_name: string | null;
          organization_name: string | null;
          professional_role: string | null;
          professional_status: string;
          updated_at: string;
          user_id: string;
          user_role: string;
        };
        Insert: {
          account_tier?: string;
          account_type?: string;
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          organization_name?: string | null;
          professional_role?: string | null;
          professional_status?: string;
          updated_at?: string;
          user_id: string;
          user_role?: string;
        };
        Update: {
          account_tier?: string;
          account_type?: string;
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          organization_name?: string | null;
          professional_role?: string | null;
          professional_status?: string;
          updated_at?: string;
          user_id?: string;
          user_role?: string;
        };
        Relationships: [];
      };
      user_sale_analysis_items: {
        Row: {
          analysis_set_id: string;
          created_at: string;
          decision_status: string;
          expected_margin_pct: number | null;
          id: string;
          item_order: number;
          notes: string | null;
          sale_id: string;
          target_yield_pct: number | null;
          updated_at: string;
          user_id: string;
          user_max_bid_eur: number | null;
        };
        Insert: {
          analysis_set_id: string;
          created_at?: string;
          decision_status?: string;
          expected_margin_pct?: number | null;
          id?: string;
          item_order?: number;
          notes?: string | null;
          sale_id: string;
          target_yield_pct?: number | null;
          updated_at?: string;
          user_id: string;
          user_max_bid_eur?: number | null;
        };
        Update: {
          analysis_set_id?: string;
          created_at?: string;
          decision_status?: string;
          expected_margin_pct?: number | null;
          id?: string;
          item_order?: number;
          notes?: string | null;
          sale_id?: string;
          target_yield_pct?: number | null;
          updated_at?: string;
          user_id?: string;
          user_max_bid_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_user_id_analysis_set_id_fkey";
            columns: ["user_id", "analysis_set_id"];
            isOneToOne: false;
            referencedRelation: "user_sale_analysis_sets";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      user_sale_analysis_sets: {
        Row: {
          analysis_kind: string;
          assumptions: Json;
          created_at: string;
          id: string;
          is_archived: boolean;
          name: string;
          notes: string | null;
          share_expires_at: string | null;
          share_token_hash: string | null;
          shared_at: string | null;
          shared_snapshot: Json | null;
          summary_snapshot: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          analysis_kind?: string;
          assumptions?: Json;
          created_at?: string;
          id?: string;
          is_archived?: boolean;
          name: string;
          notes?: string | null;
          share_expires_at?: string | null;
          share_token_hash?: string | null;
          shared_at?: string | null;
          shared_snapshot?: Json | null;
          summary_snapshot?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          analysis_kind?: string;
          assumptions?: Json;
          created_at?: string;
          id?: string;
          is_archived?: boolean;
          name?: string;
          notes?: string | null;
          share_expires_at?: string | null;
          share_token_hash?: string | null;
          shared_at?: string | null;
          shared_snapshot?: Json | null;
          summary_snapshot?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_sale_change_events: {
        Row: {
          change_summary: Json;
          created_at: string;
          detected_at: string;
          dismissed_at: string | null;
          event_kind: string;
          fingerprint: string;
          id: string;
          new_snapshot: Json;
          old_snapshot: Json;
          read_at: string | null;
          sale_id: string;
          severity: string;
          summary_label: string;
          user_id: string;
          watch_id: string;
          watch_kind: string;
        };
        Insert: {
          change_summary?: Json;
          created_at?: string;
          detected_at?: string;
          dismissed_at?: string | null;
          event_kind: string;
          fingerprint: string;
          id?: string;
          new_snapshot?: Json;
          old_snapshot?: Json;
          read_at?: string | null;
          sale_id: string;
          severity?: string;
          summary_label: string;
          user_id: string;
          watch_id: string;
          watch_kind: string;
        };
        Update: {
          change_summary?: Json;
          created_at?: string;
          detected_at?: string;
          dismissed_at?: string | null;
          event_kind?: string;
          fingerprint?: string;
          id?: string;
          new_snapshot?: Json;
          old_snapshot?: Json;
          read_at?: string | null;
          sale_id?: string;
          severity?: string;
          summary_label?: string;
          user_id?: string;
          watch_id?: string;
          watch_kind?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      user_sale_watch_snapshots: {
        Row: {
          created_at: string;
          fingerprint: string;
          id: string;
          last_checked_at: string;
          sale_id: string;
          snapshot: Json;
          updated_at: string;
          user_id: string;
          watch_id: string;
          watch_kind: string;
        };
        Insert: {
          created_at?: string;
          fingerprint: string;
          id?: string;
          last_checked_at?: string;
          sale_id: string;
          snapshot?: Json;
          updated_at?: string;
          user_id: string;
          watch_id: string;
          watch_kind: string;
        };
        Update: {
          created_at?: string;
          fingerprint?: string;
          id?: string;
          last_checked_at?: string;
          sale_id?: string;
          snapshot?: Json;
          updated_at?: string;
          user_id?: string;
          watch_id?: string;
          watch_kind?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      user_subscriptions: {
        Row: {
          created_at: string;
          current_period_end: string | null;
          metadata: Json;
          plan_code: string;
          status: string;
          stripe_customer_id: string | null;
          stripe_event_created: number | null;
          stripe_subscription_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          current_period_end?: string | null;
          metadata?: Json;
          plan_code?: string;
          status?: string;
          stripe_customer_id?: string | null;
          stripe_event_created?: number | null;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          current_period_end?: string | null;
          metadata?: Json;
          plan_code?: string;
          status?: string;
          stripe_customer_id?: string | null;
          stripe_event_created?: number | null;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_watched_zones: {
        Row: {
          alert_defaults: Json;
          center_lat: number | null;
          center_lng: number | null;
          city: string | null;
          created_at: string;
          department: string | null;
          id: string;
          is_active: boolean;
          name: string;
          postal_code_prefix: string | null;
          radius_km: number | null;
          updated_at: string;
          user_id: string;
          zone_kind: string;
        };
        Insert: {
          alert_defaults?: Json;
          center_lat?: number | null;
          center_lng?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_active?: boolean;
          name: string;
          postal_code_prefix?: string | null;
          radius_km?: number | null;
          updated_at?: string;
          user_id: string;
          zone_kind?: string;
        };
        Update: {
          alert_defaults?: Json;
          center_lat?: number | null;
          center_lng?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_active?: boolean;
          name?: string;
          postal_code_prefix?: string | null;
          radius_km?: number | null;
          updated_at?: string;
          user_id?: string;
          zone_kind?: string;
        };
        Relationships: [];
      };
      valuation_estimate_attempts: {
        Row: {
          actionable: boolean | null;
          attempt_number: number;
          auction_sale_id: string;
          comparable_count: number | null;
          confidence_score: number | null;
          created_at: string;
          details: Json;
          engine_kind: string | null;
          error_code: string | null;
          error_message: string | null;
          id: string;
          input_fingerprint: string;
          latency_ms: number;
          outcome: string;
          request_source: string;
          segment: string | null;
        };
        Insert: {
          actionable?: boolean | null;
          attempt_number: number;
          auction_sale_id: string;
          comparable_count?: number | null;
          confidence_score?: number | null;
          created_at?: string;
          details?: Json;
          engine_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          input_fingerprint: string;
          latency_ms: number;
          outcome: string;
          request_source: string;
          segment?: string | null;
        };
        Update: {
          actionable?: boolean | null;
          attempt_number?: number;
          auction_sale_id?: string;
          comparable_count?: number | null;
          confidence_score?: number | null;
          created_at?: string;
          details?: Json;
          engine_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          input_fingerprint?: string;
          latency_ms?: number;
          outcome?: string;
          request_source?: string;
          segment?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      valuation_estimates: {
        Row: {
          actionable: boolean;
          auction_sale_id: string | null;
          comparable_count: number;
          confidence_score: number | null;
          created_at: string;
          engine_kind: string;
          engine_version: string;
          id: string;
          input_snapshot: Json;
          latency_ms: number | null;
          market_cell: string | null;
          model_version_id: string | null;
          request_fingerprint: string | null;
          result_snapshot: Json;
          segment: string;
          user_id: string | null;
          value_p10_eur: number | null;
          value_p50_eur: number | null;
          value_p90_eur: number | null;
        };
        Insert: {
          actionable?: boolean;
          auction_sale_id?: string | null;
          comparable_count?: number;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind: string;
          engine_version: string;
          id?: string;
          input_snapshot?: Json;
          latency_ms?: number | null;
          market_cell?: string | null;
          model_version_id?: string | null;
          request_fingerprint?: string | null;
          result_snapshot?: Json;
          segment: string;
          user_id?: string | null;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Update: {
          actionable?: boolean;
          auction_sale_id?: string | null;
          comparable_count?: number;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind?: string;
          engine_version?: string;
          id?: string;
          input_snapshot?: Json;
          latency_ms?: number | null;
          market_cell?: string | null;
          model_version_id?: string | null;
          request_fingerprint?: string | null;
          result_snapshot?: Json;
          segment?: string;
          user_id?: string | null;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_model_version_id_fkey";
            columns: ["model_version_id"];
            isOneToOne: false;
            referencedRelation: "valuation_model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      valuation_model_versions: {
        Row: {
          activated_at: string | null;
          artifact: Json;
          calibration: Json;
          created_at: string;
          feature_names: string[];
          framework: string;
          id: string;
          model_key: string;
          retired_at: string | null;
          segment: string;
          status: string;
          trained_at: string | null;
          training_metrics: Json;
          training_period_end: string | null;
          training_period_start: string | null;
          training_rows: number | null;
          updated_at: string;
          version: string;
        };
        Insert: {
          activated_at?: string | null;
          artifact?: Json;
          calibration?: Json;
          created_at?: string;
          feature_names?: string[];
          framework: string;
          id?: string;
          model_key?: string;
          retired_at?: string | null;
          segment: string;
          status?: string;
          trained_at?: string | null;
          training_metrics?: Json;
          training_period_end?: string | null;
          training_period_start?: string | null;
          training_rows?: number | null;
          updated_at?: string;
          version: string;
        };
        Update: {
          activated_at?: string | null;
          artifact?: Json;
          calibration?: Json;
          created_at?: string;
          feature_names?: string[];
          framework?: string;
          id?: string;
          model_key?: string;
          retired_at?: string | null;
          segment?: string;
          status?: string;
          trained_at?: string | null;
          training_metrics?: Json;
          training_period_end?: string | null;
          training_period_start?: string | null;
          training_rows?: number | null;
          updated_at?: string;
          version?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      auction_sale_source_presence: {
        Row: {
          attempted_at: string | null;
          availability: string | null;
          checked_at: string | null;
          extras: Json | null;
          run_id: string | null;
          sale_id: string | null;
          source_name: string | null;
          state: string | null;
        };
        Insert: {
          attempted_at?: string | null;
          availability?: string | null;
          checked_at?: string | null;
          extras?: Json | null;
          run_id?: string | null;
          sale_id?: string | null;
          source_name?: string | null;
          state?: string | null;
        };
        Update: {
          attempted_at?: string | null;
          availability?: string | null;
          checked_at?: string | null;
          extras?: Json | null;
          run_id?: string | null;
          sale_id?: string | null;
          source_name?: string | null;
          state?: string | null;
        };
        Relationships: [];
      };
      auction_sales_investment_candidates: {
        Row: {
          address: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          first_seen_at: string | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          last_seen_at: string | null;
          latitude: number | null;
          longitude: number | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          rooms_count: number | null;
          sale_date: string | null;
          source_name: string | null;
          source_url: string | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_scope: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Insert: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          description?: string | null;
          documents?: Json | null;
          first_seen_at?: string | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          last_seen_at?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_scope?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string | null;
          visit_dates?: Json | null;
        };
        Update: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          description?: string | null;
          documents?: Json | null;
          first_seen_at?: string | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          last_seen_at?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_scope?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string | null;
          visit_dates?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      auction_sales_quality_issues: {
        Row: {
          app_surface_m2: number | null;
          bedrooms_count: number | null;
          city: string | null;
          department: string | null;
          latitude: number | null;
          longitude: number | null;
          quality_flags: Json | null;
          rooms_count: number | null;
          source_name: string | null;
          source_url: string | null;
          tribunal: string | null;
          updated_at: string | null;
        };
        Insert: {
          app_surface_m2?: number | null;
          bedrooms_count?: number | null;
          city?: string | null;
          department?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          quality_flags?: Json | null;
          rooms_count?: number | null;
          source_name?: string | null;
          source_url?: string | null;
          tribunal?: string | null;
          updated_at?: string | null;
        };
        Update: {
          app_surface_m2?: number | null;
          bedrooms_count?: number | null;
          city?: string | null;
          department?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          quality_flags?: Json | null;
          rooms_count?: number | null;
          source_name?: string | null;
          source_url?: string | null;
          tribunal?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      auction_source_coverage: {
        Row: {
          department: string | null;
          sales_count: number | null;
          source_name: string | null;
          with_app_surface: number | null;
          with_gps: number | null;
        };
        Relationships: [];
      };
      geography_columns: {
        Row: {
          coord_dimension: number | null;
          f_geography_column: unknown;
          f_table_catalog: unknown;
          f_table_name: unknown;
          f_table_schema: unknown;
          srid: number | null;
          type: string | null;
        };
        Relationships: [];
      };
      geometry_columns: {
        Row: {
          coord_dimension: number | null;
          f_geometry_column: unknown;
          f_table_catalog: string | null;
          f_table_name: unknown;
          f_table_schema: unknown;
          srid: number | null;
          type: string | null;
        };
        Insert: {
          coord_dimension?: number | null;
          f_geometry_column?: unknown;
          f_table_catalog?: string | null;
          f_table_name?: unknown;
          f_table_schema?: unknown;
          srid?: number | null;
          type?: string | null;
        };
        Update: {
          coord_dimension?: number | null;
          f_geometry_column?: unknown;
          f_table_catalog?: string | null;
          f_table_name?: unknown;
          f_table_schema?: unknown;
          srid?: number | null;
          type?: string | null;
        };
        Relationships: [];
      };
      public_auction_sales: {
        Row: {
          address: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          first_seen_at: string | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          last_seen_at: string | null;
          latitude: number | null;
          longitude: number | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          rooms_count: number | null;
          sale_date: string | null;
          source_name: string | null;
          source_url: string | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_scope: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Insert: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          description?: string | null;
          documents?: Json | null;
          first_seen_at?: string | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          last_seen_at?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_scope?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string | null;
          visit_dates?: Json | null;
        };
        Update: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          description?: string | null;
          documents?: Json | null;
          first_seen_at?: string | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          last_seen_at?: string | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_scope?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string | null;
          visit_dates?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      published_adjudication_price_statistics: {
        Row: {
          above_starting_rate: number | null;
          at_least_double_rate: number | null;
          build_id: string | null;
          built_at: string | null;
          court_code: string | null;
          court_id: string | null;
          extra_statistics: Json | null;
          id: string | null;
          judicial_region: string | null;
          median_hammer_price_eur: number | null;
          median_hammer_to_starting_ratio: number | null;
          median_starting_price_eur: number | null;
          methodology_version: string | null;
          minimum_sample: number | null;
          period_end: string | null;
          period_start: string | null;
          reviewed_at: string | null;
          sample_size: number | null;
          scope_label: string | null;
          scope_type: string | null;
          source_name: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "adjudication_price_statistics_snapshots_build_id_fkey";
            columns: ["build_id"];
            isOneToOne: false;
            referencedRelation: "adjudication_price_statistics_builds";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "adjudication_price_statistics_snapshots_court_id_fkey";
            columns: ["court_id"];
            isOneToOne: false;
            referencedRelation: "outcome_courts";
            referencedColumns: ["id"];
          },
        ];
      };
      v_auction_ai_review_projection_read_model: {
        Row: {
          auction_sale_id: string | null;
          citation_status: string | null;
          comparison_reason: string | null;
          comparison_status: string | null;
          field_key: string | null;
          is_publishable: boolean | null;
          projection_id: string | null;
          review_state: string | null;
          source_name: string | null;
          source_url: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      v_auction_ai_review_projection_reconciliation: {
        Row: {
          ai_value_jsonb: Json | null;
          auction_sale_id: string | null;
          canonical_value_jsonb: Json | null;
          capture_sha256: string | null;
          citation_status: string | null;
          comparison_reason: string | null;
          comparison_status: string | null;
          created_at: string | null;
          evidence_locator: Json | null;
          field_key: string | null;
          local_is_publishable: boolean | null;
          normalized_ai_value: string | null;
          normalized_canonical_value: string | null;
          projection_id: string | null;
          review_state: string | null;
          source_name: string | null;
          source_url: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      v_auction_ai_review_publishable: {
        Row: {
          auction_sale_id: string | null;
          capture_sha256: string | null;
          citation_status: string | null;
          created_at: string | null;
          evidence_locator: Json | null;
          field_key: string | null;
          is_publishable: boolean | null;
          projection_id: string | null;
          review_state: string | null;
          source_name: string | null;
          source_url: string | null;
          value_jsonb: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_ai_review_projections_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
        ];
      };
      v_auction_fact_claims_read_model: {
        Row: {
          artifact_extraction_id: string | null;
          auction_sale_id: string | null;
          captured_at: string | null;
          claim_id: string | null;
          confidence_score: number | null;
          conflict_group: string | null;
          created_at: string | null;
          evidence_kind: string | null;
          evidence_locator: Json | null;
          fact_status: string | null;
          field_key: string | null;
          is_publishable: boolean | null;
          lot_id: string | null;
          raw_artifact_id: string | null;
          resolution_note: string | null;
          resolved_at: string | null;
          source_id: string | null;
          source_record_id: string | null;
          source_url: string | null;
          updated_at: string | null;
          value_jsonb: Json | null;
        };
        Insert: {
          artifact_extraction_id?: string | null;
          auction_sale_id?: string | null;
          captured_at?: string | null;
          claim_id?: string | null;
          confidence_score?: number | null;
          conflict_group?: string | null;
          created_at?: string | null;
          evidence_kind?: string | null;
          evidence_locator?: Json | null;
          fact_status?: string | null;
          field_key?: string | null;
          is_publishable?: never;
          lot_id?: string | null;
          raw_artifact_id?: string | null;
          resolution_note?: string | null;
          resolved_at?: string | null;
          source_id?: string | null;
          source_record_id?: string | null;
          source_url?: string | null;
          updated_at?: string | null;
          value_jsonb?: Json | null;
        };
        Update: {
          artifact_extraction_id?: string | null;
          auction_sale_id?: string | null;
          captured_at?: string | null;
          claim_id?: string | null;
          confidence_score?: number | null;
          conflict_group?: string | null;
          created_at?: string | null;
          evidence_kind?: string | null;
          evidence_locator?: Json | null;
          fact_status?: string | null;
          field_key?: string | null;
          is_publishable?: never;
          lot_id?: string | null;
          raw_artifact_id?: string | null;
          resolution_note?: string | null;
          resolved_at?: string | null;
          source_id?: string | null;
          source_record_id?: string | null;
          source_url?: string | null;
          updated_at?: string | null;
          value_jsonb?: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_fact_claims_artifact_extraction_id_fkey";
            columns: ["artifact_extraction_id"];
            isOneToOne: false;
            referencedRelation: "artifact_extractions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_map_pins";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_preview";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_discovery_search";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_lot_id_fkey";
            columns: ["lot_id"];
            isOneToOne: false;
            referencedRelation: "auction_lots";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_raw_artifact_id_fkey";
            columns: ["raw_artifact_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_raw_artifact_source_fk";
            columns: ["raw_artifact_id", "source_id"];
            isOneToOne: false;
            referencedRelation: "raw_artifacts";
            referencedColumns: ["id", "source_id"];
          },
          {
            foreignKeyName: "auction_fact_claims_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "data_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_fact_claims_source_record_id_fkey";
            columns: ["source_record_id"];
            isOneToOne: false;
            referencedRelation: "judicial_source_records";
            referencedColumns: ["id"];
          },
        ];
      };
      v_auction_map_pins: {
        Row: {
          app_surface_m2: number | null;
          city: string | null;
          created_at: string | null;
          department: string | null;
          id: string | null;
          investment_score: number | null;
          latitude: number | null;
          longitude: number | null;
          occupancy_status: string | null;
          property_type: string | null;
          sale_date: string | null;
          score_confidence: number | null;
          starting_price_eur: number | null;
          status: string | null;
          title: string | null;
        };
        Insert: {
          app_surface_m2?: number | null;
          city?: string | null;
          created_at?: string | null;
          department?: string | null;
          id?: string | null;
          investment_score?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          property_type?: string | null;
          sale_date?: string | null;
          score_confidence?: number | null;
          starting_price_eur?: number | null;
          status?: string | null;
          title?: string | null;
        };
        Update: {
          app_surface_m2?: number | null;
          city?: string | null;
          created_at?: string | null;
          department?: string | null;
          id?: string | null;
          investment_score?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          property_type?: string | null;
          sale_date?: string | null;
          score_confidence?: number | null;
          starting_price_eur?: number | null;
          status?: string | null;
          title?: string | null;
        };
        Relationships: [];
      };
      v_auction_sales_app: {
        Row: {
          about_description: string | null;
          address: string | null;
          adjudication_price_eur: number | null;
          analysis_status: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          documents_rich: Json | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          llm_display_description: string | null;
          longitude: number | null;
          media: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          risk_notes: string | null;
          risks: Json | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string | null;
          sale_procedure: Json | null;
          sale_venue_type: string | null;
          sale_verification_status: string | null;
          score_confidence: number | null;
          score_factors: Json | null;
          score_version: string | null;
          source_blocks: Json | null;
          source_blocks_by_source: Json | null;
          source_checks: Json | null;
          source_conflicts: Json | null;
          source_description: string | null;
          source_name: string | null;
          source_presence: Json | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_city: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      v_auction_sales_app_preview: {
        Row: {
          id: string | null;
          sale_venue_type: string | null;
          sale_verification_status: string | null;
          starting_price_eur: number | null;
        };
        Insert: {
          id?: string | null;
          sale_venue_type?: string | null;
          sale_verification_status?: string | null;
          starting_price_eur?: number | null;
        };
        Update: {
          id?: string | null;
          sale_venue_type?: string | null;
          sale_verification_status?: string | null;
          starting_price_eur?: number | null;
        };
        Relationships: [];
      };
      v_auction_sales_app_search: {
        Row: {
          about_description: string | null;
          address: string | null;
          adjudication_price_eur: number | null;
          analysis_status: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          coordinates_rank: number | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          documents_rich: Json | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          llm_display_description: string | null;
          longitude: number | null;
          media: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          risk_notes: string | null;
          risks: Json | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string | null;
          sale_procedure: Json | null;
          sale_venue_type: string | null;
          sale_verification_status: string | null;
          score_confidence: number | null;
          score_factors: Json | null;
          score_version: string | null;
          source_blocks: Json | null;
          source_blocks_by_source: Json | null;
          source_checks: Json | null;
          source_conflicts: Json | null;
          source_description: string | null;
          source_name: string | null;
          source_presence: Json | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_city: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      v_auction_sales_discovery: {
        Row: {
          about_description: string | null;
          address: string | null;
          adjudication_price_eur: number | null;
          analysis_status: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          documents_rich: Json | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          llm_display_description: string | null;
          longitude: number | null;
          media: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          risk_notes: string | null;
          risks: Json | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string | null;
          sale_procedure: Json | null;
          sale_venue_type: string | null;
          sale_verification_status: string | null;
          score_confidence: number | null;
          score_factors: Json | null;
          score_version: string | null;
          source_blocks: Json | null;
          source_blocks_by_source: Json | null;
          source_checks: Json | null;
          source_conflicts: Json | null;
          source_description: string | null;
          source_name: string | null;
          source_presence: Json | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_city: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      v_auction_sales_discovery_search: {
        Row: {
          about_description: string | null;
          address: string | null;
          adjudication_price_eur: number | null;
          analysis_status: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          coordinates_rank: number | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          documents_rich: Json | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          llm_display_description: string | null;
          longitude: number | null;
          media: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          risk_notes: string | null;
          risks: Json | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string | null;
          sale_procedure: Json | null;
          sale_venue_type: string | null;
          sale_verification_status: string | null;
          score_confidence: number | null;
          score_factors: Json | null;
          score_version: string | null;
          source_blocks: Json | null;
          source_blocks_by_source: Json | null;
          source_checks: Json | null;
          source_conflicts: Json | null;
          source_description: string | null;
          source_name: string | null;
          source_presence: Json | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_city: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
    };
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string };
        Returns: undefined;
      };
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown };
        Returns: unknown;
      };
      _postgis_pgsql_version: { Args: never; Returns: string };
      _postgis_scripts_pgsql_version: { Args: never; Returns: string };
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown };
        Returns: number;
      };
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown };
        Returns: string;
      };
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_dwithin: {
        Args: {
          geog1: unknown;
          geog2: unknown;
          tolerance: number;
          use_spheroid?: boolean;
        };
        Returns: boolean;
      };
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown };
        Returns: number;
      };
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_sortablehash: { Args: { geom: unknown }; Returns: number };
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_voronoi: {
        Args: {
          clip?: unknown;
          g1: unknown;
          return_polygons?: boolean;
          tolerance?: number;
        };
        Returns: unknown;
      };
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      abort_information_agent_evidence_publication: {
        Args: { p_fact_id: string; p_public_path: string };
        Returns: boolean;
      };
      addauth: { Args: { "": string }; Returns: boolean };
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string;
              column_name: string;
              new_dim: number;
              new_srid_in: number;
              new_type: string;
              schema_name: string;
              table_name: string;
              use_typmod?: boolean;
            };
            Returns: string;
          }
        | {
            Args: {
              column_name: string;
              new_dim: number;
              new_srid: number;
              new_type: string;
              schema_name: string;
              table_name: string;
              use_typmod?: boolean;
            };
            Returns: string;
          }
        | {
            Args: {
              column_name: string;
              new_dim: number;
              new_srid: number;
              new_type: string;
              table_name: string;
              use_typmod?: boolean;
            };
            Returns: string;
          };
      apply_reviewed_auction_notice_court_assignment: {
        Args: {
          p_auction_sale_id: string;
          p_document_page: number;
          p_document_sha256: string;
          p_document_url: string;
          p_observed_court_label: string;
        };
        Returns: {
          assigned: boolean;
          court_code: string;
          court_name: string;
        }[];
      };
      apply_stripe_subscription_state: {
        Args: {
          p_current_period_end: string;
          p_event_created: number;
          p_metadata?: Json;
          p_plan_code: string;
          p_status: string;
          p_stripe_customer_id: string;
          p_stripe_subscription_id: string;
          p_user_id: string;
        };
        Returns: {
          applied: boolean;
          reason: string;
        }[];
      };
      approve_information_agent_mission_admin: {
        Args: {
          p_admin_id: string;
          p_message_sha256: string;
          p_mission_id: string;
        };
        Returns: {
          approved_at: string;
          case_id: string;
          inbound_token: string;
          mission_id: string;
          should_send: boolean;
        }[];
      };
      approve_information_agent_mission_bounded: {
        Args: {
          p_message_sha256: string;
          p_mission_id: string;
          p_user_id: string;
        };
        Returns: {
          approved_at: string;
          case_id: string;
          inbound_token: string;
          mission_id: string;
          should_send: boolean;
          usage_count: number;
        }[];
      };
      attach_analyse_checkout_customer: {
        Args: {
          p_checkout_token: string;
          p_stripe_customer_id: string;
          p_user_id: string;
        };
        Returns: string;
      };
      auction_all_source_freshness: {
        Args: { p_now?: string };
        Returns: {
          active_listings: number;
          fresh_listings: number;
          source_name: string;
        }[];
      };
      auction_source_freshness: {
        Args: { p_now?: string; p_source: string };
        Returns: {
          active_listings: number;
          fresh_listings: number;
        }[];
      };
      begin_operational_job_run: {
        Args: { p_job_name: string };
        Returns: string;
      };
      begin_stripe_webhook_event: {
        Args: { p_event_id: string; p_event_type: string; p_livemode: boolean };
        Returns: boolean;
      };
      bridge_auction_sales_to_outcome_graph: {
        Args: never;
        Returns: {
          complete: boolean;
          created_count: number;
          linked_count: number;
          reused_count: number;
          scanned_count: number;
        }[];
      };
      bridge_auction_sales_to_outcome_graph_batch: {
        Args: { p_after_id?: string; p_limit?: number };
        Returns: {
          complete: boolean;
          created_count: number;
          has_more: boolean;
          linked_count: number;
          next_cursor: string;
          reused_count: number;
          scanned_count: number;
        }[];
      };
      catalogue_readiness_allows_premium: {
        Args: {
          p_override: string;
          p_override_expires_at: string;
          p_readiness_status: string;
        };
        Returns: boolean;
      };
      claim_auction_enrichment_jobs: {
        Args: { p_limit?: number };
        Returns: {
          attempt_count: number;
          completed_at: string | null;
          created_at: string;
          detail_source_name: string | null;
          detail_source_url: string | null;
          fact_claims_snapshot: Json | null;
          id: string;
          input_hash: string;
          job_type: string;
          last_error: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          priority: number;
          request_origin: string;
          requested_by: string | null;
          source_url: string;
          status: string;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "auction_enrichment_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_auction_enrichment_jobs_family: {
        Args: { p_family: string; p_limit?: number };
        Returns: {
          attempt_count: number;
          completed_at: string | null;
          created_at: string;
          detail_source_name: string | null;
          detail_source_url: string | null;
          fact_claims_snapshot: Json | null;
          id: string;
          input_hash: string;
          job_type: string;
          last_error: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          priority: number;
          request_origin: string;
          requested_by: string | null;
          source_url: string;
          status: string;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "auction_enrichment_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_auction_enrichment_jobs_request: {
        Args: { p_family: string; p_limit?: number; p_request_id: string };
        Returns: {
          attempt_count: number;
          completed_at: string | null;
          created_at: string;
          detail_source_name: string | null;
          detail_source_url: string | null;
          fact_claims_snapshot: Json | null;
          id: string;
          input_hash: string;
          job_type: string;
          last_error: string | null;
          locked_at: string | null;
          max_attempts: number;
          next_attempt_at: string;
          priority: number;
          request_origin: string;
          requested_by: string | null;
          source_url: string;
          status: string;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "auction_enrichment_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_auction_sale_market_estimate: {
        Args: {
          p_auction_sale_id: string;
          p_lease_seconds?: number;
          p_now?: string;
        };
        Returns: {
          actionable: boolean;
          attempt_count: number;
          auction_sale_id: string;
          comparable_count: number;
          computed_at: string | null;
          confidence_score: number | null;
          created_at: string;
          engine_kind: string | null;
          engine_version: string | null;
          error_message: string | null;
          estimate: Json | null;
          input_fingerprint: string;
          last_error_code: string | null;
          last_finished_at: string | null;
          last_started_at: string | null;
          model_version: string | null;
          model_version_id: string | null;
          next_refresh_at: string;
          priority: number;
          refresh_reason: string;
          requested_at: string | null;
          segment: string | null;
          source_updated_at: string | null;
          status: string;
          updated_at: string;
          value_p10_eur: number | null;
          value_p50_eur: number | null;
          value_p90_eur: number | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "auction_sale_market_estimates";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_auction_sale_market_estimates: {
        Args: { p_lease_seconds?: number; p_limit?: number; p_now?: string };
        Returns: {
          actionable: boolean;
          attempt_count: number;
          auction_sale_id: string;
          comparable_count: number;
          computed_at: string | null;
          confidence_score: number | null;
          created_at: string;
          engine_kind: string | null;
          engine_version: string | null;
          error_message: string | null;
          estimate: Json | null;
          input_fingerprint: string;
          last_error_code: string | null;
          last_finished_at: string | null;
          last_started_at: string | null;
          model_version: string | null;
          model_version_id: string | null;
          next_refresh_at: string;
          priority: number;
          refresh_reason: string;
          requested_at: string | null;
          segment: string | null;
          source_updated_at: string | null;
          status: string;
          updated_at: string;
          value_p10_eur: number | null;
          value_p50_eur: number | null;
          value_p90_eur: number | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "auction_sale_market_estimates";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_autonomous_pipeline_run: { Args: never; Returns: Json };
      claim_information_agent_evidence_extractions: {
        Args: { p_limit?: number };
        Returns: {
          asset_id: string;
          attempts: number;
          available_at: string;
          case_id: string;
          completed_at: string | null;
          created_at: string;
          detected_mime_type: string | null;
          document_kind: string | null;
          error_code: string | null;
          error_message: string | null;
          extracted_facts: Json;
          extracted_text: string | null;
          id: string;
          is_encrypted: boolean;
          locked_at: string | null;
          message_id: string;
          metadata: Json;
          page_count: number | null;
          pages: Json;
          processor: string;
          processor_version: string;
          sale_id: string;
          started_at: string | null;
          status: string;
          summary: string | null;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "information_agent_evidence_extractions";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_information_agent_inbound_jobs: {
        Args: { p_limit?: number; p_now?: string };
        Returns: {
          attachment_link_expires_at: string;
          attempts: number;
          available_at: string;
          case_id: string;
          created_at: string;
          id: string;
          last_error: string | null;
          lease_id: string | null;
          locked_at: string | null;
          message_id: string;
          provider_email_id: string;
          status: string;
          updated_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "information_agent_inbound_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_operational_alert_notifications: {
        Args: { p_limit?: number; p_now?: string };
        Returns: {
          alert_key: string;
          category: string;
          details: Json;
          event_type: string;
          first_seen_at: string;
          last_seen_at: string;
          notification_version: number;
          resolved_at: string;
          severity: string;
        }[];
      };
      claim_trial_card: {
        Args: { p_fingerprint_hash: string; p_user_id: string };
        Returns: boolean;
      };
      clear_auction_sale_readiness_override: {
        Args: { p_sale_id: string };
        Returns: {
          address: string | null;
          adjudication_price_eur: number | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          catalogue_expiry_deadline: string | null;
          catalogue_expiry_materialized: boolean;
          catalogue_quarantined: boolean;
          catalogue_thumbnail_url: string | null;
          city: string | null;
          content_hash: string | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          external_id: string | null;
          first_seen_at: string | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          last_run_id: string | null;
          last_seen_at: string | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          location: unknown;
          longitude: number | null;
          observations: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          premium_readiness_blockers: Json;
          premium_readiness_evaluated_at: string | null;
          premium_readiness_factors: Json;
          premium_readiness_missing_fields: Json;
          premium_readiness_override: string | null;
          premium_readiness_override_at: string | null;
          premium_readiness_override_by: string | null;
          premium_readiness_override_expires_at: string | null;
          premium_readiness_override_reason: string | null;
          premium_readiness_policy_version: string | null;
          premium_readiness_score: number | null;
          premium_readiness_status: string;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          raw_payload: Json | null;
          raw_text: string | null;
          retention_deadline: string | null;
          retention_deadline_materialized: boolean;
          risk_notes: string | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string;
          sale_procedure: Json;
          sale_venue_type: string;
          sale_verification_status: string;
          score_confidence: number | null;
          score_factors: Json;
          score_version: string | null;
          source_name: string;
          source_url: string;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        SetofOptions: {
          from: "*";
          to: "auction_sales";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      complete_operational_alert_notification: {
        Args: {
          p_alert_key: string;
          p_error_message?: string;
          p_notification_version: number;
          p_now?: string;
          p_success: boolean;
        };
        Returns: undefined;
      };
      complete_stripe_webhook_event: {
        Args: {
          p_error_message?: string;
          p_event_id: string;
          p_processing_status: string;
        };
        Returns: undefined;
      };
      consume_api_rate_limit: {
        Args: {
          p_bucket_key: string;
          p_limit: number;
          p_user_id: string;
          p_window_seconds: number;
        };
        Returns: number;
      };
      consume_information_agent_portal_upload: {
        Args: {
          p_case_id: string;
          p_size_bytes: number;
          p_storage_path: string;
        };
        Returns: undefined;
      };
      consume_ip_rate_limit: {
        Args: {
          p_bucket_key: string;
          p_ip_hash: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: number;
      };
      consume_meteostat_monthly_quota: {
        Args: { p_limit?: number; p_month_start: string };
        Returns: boolean;
      };
      decide_outcome_claim_eligibility: {
        Args: {
          p_claim_type: string;
          p_decision: string;
          p_decision_reason?: string;
          p_evidence_ids: string[];
          p_outcome_id: string;
          p_supersedes_decision_id?: string;
        };
        Returns: string;
      };
      disablelongtransactions: { Args: never; Returns: string };
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string;
              column_name: string;
              schema_name: string;
              table_name: string;
            };
            Returns: string;
          }
        | {
            Args: {
              column_name: string;
              schema_name: string;
              table_name: string;
            };
            Returns: string;
          }
        | { Args: { column_name: string; table_name: string }; Returns: string };
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string;
              schema_name: string;
              table_name: string;
            };
            Returns: string;
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string };
      enablelongtransactions: { Args: never; Returns: string };
      enforce_data_api_object_boundary: { Args: never; Returns: undefined };
      enqueue_admin_source_detail_bounded: {
        Args: { p_admin_id: string; p_force?: boolean; p_sale_id: string };
        Returns: {
          job_id: string;
          reused: boolean;
        }[];
      };
      enqueue_auction_sale_market_estimate: {
        Args: {
          p_auction_sale_id: string;
          p_now?: string;
          p_priority?: number;
          p_reason?: string;
        };
        Returns: {
          actionable: boolean;
          attempt_count: number;
          auction_sale_id: string;
          comparable_count: number;
          computed_at: string | null;
          confidence_score: number | null;
          created_at: string;
          engine_kind: string | null;
          engine_version: string | null;
          error_message: string | null;
          estimate: Json | null;
          input_fingerprint: string;
          last_error_code: string | null;
          last_finished_at: string | null;
          last_started_at: string | null;
          model_version: string | null;
          model_version_id: string | null;
          next_refresh_at: string;
          priority: number;
          refresh_reason: string;
          requested_at: string | null;
          segment: string | null;
          source_updated_at: string | null;
          status: string;
          updated_at: string;
          value_p10_eur: number | null;
          value_p50_eur: number | null;
          value_p90_eur: number | null;
        };
        SetofOptions: {
          from: "*";
          to: "auction_sale_market_estimates";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      enqueue_data_refresh_bounded: {
        Args: {
          p_force?: boolean;
          p_request_kind: string;
          p_sale_id: string;
          p_user_id: string;
        };
        Returns: {
          request_id: string;
          reused: boolean;
        }[];
      };
      enqueue_due_source_details: {
        Args: { p_limit?: number; p_now?: string };
        Returns: number;
      };
      enqueue_due_source_details_unlocked: {
        Args: { p_limit?: number; p_now?: string };
        Returns: number;
      };
      enqueue_orphan_information_agent_portal_uploads: {
        Args: { p_limit?: number; p_now?: string };
        Returns: number;
      };
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      evaluate_market_valuation_health: {
        Args: { p_now?: string };
        Returns: Json;
      };
      evaluate_operational_health: { Args: { p_now?: string }; Returns: Json };
      finalize_llm_request: {
        Args: {
          p_error_message?: string;
          p_input_tokens_estimate?: number;
          p_output_chars?: number;
          p_output_tokens_estimate?: number;
          p_prediction_id?: string;
          p_prompt_chars?: number;
          p_request_id: string;
          p_request_status: string;
          p_succeeded?: boolean;
          p_system_prompt_chars?: number;
        };
        Returns: undefined;
      };
      finish_operational_job_run: {
        Args: {
          p_error_message?: string;
          p_run_id: string;
          p_status: string;
          p_summary?: Json;
        };
        Returns: undefined;
      };
      geometry: { Args: { "": string }; Returns: unknown };
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geomfromewkt: { Args: { "": string }; Returns: unknown };
      get_public_sale_summary: {
        Args: { p_sale_id: string };
        Returns: {
          app_surface_kind: string;
          app_surface_m2: number;
          bathrooms_count: number;
          bedrooms_count: number;
          city: string;
          department: string;
          id: string;
          property_type: string;
          rooms_count: number;
          sale_date: string;
          sale_venue_type: string;
          sale_verification_status: string;
          starting_price_eur: number;
          thumbnail_url: string;
          tribunal_city: string;
          tribunal_name: string;
          updated_at: string;
        }[];
      };
      gettransactionid: { Args: never; Returns: unknown };
      grant_analysis_access_from_checkout: {
        Args: {
          p_amount_total: number;
          p_checkout_session_id: string;
          p_currency: string;
          p_duration_days?: number;
          p_paid_at: string;
          p_stripe_customer_id: string;
          p_user_id: string;
        };
        Returns: {
          access_end: string;
          granted: boolean;
        }[];
      };
      grant_analysis_access_from_payment: {
        Args: {
          p_amount_total: number;
          p_checkout_session_id: string;
          p_currency: string;
          p_duration_days?: number;
          p_event_created: number;
          p_event_id: string;
          p_paid_at: string;
          p_payment_intent_id: string;
          p_stripe_customer_id: string;
          p_user_id: string;
        };
        Returns: {
          access_end: string;
          granted: boolean;
        }[];
      };
      has_analysis_access: { Args: never; Returns: boolean };
      is_admin: { Args: never; Returns: boolean };
      list_public_sale_sitemap_entries: {
        Args: { p_limit?: number; p_offset?: number };
        Returns: {
          id: string;
          total_count: number;
          updated_at: string;
        }[];
      };
      list_reviewed_publication_aliases: {
        Args: never;
        Returns: {
          alias_sale_id: string;
          alias_source_url: string;
          canonical_sale_id: string;
          canonical_source_url: string;
          evidence: Json;
          review_key: string;
          reviewed_at: string;
          reviewed_by: string;
        }[];
      };
      longtransactionsenabled: { Args: never; Returns: boolean };
      mark_elapsed_auction_sales: { Args: never; Returns: number };
      observe_autonomous_pipeline: { Args: { p_now?: string }; Returns: Json };
      pipeline_usage_summary: { Args: never; Returns: Json };
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string };
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string };
        Returns: number;
      };
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string };
        Returns: number;
      };
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string };
        Returns: string;
      };
      postgis_extensions_upgrade: { Args: never; Returns: string };
      postgis_full_version: { Args: never; Returns: string };
      postgis_geos_version: { Args: never; Returns: string };
      postgis_lib_build_date: { Args: never; Returns: string };
      postgis_lib_revision: { Args: never; Returns: string };
      postgis_lib_version: { Args: never; Returns: string };
      postgis_libjson_version: { Args: never; Returns: string };
      postgis_liblwgeom_version: { Args: never; Returns: string };
      postgis_libprotobuf_version: { Args: never; Returns: string };
      postgis_libxml_version: { Args: never; Returns: string };
      postgis_proj_version: { Args: never; Returns: string };
      postgis_scripts_build_date: { Args: never; Returns: string };
      postgis_scripts_installed: { Args: never; Returns: string };
      postgis_scripts_released: { Args: never; Returns: string };
      postgis_svn_version: { Args: never; Returns: string };
      postgis_type_name: {
        Args: {
          coord_dimension: number;
          geomname: string;
          use_new_name?: boolean;
        };
        Returns: string;
      };
      postgis_version: { Args: never; Returns: string };
      postgis_wagyu_version: { Args: never; Returns: string };
      publish_information_agent_email_template: {
        Args: { p_admin_id: string; p_template_id: string };
        Returns: {
          blocks: Json;
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          status: string;
          subject_template: string;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "information_agent_email_templates";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      purge_expired_auction_sales: {
        Args: { p_limit?: number; p_now?: string };
        Returns: Json;
      };
      reconcile_catalogue_competent_courts: {
        Args: never;
        Returns: {
          already_correct_count: number;
          blocked_count: number;
          complete: boolean;
          corrected_count: number;
          scanned_count: number;
        }[];
      };
      reconcile_catalogue_competent_courts_batch: {
        Args: { p_after_id?: string; p_limit?: number };
        Returns: {
          already_correct_count: number;
          blocked_count: number;
          complete: boolean;
          corrected_count: number;
          has_more: boolean;
          next_cursor: string;
          scanned_count: number;
        }[];
      };
      reconcile_catalogue_court_labels: {
        Args: { p_max_sale_date: string; p_min_sale_date: string };
        Returns: {
          assigned_count: number;
          complete: boolean;
          exact_label_count: number;
          prefix_label_count: number;
          scanned_count: number;
          unresolved_count: number;
        }[];
      };
      record_autonomous_pipeline_dispatch: {
        Args: {
          p_attempt: number;
          p_error?: string;
          p_outcome: string;
          p_retry_after_at?: string;
          p_retryable?: boolean;
          p_run_id: string;
          p_status?: number;
        };
        Returns: Json;
      };
      record_stripe_payment_state: {
        Args: {
          p_entitlement_status: string;
          p_event_created: number;
          p_event_id: string;
          p_event_type: string;
          p_payment_intent_id: string;
          p_revoke_immediately?: boolean;
          p_state: string;
          p_user_id: string;
        };
        Returns: {
          effective_state: string;
          entitlement_updated: boolean;
          recorded: boolean;
        }[];
      };
      release_analyse_checkout: {
        Args: { p_checkout_token: string; p_user_id: string };
        Returns: boolean;
      };
      reserve_analyse_checkout: {
        Args: { p_checkout_token: string; p_user_id: string };
        Returns: boolean;
      };
      reserve_information_agent_portal_upload: {
        Args: {
          p_case_id: string;
          p_expires_at: string;
          p_size_bytes: number;
          p_storage_path: string;
        };
        Returns: {
          remaining_bytes: number;
          remaining_files: number;
          used_bytes: number;
          used_files: number;
        }[];
      };
      reserve_llm_request: {
        Args: {
          p_attempt_number?: number;
          p_job_id?: string;
          p_max_calls_per_hour?: number;
          p_model: string;
          p_provider: string;
          p_reason?: string;
          p_request_key?: string;
          p_request_kind: string;
          p_sale_id?: string;
          p_source_url?: string;
          p_stage?: string;
        };
        Returns: string;
      };
      reserve_pipeline_prediction:
        | { Args: { p_model: string; p_run_id: string }; Returns: string }
        | {
            Args: {
              p_input_token_ceiling: number;
              p_model: string;
              p_output_token_ceiling: number;
              p_run_id: string;
            };
            Returns: string;
          };
      review_auction_fact_claim: {
        Args: {
          p_claim_id: string;
          p_decision: string;
          p_resolution_note?: string;
          p_reviewer_id: string;
        };
        Returns: Json;
      };
      review_information_agent_fact_candidate: {
        Args: {
          p_decision: string;
          p_fact_id: string;
          p_notes?: string;
          p_reviewer_id: string;
        };
        Returns: Json;
      };
      review_information_agent_fact_candidate_with_path: {
        Args: {
          p_decision: string;
          p_expected_public_path: string;
          p_fact_id: string;
          p_notes: string;
          p_reviewer_id: string;
        };
        Returns: Json;
      };
      review_judilibre_match_candidate: {
        Args: {
          p_candidate_id: string;
          p_decision_notes: string;
          p_status: string;
        };
        Returns: string;
      };
      review_outcome_evidence: {
        Args: {
          p_decision: string;
          p_evidence_id: string;
          p_field_decisions?: Json;
          p_notes?: string;
          p_review_type: string;
        };
        Returns: string;
      };
      run_data_retention: { Args: { p_now?: string }; Returns: Json };
      save_referenced_lawyer_with_coverage: {
        Args: { p_coverage: Json; p_lawyer: Json; p_lawyer_id: string };
        Returns: {
          accepts_judicial_auctions: boolean;
          accepts_remote_contact: boolean;
          address: string | null;
          bar_association: string | null;
          bar_number: string | null;
          city: string | null;
          created_at: string;
          created_by: string | null;
          department: string | null;
          display_name: string;
          email: string | null;
          firm_name: string | null;
          id: string;
          paid_placement_ends_at: string | null;
          paid_placement_starts_at: string | null;
          paid_placement_status: string;
          phone: string | null;
          practice_tags: string[];
          priority_weight: number;
          profile_summary: string | null;
          status: string;
          updated_at: string;
          website_url: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "referenced_lawyers";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      save_sale_analysis_set: {
        Args: { p_items: Json; p_metadata: Json; p_set_id?: string };
        Returns: {
          analysis_kind: string;
          assumptions: Json;
          created_at: string;
          id: string;
          is_archived: boolean;
          name: string;
          notes: string | null;
          share_expires_at: string | null;
          share_token_hash: string | null;
          shared_at: string | null;
          shared_snapshot: Json | null;
          summary_snapshot: Json;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "user_sale_analysis_sets";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      search_auction_sales_preview: {
        Args: {
          p_city?: string;
          p_departments?: string[];
          p_east?: number;
          p_keywords?: string[];
          p_limit?: number;
          p_max_price?: number;
          p_max_surface?: number;
          p_min_bathrooms?: number;
          p_min_bedrooms?: number;
          p_min_price?: number;
          p_min_score?: number;
          p_min_surface?: number;
          p_north?: number;
          p_occupancy_status?: string;
          p_offset?: number;
          p_postal_code?: string;
          p_property_types?: string[];
          p_sort?: string;
          p_south?: number;
          p_statuses?: string[];
          p_tribunal?: string;
          p_west?: number;
        };
        Returns: {
          id: string;
          starting_price_eur: number;
          total_count: number;
        }[];
      };
      search_auction_sales_preview_v2: {
        Args: {
          p_city?: string;
          p_departments?: string[];
          p_east?: number;
          p_keywords?: string[];
          p_limit?: number;
          p_max_price?: number;
          p_max_surface?: number;
          p_min_bathrooms?: number;
          p_min_bedrooms?: number;
          p_min_price?: number;
          p_min_score?: number;
          p_min_surface?: number;
          p_north?: number;
          p_occupancy_status?: string;
          p_offset?: number;
          p_postal_code?: string;
          p_property_types?: string[];
          p_sale_venue_type?: string;
          p_sort?: string;
          p_south?: number;
          p_statuses?: string[];
          p_tribunal?: string;
          p_west?: number;
        };
        Returns: {
          id: string;
          sale_venue_type: string;
          sale_verification_status: string;
          starting_price_eur: number;
          total_count: number;
        }[];
      };
      search_auction_sales_preview_v3: {
        Args: {
          p_city?: string;
          p_departments?: string[];
          p_east?: number;
          p_keywords?: string[];
          p_limit?: number;
          p_max_price?: number;
          p_max_surface?: number;
          p_min_bathrooms?: number;
          p_min_bedrooms?: number;
          p_min_price?: number;
          p_min_score?: number;
          p_min_surface?: number;
          p_north?: number;
          p_occupancy_status?: string;
          p_offset?: number;
          p_postal_code?: string;
          p_property_types?: string[];
          p_sale_venue_type?: string;
          p_sort?: string;
          p_south?: number;
          p_statuses?: string[];
          p_tribunal?: string;
          p_west?: number;
        };
        Returns: {
          app_surface_kind: string;
          app_surface_m2: number;
          bathrooms_count: number;
          bedrooms_count: number;
          city: string;
          department: string;
          id: string;
          latitude: number;
          longitude: number;
          property_type: string;
          rooms_count: number;
          sale_date: string;
          sale_venue_type: string;
          sale_verification_status: string;
          starting_price_eur: number;
          thumbnail_url: string;
          total_count: number;
        }[];
      };
      search_auction_sales_preview_v4: {
        Args: {
          p_city?: string;
          p_departments?: string[];
          p_east?: number;
          p_keywords?: string[];
          p_limit?: number;
          p_max_price?: number;
          p_max_sale_date?: string;
          p_max_surface?: number;
          p_min_bathrooms?: number;
          p_min_bedrooms?: number;
          p_min_price?: number;
          p_min_sale_date?: string;
          p_min_score?: number;
          p_min_surface?: number;
          p_north?: number;
          p_occupancy_status?: string;
          p_offset?: number;
          p_postal_code?: string;
          p_property_types?: string[];
          p_sale_venue_type?: string;
          p_sort?: string;
          p_south?: number;
          p_statuses?: string[];
          p_tribunal?: string;
          p_west?: number;
        };
        Returns: {
          app_surface_kind: string;
          app_surface_m2: number;
          bathrooms_count: number;
          bedrooms_count: number;
          city: string;
          department: string;
          id: string;
          latitude: number;
          longitude: number;
          property_type: string;
          rooms_count: number;
          sale_date: string;
          sale_venue_type: string;
          sale_verification_status: string;
          starting_price_eur: number;
          thumbnail_url: string;
          total_count: number;
        }[];
      };
      search_dvf_market_comparables: {
        Args: {
          p_latitude: number;
          p_limit?: number;
          p_longitude: number;
          p_minimum_date: string;
          p_radius_m: number;
          p_segment: string;
        };
        Returns: {
          built_surface_m2: number;
          distance_m: number;
          dvf_property_type_code: string;
          id: string;
          land_surface_m2: number;
          latitude: number;
          longitude: number;
          mutation_nature: string;
          parcel_id: string;
          price_per_m2: number;
          property_type: string;
          sale_date: string;
          source_mutation_id: string;
          total_price_eur: number;
        }[];
      };
      set_auction_sale_readiness_override: {
        Args: {
          p_decision: string;
          p_expires_at?: string;
          p_reason: string;
          p_sale_id: string;
        };
        Returns: {
          address: string | null;
          adjudication_price_eur: number | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          catalogue_expiry_deadline: string | null;
          catalogue_expiry_materialized: boolean;
          catalogue_quarantined: boolean;
          catalogue_thumbnail_url: string | null;
          city: string | null;
          content_hash: string | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          external_id: string | null;
          first_seen_at: string | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          last_run_id: string | null;
          last_seen_at: string | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          location: unknown;
          longitude: number | null;
          observations: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          premium_readiness_blockers: Json;
          premium_readiness_evaluated_at: string | null;
          premium_readiness_factors: Json;
          premium_readiness_missing_fields: Json;
          premium_readiness_override: string | null;
          premium_readiness_override_at: string | null;
          premium_readiness_override_by: string | null;
          premium_readiness_override_expires_at: string | null;
          premium_readiness_override_reason: string | null;
          premium_readiness_policy_version: string | null;
          premium_readiness_score: number | null;
          premium_readiness_status: string;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          raw_payload: Json | null;
          raw_text: string | null;
          retention_deadline: string | null;
          retention_deadline_materialized: boolean;
          risk_notes: string | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string;
          sale_procedure: Json;
          sale_venue_type: string;
          sale_verification_status: string;
          score_confidence: number | null;
          score_factors: Json;
          score_version: string | null;
          source_name: string;
          source_url: string;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        SetofOptions: {
          from: "*";
          to: "auction_sales";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_catalogue_readiness_enforcement: {
        Args: { p_enabled: boolean };
        Returns: {
          enforcement_enabled: boolean;
          internal_only_max: number;
          minimum_score_confidence: number;
          policy_version: string;
          premium_ready_min: number;
          singleton: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        SetofOptions: {
          from: "*";
          to: "catalogue_readiness_policy";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown };
            Returns: number;
          };
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number };
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number };
        Returns: string;
      };
      st_asewkt: { Args: { "": string }; Returns: string };
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number };
            Returns: string;
          }
        | {
            Args: {
              geom_column?: string;
              maxdecimaldigits?: number;
              pretty_bool?: boolean;
              r: Record<string, unknown>;
            };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string };
      st_asgml:
        | {
            Args: {
              geog: unknown;
              id?: string;
              maxdecimaldigits?: number;
              nprefix?: string;
              options?: number;
            };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown;
              id?: string;
              maxdecimaldigits?: number;
              nprefix?: string;
              options?: number;
              version: number;
            };
            Returns: string;
          }
        | {
            Args: {
              geom: unknown;
              id?: string;
              maxdecimaldigits?: number;
              nprefix?: string;
              options?: number;
              version: number;
            };
            Returns: string;
          };
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string };
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string };
        Returns: string;
      };
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string };
      st_asmvtgeom: {
        Args: {
          bounds: unknown;
          buffer?: number;
          clip_geom?: boolean;
          extent?: number;
          geom: unknown;
        };
        Returns: unknown;
      };
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string };
      st_astext: { Args: { "": string }; Returns: string };
      st_astwkb:
        | {
            Args: {
              geom: unknown;
              prec?: number;
              prec_m?: number;
              prec_z?: number;
              with_boxes?: boolean;
              with_sizes?: boolean;
            };
            Returns: string;
          }
        | {
            Args: {
              geom: unknown[];
              ids: number[];
              prec?: number;
              prec_m?: number;
              prec_z?: number;
              with_boxes?: boolean;
              with_sizes?: boolean;
            };
            Returns: string;
          };
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number };
        Returns: string;
      };
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number };
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown };
        Returns: unknown;
      };
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number };
            Returns: unknown;
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number };
            Returns: unknown;
          };
      st_centroid: { Args: { "": string }; Returns: unknown };
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown };
        Returns: unknown;
      };
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown };
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean;
          param_geom: unknown;
          param_pctconvex: number;
        };
        Returns: unknown;
      };
      st_contains: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_coorddim: { Args: { geometry: unknown }; Returns: number };
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number };
        Returns: unknown;
      };
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number };
        Returns: unknown;
      };
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean };
            Returns: number;
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number };
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number };
            Returns: number;
          };
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_dwithin: {
        Args: {
          geog1: unknown;
          geog2: unknown;
          tolerance: number;
          use_spheroid?: boolean;
        };
        Returns: boolean;
      };
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number };
            Returns: unknown;
          }
        | {
            Args: {
              dm?: number;
              dx: number;
              dy: number;
              dz?: number;
              geom: unknown;
            };
            Returns: unknown;
          };
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown };
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number };
        Returns: unknown;
      };
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number };
        Returns: unknown;
      };
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number };
        Returns: unknown;
      };
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number };
            Returns: unknown;
          };
      st_geogfromtext: { Args: { "": string }; Returns: unknown };
      st_geographyfromtext: { Args: { "": string }; Returns: unknown };
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string };
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown };
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean;
          g: unknown;
          max_iter?: number;
          tolerance?: number;
        };
        Returns: unknown;
      };
      st_geometryfromtext: { Args: { "": string }; Returns: unknown };
      st_geomfromewkt: { Args: { "": string }; Returns: unknown };
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown };
      st_geomfromgml: { Args: { "": string }; Returns: unknown };
      st_geomfromkml: { Args: { "": string }; Returns: unknown };
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown };
      st_geomfromtext: { Args: { "": string }; Returns: unknown };
      st_gmltosql: { Args: { "": string }; Returns: unknown };
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean };
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number };
        Returns: unknown;
      };
      st_hexagongrid: {
        Args: { bounds: unknown; size: number };
        Returns: Record<string, unknown>[];
      };
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown };
        Returns: number;
      };
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number };
        Returns: unknown;
      };
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown };
        Returns: Database["public"]["CompositeTypes"]["valid_detail"];
        SetofOptions: {
          from: "*";
          to: "valid_detail";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number };
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown };
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown };
        Returns: number;
      };
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string };
        Returns: unknown;
      };
      st_linefromtext: { Args: { "": string }; Returns: unknown };
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown };
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number };
        Returns: unknown;
      };
      st_locatebetween: {
        Args: {
          frommeasure: number;
          geometry: unknown;
          leftrightoffset?: number;
          tomeasure: number;
        };
        Returns: unknown;
      };
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number };
        Returns: unknown;
      };
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_makevalid: {
        Args: { geom: unknown; params: string };
        Returns: unknown;
      };
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number };
        Returns: unknown;
      };
      st_mlinefromtext: { Args: { "": string }; Returns: unknown };
      st_mpointfromtext: { Args: { "": string }; Returns: unknown };
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown };
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown };
      st_multipointfromtext: { Args: { "": string }; Returns: unknown };
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown };
      st_node: { Args: { g: unknown }; Returns: unknown };
      st_normalize: { Args: { geom: unknown }; Returns: unknown };
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string };
        Returns: unknown;
      };
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean };
        Returns: number;
      };
      st_pointfromtext: { Args: { "": string }; Returns: unknown };
      st_pointm: {
        Args: {
          mcoordinate: number;
          srid?: number;
          xcoordinate: number;
          ycoordinate: number;
        };
        Returns: unknown;
      };
      st_pointz: {
        Args: {
          srid?: number;
          xcoordinate: number;
          ycoordinate: number;
          zcoordinate: number;
        };
        Returns: unknown;
      };
      st_pointzm: {
        Args: {
          mcoordinate: number;
          srid?: number;
          xcoordinate: number;
          ycoordinate: number;
          zcoordinate: number;
        };
        Returns: unknown;
      };
      st_polyfromtext: { Args: { "": string }; Returns: unknown };
      st_polygonfromtext: { Args: { "": string }; Returns: unknown };
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown };
        Returns: unknown;
      };
      st_quantizecoordinates: {
        Args: {
          g: unknown;
          prec_m?: number;
          prec_x: number;
          prec_y?: number;
          prec_z?: number;
        };
        Returns: unknown;
      };
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number };
        Returns: unknown;
      };
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string };
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number };
        Returns: unknown;
      };
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown };
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number };
        Returns: unknown;
      };
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown };
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number };
        Returns: unknown;
      };
      st_squaregrid: {
        Args: { bounds: unknown; size: number };
        Returns: Record<string, unknown>[];
      };
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number };
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number };
        Returns: unknown[];
      };
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown };
        Returns: unknown;
      };
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number };
        Returns: unknown;
      };
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_tileenvelope: {
        Args: {
          bounds?: unknown;
          margin?: number;
          x: number;
          y: number;
          zoom: number;
        };
        Returns: unknown;
      };
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string };
            Returns: unknown;
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number };
            Returns: unknown;
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown };
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown };
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number };
            Returns: unknown;
          };
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown };
      st_wkttosql: { Args: { "": string }; Returns: unknown };
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number };
        Returns: unknown;
      };
      stage_information_agent_evidence_publication: {
        Args: { p_fact_id: string; p_public_path: string; p_public_url: string };
        Returns: Json;
      };
      subscribe_information_agent_mission: {
        Args: { p_mission_id: string; p_user_id: string };
        Returns: {
          case_id: string;
          case_status: string;
          inbound_token: string;
          mission_status: string;
        }[];
      };
      unlockrows: { Args: { "": string }; Returns: number };
      updategeometrysrid: {
        Args: {
          catalogn_name: string;
          column_name: string;
          new_srid_in: number;
          schema_name: string;
          table_name: string;
        };
        Returns: string;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null;
        geom: unknown;
      };
      valid_detail: {
        valid: boolean | null;
        reason: string | null;
        location: unknown;
      };
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
