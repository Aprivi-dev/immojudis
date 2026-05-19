-- =====================================================================
-- Mise à jour de v_auction_sales_app pour exposer :
--  - les nouvelles colonnes pipeline (app_surface_m2, surface_*, bathrooms/parking,
--    primary_source, tribunal_code, quality_flags)
--  - le tribunal canonique (LEFT JOIN public.tribunals)
--  - les risques agrégés depuis public.auction_risks
--  - les documents enrichis agrégés depuis public.auction_documents
--
-- À exécuter dans le SQL editor Supabase après la migration du pipeline.
-- =====================================================================

DROP VIEW IF EXISTS public.v_auction_sales_app;

CREATE VIEW public.v_auction_sales_app AS
SELECT
    s.id,
    s.title,
    s.city,
    s.department,
    s.postal_code,
    s.address,
    s.tribunal,
    s.tribunal_code,
    t.canonical_name      AS tribunal_name,
    t.city                AS tribunal_city,
    s.property_type,
    s.starting_price_eur,
    s.sale_date,
    s.latitude,
    s.longitude,
    s.occupancy_status,

    -- Surfaces
    s.habitable_surface_m2,
    s.carrez_surface_m2,
    s.land_surface_m2,
    s.app_surface_m2,
    s.app_surface_kind,
    s.surface_scope,
    s.surface_source,
    s.surface_confidence,
    s.surface_evidence,

    -- Composition
    s.rooms_count,
    s.bedrooms_count,
    s.bathrooms_count,
    s.parking_count,

    -- Features
    s.has_garden,
    s.has_terrace,
    s.has_garage,
    s.has_pool,
    s.has_air_conditioning,
    s.has_double_glazing,

    -- Scoring
    s.investment_score,
    s.investment_summary,
    s.score_version,
    s.risk_notes,

    -- Sources / dédup
    s.source_name,
    s.source_url,
    s.primary_source,
    s.source_urls,
    s.dedupe_confidence,
    s.quality_flags,

    -- Documents legacy (compat)
    s.documents,

    -- Risques agrégés
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'risk_type', r.risk_type,
            'risk_label', r.risk_label,
            'severity', r.severity,
            'evidence', r.evidence
          )
          ORDER BY r.severity DESC NULLS LAST
        )
        FROM public.auction_risks r
        WHERE r.source_url = s.source_url
      ),
      '[]'::jsonb
    ) AS risks,

    -- Documents enrichis agrégés
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'url', d.document_url,
            'label', d.label,
            'type', d.document_type,
            'extraction_status', d.extraction_status
          )
          ORDER BY d.label NULLS LAST
        )
        FROM public.auction_documents d
        WHERE d.source_url = s.source_url
      ),
      '[]'::jsonb
    ) AS documents_rich,

    s.status,
    s.created_at,
    s.updated_at
FROM public.auction_sales s
LEFT JOIN public.tribunals t ON t.code = s.tribunal_code
WHERE s.status IN ('upcoming', 'unknown')
  AND s.latitude  IS NOT NULL
  AND s.longitude IS NOT NULL;

GRANT SELECT ON public.v_auction_sales_app TO anon, authenticated;

-- (RLS de auction_sales / auction_risks / auction_documents : conservez la
-- policy "public_read" sur auction_sales. Pour les tables risques/documents,
-- la vue tourne en SECURITY INVOKER : ajoutez des policies SELECT si besoin.)

ALTER TABLE IF EXISTS public.auction_risks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auction_risks_public_read" ON public.auction_risks;
CREATE POLICY "auction_risks_public_read"
    ON public.auction_risks FOR SELECT
    TO anon, authenticated
    USING (true);

ALTER TABLE IF EXISTS public.auction_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auction_documents_public_read" ON public.auction_documents;
CREATE POLICY "auction_documents_public_read"
    ON public.auction_documents FOR SELECT
    TO anon, authenticated
    USING (true);

ALTER TABLE IF EXISTS public.tribunals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tribunals_public_read" ON public.tribunals;
CREATE POLICY "tribunals_public_read"
    ON public.tribunals FOR SELECT
    TO anon, authenticated
    USING (true);