-- =====================================================================
-- Immojudis — Setup SQL pour l'app web
-- À exécuter dans le SQL editor du projet Supabase.
-- Suppose que la table public.auction_sales existe déjà (pipeline scraping).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. INDEX sur auction_sales (créés si absents)
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_auction_sales_status            ON public.auction_sales(status);
CREATE INDEX IF NOT EXISTS idx_auction_sales_department        ON public.auction_sales(department);
CREATE INDEX IF NOT EXISTS idx_auction_sales_city              ON public.auction_sales(city);
CREATE INDEX IF NOT EXISTS idx_auction_sales_property_type     ON public.auction_sales(property_type);
CREATE INDEX IF NOT EXISTS idx_auction_sales_sale_date         ON public.auction_sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_auction_sales_starting_price    ON public.auction_sales(starting_price_eur);
CREATE INDEX IF NOT EXISTS idx_auction_sales_score             ON public.auction_sales(investment_score);
CREATE INDEX IF NOT EXISTS idx_auction_sales_latlng            ON public.auction_sales(latitude, longitude);

-- ---------------------------------------------------------------------
-- 2. VUE applicative
-- Filtre : status IN ('upcoming','unknown') AND lat/lng NOT NULL
-- Multi-sources : on conserve Avoventes, Licitor et toute autre source.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_auction_sales_app AS
SELECT
    id,
    title,
    city,
    department,
    postal_code,
    address,
    tribunal,
    property_type,
    starting_price_eur,
    sale_date,
    latitude,
    longitude,
    occupancy_status,
    habitable_surface_m2,
    carrez_surface_m2,
    land_surface_m2,
    rooms_count,
    bedrooms_count,
    has_garden,
    has_terrace,
    has_garage,
    has_pool,
    has_air_conditioning,
    has_double_glazing,
    investment_score,
    investment_summary,
    risk_notes,
    source_name,
    source_url,
    documents,
    status,
    created_at,
    updated_at
FROM public.auction_sales
WHERE status IN ('upcoming', 'unknown')
  AND latitude  IS NOT NULL
  AND longitude IS NOT NULL;

-- Permettre la lecture publique de la vue (anon + authenticated)
GRANT SELECT ON public.v_auction_sales_app TO anon, authenticated;

-- Lecture publique de la table sous-jacente (la vue ne s'évalue pas avec
-- les droits du créateur en SECURITY INVOKER par défaut). On garde RLS
-- activée sur auction_sales et on ouvre uniquement le SELECT.
ALTER TABLE public.auction_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auction_sales_public_read" ON public.auction_sales;
CREATE POLICY "auction_sales_public_read"
    ON public.auction_sales FOR SELECT
    TO anon, authenticated
    USING (true);
-- (Pas de policy INSERT/UPDATE/DELETE pour anon/authenticated → écriture
-- réservée au service_role qui bypass RLS, donc au pipeline de scraping.)

-- ---------------------------------------------------------------------
-- 3. user_favorites
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_favorites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    sale_id     uuid NOT NULL REFERENCES public.auction_sales(id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, sale_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON public.user_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_user_favorites_sale ON public.user_favorites(sale_id);

ALTER TABLE public.user_favorites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "favorites_select_own"  ON public.user_favorites;
DROP POLICY IF EXISTS "favorites_insert_own"  ON public.user_favorites;
DROP POLICY IF EXISTS "favorites_delete_own"  ON public.user_favorites;

CREATE POLICY "favorites_select_own"
    ON public.user_favorites FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "favorites_insert_own"
    ON public.user_favorites FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "favorites_delete_own"
    ON public.user_favorites FOR DELETE
    TO authenticated
    USING (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 4. user_alerts
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_alerts (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name                  text NOT NULL,
    department            text,
    city                  text,
    property_type         text,
    max_price_eur         numeric,
    min_surface_m2        numeric,
    occupancy_status      text,
    min_investment_score  numeric,
    is_active             boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_alerts_user   ON public.user_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_alerts_active ON public.user_alerts(is_active);

ALTER TABLE public.user_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alerts_select_own" ON public.user_alerts;
DROP POLICY IF EXISTS "alerts_insert_own" ON public.user_alerts;
DROP POLICY IF EXISTS "alerts_update_own" ON public.user_alerts;
DROP POLICY IF EXISTS "alerts_delete_own" ON public.user_alerts;

CREATE POLICY "alerts_select_own"
    ON public.user_alerts FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY "alerts_insert_own"
    ON public.user_alerts FOR INSERT
    TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "alerts_update_own"
    ON public.user_alerts FOR UPDATE
    TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "alerts_delete_own"
    ON public.user_alerts FOR DELETE
    TO authenticated
    USING (user_id = auth.uid());

-- =====================================================================
-- FIN
-- =====================================================================
