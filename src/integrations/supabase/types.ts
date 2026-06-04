export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      auction_documents: {
        Row: {
          created_at: string;
          document_type: string | null;
          document_url: string;
          extraction_status: string | null;
          id: string;
          label: string | null;
          source_url: string;
        };
        Insert: {
          created_at?: string;
          document_type?: string | null;
          document_url: string;
          extraction_status?: string | null;
          id?: string;
          label?: string | null;
          source_url: string;
        };
        Update: {
          created_at?: string;
          document_type?: string | null;
          document_url?: string;
          extraction_status?: string | null;
          id?: string;
          label?: string | null;
          source_url?: string;
        };
        Relationships: [];
      };
      auction_risks: {
        Row: {
          created_at: string;
          evidence: string | null;
          id: string;
          risk_label: string | null;
          risk_type: string | null;
          severity: number | null;
          source_url: string;
        };
        Insert: {
          created_at?: string;
          evidence?: string | null;
          id?: string;
          risk_label?: string | null;
          risk_type?: string | null;
          severity?: number | null;
          source_url: string;
        };
        Update: {
          created_at?: string;
          evidence?: string | null;
          id?: string;
          risk_label?: string | null;
          risk_type?: string | null;
          severity?: number | null;
          source_url?: string;
        };
        Relationships: [];
      };
      auction_sales: {
        Row: {
          address: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string;
          dedupe_confidence: string | null;
          department: string | null;
          documents: Json | null;
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
          latitude: number | null;
          longitude: number | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          risk_notes: string | null;
          rooms_count: number | null;
          sale_date: string | null;
          score_version: string | null;
          source_name: string | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_code: string | null;
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
          dedupe_confidence?: string | null;
          department?: string | null;
          documents?: Json | null;
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
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          risk_notes?: string | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          score_version?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          source_urls?: Json | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
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
          dedupe_confidence?: string | null;
          department?: string | null;
          documents?: Json | null;
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
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          risk_notes?: string | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          score_version?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          source_urls?: Json | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      tribunals: {
        Row: {
          canonical_name: string | null;
          city: string | null;
          code: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          canonical_name?: string | null;
          city?: string | null;
          code: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          canonical_name?: string | null;
          city?: string | null;
          code?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_alerts: {
        Row: {
          city: string | null;
          created_at: string;
          department: string | null;
          id: string;
          is_active: boolean;
          max_price_eur: number | null;
          min_investment_score: number | null;
          min_surface_m2: number | null;
          name: string;
          occupancy_status: string | null;
          property_type: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_active?: boolean;
          max_price_eur?: number | null;
          min_investment_score?: number | null;
          min_surface_m2?: number | null;
          name: string;
          occupancy_status?: string | null;
          property_type?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_active?: boolean;
          max_price_eur?: number | null;
          min_investment_score?: number | null;
          min_surface_m2?: number | null;
          name?: string;
          occupancy_status?: string | null;
          property_type?: string | null;
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
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      v_auction_sales_app: {
        Row: {
          address: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
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
          score_confidence: number | null;
          score_factors: Json | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          longitude: number | null;
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
          score_version: string | null;
          source_name: string | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_city: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
          updated_at: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
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
