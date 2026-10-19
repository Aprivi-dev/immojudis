begin;

set local lock_timeout = '5s';

-- Pages /tribunaux/[slug] : les prochaines ventes d'UN tribunal, lues par un visiteur sans compte.
--
-- get_public_tribunal_activity() ne rend que des totaux par tribunal ; la recherche publique
-- (search_auction_sales_preview_v3) filtre sur le tribunal par un « like » sur une concaténation de
-- libellés, qui ne désigne pas un tribunal à coup sûr. Cette fonction lit les ventes d'un tribunal
-- par son code (égalité exacte sur auction_sales.tribunal_code), avec la règle de visibilité
-- publique de tout le catalogue : app_private.auction_sale_is_publicly_visible(), la même que celle
-- de l'activité par tribunal (statut à venir, reporté ou inconnu, annonce encore en ligne, hors
-- quarantaine). Le compte de lignes d'un tribunal est donc celui de get_public_tribunal_activity().
--
-- Seules les ventes au tribunal sont rendues (comme l'activité). Contrat public, identique à celui
-- des cartes de la recherche : commune, département, type de bien, date, mise à prix, surface,
-- statut. Ni adresse, ni coordonnées, ni documents, ni contacts, ni texte de l'annonce.
--
-- Ordre : d'abord les ventes dont la date n'est pas passée, de la plus proche à la plus lointaine,
-- puis les autres (date passée ou absente). p_limit est borné à 1..100.

create or replace function app_private.get_public_tribunal_sales(
  p_tribunal_code text,
  p_limit integer default 30
)
returns table (
  id uuid,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  starting_price_eur numeric,
  surface_m2 numeric,
  status text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.id,
    s.city,
    s.department,
    s.property_type,
    s.sale_date::timestamptz,
    s.starting_price_eur::numeric,
    s.app_surface_m2::numeric,
    coalesce(s.status, 'unknown')
  from public.auction_sales s
  where s.tribunal_code = p_tribunal_code
    and s.sale_venue_type = 'tribunal'
    and app_private.auction_sale_is_publicly_visible(s.id)
  order by
    (s.sale_date is null or s.sale_date < statement_timestamp()),
    s.sale_date,
    s.id
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$function$;

revoke all on function app_private.get_public_tribunal_sales(text, integer)
  from public, anon, authenticated;
grant execute on function app_private.get_public_tribunal_sales(text, integer)
  to anon, authenticated, service_role;

create or replace function public.get_public_tribunal_sales(
  p_tribunal_code text,
  p_limit integer default 30
)
returns table (
  id uuid,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  starting_price_eur numeric,
  surface_m2 numeric,
  status text
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_tribunal_sales(p_tribunal_code, p_limit);
$function$;

revoke all on function public.get_public_tribunal_sales(text, integer) from public;
grant execute on function public.get_public_tribunal_sales(text, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
