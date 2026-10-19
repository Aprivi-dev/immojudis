begin;

set local lock_timeout = '5s';

-- Page publique /audiences-a-venir : de quoi ne fusionner deux lignes que sur une identité certaine.
--
-- Jusqu'ici l'appelant fusionnait deux audiences du même tribunal, du même jour et de la même mise à
-- prix, ce qui pouvait réunir à tort deux lots distincts. La fusion ne se fait plus que sur le même
-- identifiant d'annonce ou sur des adresses sources (source_url, source_urls) en commun : la fonction
-- rend donc ces deux colonnes, déjà publiques (lien « Voir l'annonce d'origine » des fiches et cartes
-- du catalogue). Rien d'autre ne change : ni la règle de « date sourcée » (get_public_sale_calendar_event),
-- ni la fenêtre, ni la limite de 1 000 lignes. Aucune adresse postale, coordonnée, contact ou document
-- ne sort : l'adresse précise n'est pas rendue (ni sous forme d'empreinte).
--
-- Le type de retour change : les fonctions sont recréées (public d'abord, puis app_private) avec les
-- mêmes droits qu'en 20261028150100. L'application sait lire l'ancienne forme (colonnes absentes) :
-- l'ordre d'application migration / déploiement est libre.

drop function if exists public.get_public_upcoming_hearings(integer);
drop function if exists app_private.get_public_upcoming_hearings(integer);

create function app_private.get_public_upcoming_hearings(p_days integer default 30)
returns table (
  id uuid,
  sale_date timestamptz,
  date_only boolean,
  property_type text,
  city text,
  department text,
  tribunal_code text,
  tribunal_name text,
  tribunal_city text,
  starting_price_eur numeric,
  source_url text,
  source_urls jsonb,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  with bounds as (
    select
      (statement_timestamp() at time zone 'Europe/Paris')::date as today,
      least(greatest(coalesce(p_days, 30), 1), 60) as days
  ),
  hearings as (
    select
      e.id,
      e.sale_date,
      e.date_only,
      e.property_type,
      e.city,
      s.department,
      s.tribunal_code,
      e.tribunal_name,
      e.tribunal_city,
      s.starting_price_eur::numeric as starting_price_eur,
      s.source_url,
      s.source_urls
    from bounds b
    join public.auction_sales s
      on s.sale_venue_type = 'tribunal'
     and s.status = 'upcoming'
     and s.sale_date >= statement_timestamp() - interval '2 days'
     and s.sale_date < statement_timestamp() + (b.days + 2) * interval '1 day'
    cross join lateral app_private.get_public_sale_calendar_event(s.id) e
    where e.exportable
      and (e.sale_date at time zone 'Europe/Paris')::date between b.today and b.today + b.days
  )
  select
    h.id,
    h.sale_date,
    h.date_only,
    h.property_type,
    h.city,
    h.department,
    h.tribunal_code,
    h.tribunal_name,
    h.tribunal_city,
    h.starting_price_eur,
    h.source_url,
    h.source_urls,
    count(*) over () as total_count
  from hearings h
  order by h.sale_date, h.tribunal_name, h.id
  limit 1000;
$function$;

revoke all on function app_private.get_public_upcoming_hearings(integer)
  from public, anon, authenticated;
grant execute on function app_private.get_public_upcoming_hearings(integer)
  to anon, authenticated, service_role;

create function public.get_public_upcoming_hearings(p_days integer default 30)
returns table (
  id uuid,
  sale_date timestamptz,
  date_only boolean,
  property_type text,
  city text,
  department text,
  tribunal_code text,
  tribunal_name text,
  tribunal_city text,
  starting_price_eur numeric,
  source_url text,
  source_urls jsonb,
  total_count bigint
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_upcoming_hearings(p_days);
$function$;

revoke all on function public.get_public_upcoming_hearings(integer) from public;
grant execute on function public.get_public_upcoming_hearings(integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
