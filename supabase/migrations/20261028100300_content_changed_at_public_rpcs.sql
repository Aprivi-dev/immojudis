begin;

set local lock_timeout = '5s';

-- 3/3 de « date de modification fiable des fiches » (contexte dans 20261028100100). Suppose la colonne
-- content_changed_at (100100) ; le déclencheur (100200) la renseigne.
--
-- Deux fonctions publiques exposaient `updated_at` (date technique de la ligne, qui bouge à chaque
-- passage de la collecte) et ce champ alimentait `lastmod` du sitemap et `dateModified` du JSON-LD :
--   - list_public_sale_sitemap_entries (le sitemap des fiches) ;
--   - get_public_sale_summary (la fiche publique).
-- Elles rendent désormais `content_changed_at` À LA PLACE de `updated_at` : la colonne technique ne sort
-- plus de la base. Une fiche sans changement visible depuis la pose a une date nulle, et le site n'émet
-- alors aucune date.
--
-- Les signatures changent (une colonne de sortie remplacée), donc les fonctions sont supprimées puis
-- recréées, avec les mêmes droits qu'avant. Les corps reprennent à l'identique ceux de
-- 20261025120000 (sitemap) et 20261011100100 (fiche) tels que 20261027100200 les a réécrits : même
-- prédicat de visibilité, sur les colonnes matérialisées (statut, quarantaine, date limite ou repli),
-- et, pour le sitemap, même prédicat d'indexabilité (app_private.is_indexable_public_sale).
-- Le test supabase/tests/470_… compare la visibilité de ces fonctions à celle des vues ; le 473 vérifie
-- les nouvelles colonnes.
--
-- Déploiement : le code lit `content_changed_at` et, s'il est absent (fonctions pas encore remplacées),
-- n'émet aucune date : l'ordre de déploiement du site et de cette migration est sans importance.

drop function if exists public.list_public_sale_sitemap_entries(integer, integer);
drop function if exists app_private.list_public_sale_sitemap_entries(integer, integer);
drop function if exists public.get_public_sale_summary(uuid);
drop function if exists app_private.get_public_sale_summary(uuid);

create function app_private.list_public_sale_sitemap_entries(
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  id uuid,
  content_changed_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(p_limit, 1000) < 1
    or coalesce(p_limit, 1000) > 5000
    or coalesce(p_offset, 0) < 0
    or coalesce(p_offset, 0) > 200000 then
    raise exception using errcode = '22023', message = 'Invalid sitemap pagination.';
  end if;

  return query
  with visible as (
    select s.id, s.content_changed_at
    from public.auction_sales s
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
      and app_private.sale_catalogue_projection_is_live(
        s.catalogue_expiry_materialized,
        s.catalogue_expiry_deadline,
        s.sale_date,
        s.catalogue_expiry_fallback,
        s.catalogue_state_observed_at,
        s.catalogue_state_end_estimate
      )
      and (not s.catalogue_quarantined)
      and app_private.is_indexable_public_sale(
        s.city,
        s.sale_date::timestamptz,
        s.property_type,
        s.app_surface_m2::numeric,
        s.starting_price_eur::numeric,
        s.quality_flags,
        s.primary_source,
        s.sale_venue_type,
        char_length(s.description),
        case
          when exists (
            select 1 from public.auction_documents ad where ad.source_url = s.source_url
          ) then 1
          else 0
        end
      )
  )
  select visible.id, visible.content_changed_at::timestamptz, count(*) over () as total_count
  from visible
  order by visible.id
  limit coalesce(p_limit, 1000)
  offset coalesce(p_offset, 0);
end;
$function$;

revoke all on function app_private.list_public_sale_sitemap_entries(integer, integer)
  from public, anon, authenticated;
grant execute on function app_private.list_public_sale_sitemap_entries(integer, integer)
  to anon, authenticated, service_role;

create function public.list_public_sale_sitemap_entries(
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  id uuid,
  content_changed_at timestamptz,
  total_count bigint
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.list_public_sale_sitemap_entries(p_limit, p_offset);
$function$;

revoke all on function public.list_public_sale_sitemap_entries(integer, integer) from public;
grant execute on function public.list_public_sale_sitemap_entries(integer, integer)
  to anon, authenticated, service_role;

create function app_private.get_public_sale_summary(p_sale_id uuid)
returns table (
  id uuid,
  starting_price_eur numeric,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  tribunal_name text,
  tribunal_city text,
  thumbnail_url text,
  content_changed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.id,
    s.starting_price_eur::numeric,
    s.sale_venue_type,
    s.sale_verification_status,
    s.city,
    s.department,
    s.property_type,
    s.sale_date::timestamptz,
    s.app_surface_m2::numeric,
    s.app_surface_kind,
    s.rooms_count::integer,
    s.bedrooms_count::integer,
    s.bathrooms_count::integer,
    case
      when s.sale_venue_type = 'tribunal' then coalesce(t.canonical_name, s.tribunal)
    end as tribunal_name,
    case
      when s.sale_venue_type = 'tribunal' then t.city
    end as tribunal_city,
    case
      when s.raw_payload->>'raw_image_url' ~* '^https?://'
        and length(s.raw_payload->>'raw_image_url') <= 2048
        then s.raw_payload->>'raw_image_url'
    end as thumbnail_url,
    s.content_changed_at::timestamptz
  from public.auction_sales s
  left join public.tribunals t on t.code = s.tribunal_code
  where s.id = p_sale_id
    and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and app_private.sale_catalogue_projection_is_live(
      s.catalogue_expiry_materialized,
      s.catalogue_expiry_deadline,
      s.sale_date,
      s.catalogue_expiry_fallback,
      s.catalogue_state_observed_at,
      s.catalogue_state_end_estimate
    )
    and (not s.catalogue_quarantined);
$function$;

revoke all on function app_private.get_public_sale_summary(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_summary(uuid)
  to anon, authenticated, service_role;

create function public.get_public_sale_summary(p_sale_id uuid)
returns table (
  id uuid,
  starting_price_eur numeric,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  tribunal_name text,
  tribunal_city text,
  thumbnail_url text,
  content_changed_at timestamptz
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_sale_summary(p_sale_id);
$function$;

revoke all on function public.get_public_sale_summary(uuid) from public;
grant execute on function public.get_public_sale_summary(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
