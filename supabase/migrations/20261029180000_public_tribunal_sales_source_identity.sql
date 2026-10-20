begin;

set local lock_timeout = '5s';

-- Pages /tribunaux/[slug] : de quoi ne dédoublonner la liste que sur une identité certaine.
--
-- Une vente publiée par deux sources n'est pas encore fusionnée dans toutes les fiches : la page d'un
-- tribunal la listait deux fois (et comptait deux fois). L'application écarte désormais le doublon avec
-- la règle de la page « Audiences à venir » (dedupeHearings) : le même identifiant d'annonce, ou une
-- adresse source (source_url, source_urls) en commun. La fonction rend donc ces deux colonnes, déjà
-- publiques (lien « Voir l'annonce d'origine » des fiches et des cartes, et même contrat que
-- get_public_upcoming_hearings depuis 20261028160100). Rien d'autre ne change : ni la règle de
-- visibilité, ni l'ordre, ni la borne de p_limit. Aucune adresse postale, coordonnée, contact ni
-- document ne sort.
--
-- Le type de retour change : les fonctions sont recréées (public d'abord, puis app_private) avec les
-- mêmes droits qu'en 20261028150000. L'application sait lire l'ancienne forme (colonnes absentes) :
-- l'ordre d'application migration / déploiement est libre.

drop function if exists public.get_public_tribunal_sales(text, integer);
drop function if exists app_private.get_public_tribunal_sales(text, integer);

create function app_private.get_public_tribunal_sales(
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
  status text,
  source_url text,
  source_urls jsonb
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
    coalesce(s.status, 'unknown'),
    s.source_url,
    s.source_urls
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

create function public.get_public_tribunal_sales(
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
  status text,
  source_url text,
  source_urls jsonb
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
