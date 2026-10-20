begin;

set local lock_timeout = '5s';

-- Fiche publique d'une vente : le tribunal devient un lien vers sa page (/tribunaux/[slug]).
--
-- La page d'un tribunal a pour adresse le code du tribunal (public.tribunals.code), déjà public dans
-- get_public_tribunal_activity et dans le référentiel public des tribunaux. La fiche publique ne
-- rendait que le nom et la ville : get_public_sale_summary rend aussi tribunal_code, pour une vente au
-- tribunal dont le tribunal est connu du référentiel (même jointure que tribunal_name et
-- tribunal_city), jamais pour une vente d'un autre type. Rien d'autre ne change : le corps reprend à
-- l'identique celui de 20261028100300 (même prédicat de visibilité, même content_changed_at en
-- dernière colonne), seule la colonne tribunal_code est ajoutée après tribunal_city.
--
-- Le type de retour change : les fonctions sont recréées (public d'abord, puis app_private) avec les
-- mêmes droits qu'avant. L'application sait lire l'ancienne forme (colonne absente : le tribunal
-- reste un texte simple) : l'ordre d'application migration / déploiement est libre.

drop function if exists public.get_public_sale_summary(uuid);
drop function if exists app_private.get_public_sale_summary(uuid);

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
  tribunal_code text,
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
      when s.sale_venue_type = 'tribunal' then t.code
    end as tribunal_code,
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
  tribunal_code text,
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
