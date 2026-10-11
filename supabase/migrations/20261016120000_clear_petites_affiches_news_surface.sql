begin;

set local lock_timeout = '5s';

-- On 11/10/2026 the Petites Affiches pages gained a « News » column. One of its
-- headlines (« un local commercial de 1 273 m² à Cap d'Ail ») was read as the
-- surface of every Petites Affiches sale collected that evening (about 450
-- listings showing 1 273 m²). The scraper now ignores those headlines; this
-- clears the false surface so the listings show « surface n.c. » until the next
-- collection reads the real one. A copy is kept in app_private.
create table if not exists app_private.petites_affiches_news_surface_backup_20261011 (
  source_url text primary key,
  surface_m2 numeric,
  app_surface_m2 numeric,
  app_surface_kind text,
  surface_source text,
  surface_evidence text,
  backed_up_at timestamptz not null default now()
);
revoke all on app_private.petites_affiches_news_surface_backup_20261011
  from public, anon, authenticated;

insert into app_private.petites_affiches_news_surface_backup_20261011
  (source_url, surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_evidence)
select s.source_url, s.surface_m2, s.app_surface_m2, s.app_surface_kind, s.surface_source, s.surface_evidence
  from public.auction_sales s
 where s.source_name = 'petites_affiches'
   and (s.surface_m2 = 1273 or s.app_surface_m2 = 1273)
on conflict (source_url) do nothing;

update public.auction_sales s
   set surface_m2 = null,
       app_surface_m2 = case when s.app_surface_m2 = 1273 then null else s.app_surface_m2 end,
       app_surface_kind = case when s.app_surface_m2 = 1273 then null else s.app_surface_kind end,
       surface_source = null,
       surface_evidence = null
 where s.source_name = 'petites_affiches'
   and (s.surface_m2 = 1273 or s.app_surface_m2 = 1273);

commit;
