begin;
select plan(5);

select has_column('public', 'v_auction_sales_discovery', 'document_count', 'discovery view exposes the document count');

select is(
  (select pg_get_viewdef('public.v_auction_sales_discovery'::regclass) ~ 's\.documents\b'),
  false,
  'discovery view never exposes the documents themselves'
);

select is(
  (select pg_get_viewdef('public.v_auction_sales_discovery'::regclass) ~ 's\.source_url AS source_url'),
  false,
  'discovery view keeps the source URL private'
);

-- Depuis 20261124100000, la ré-indexation est faite par app_private.source_checks_without_listing_source,
-- qui retire aussi le nom de la plateforme des valeurs (détail : supabase/tests/902).
select ok(
  (select pg_get_viewdef('public.v_auction_sales_discovery'::regclass)
            ~ 'app_private\.source_checks_without_listing_source\(')
  and app_private.source_checks_without_listing_source(
        '{"https://annonce.example/vente/450": {"checked_at": "2026-11-01T08:00:00+00:00"}}'::jsonb
      ) = '{"source_1": {"checked_at": "2026-11-01T08:00:00+00:00"}}'::jsonb,
  'source checks are re-keyed by an opaque rank instead of the listing URL'
);

select ok(
  (select reloptions @> array['security_barrier=true'] from pg_class where oid = 'public.v_auction_sales_discovery'::regclass),
  'discovery view keeps its security barrier'
);

select * from finish();
rollback;
