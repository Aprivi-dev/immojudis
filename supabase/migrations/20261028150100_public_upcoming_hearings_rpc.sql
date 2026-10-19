begin;

set local lock_timeout = '5s';

-- Page publique /audiences-a-venir : les audiences des prochains jours, pour un visiteur sans
-- compte.
--
-- La règle de « date sourcée » n'est pas recopiée : chaque candidat passe par
-- app_private.get_public_sale_calendar_event(), la fonction de l'export agenda « Ajouter à mon
-- agenda ». Une audience n'est rendue que si cette fonction la déclare exportable : vente au
-- tribunal à venir (jamais reportée, annulée, retirée), visible au catalogue public, date non
-- passée, non rejetée comme invraisemblable, sans conflit entre sources et sans fenêtre de vente en
-- ligne ; date_only vaut vrai quand l'heure n'est pas connue (aucune heure n'est inventée). Si la
-- règle de l'export change, cette page suit.
--
-- Fenêtre : du jour courant (heure de Paris) à p_days jours plus tard, bornée à 1..60 jours. Les
-- candidats sont d'abord réduits par un filtre grossier sur la colonne sale_date (à venir, au
-- tribunal, dans la fenêtre élargie de deux jours) : la fonction de l'export, qui relit la vente,
-- ne tourne que sur ces lignes. Au plus 1 000 lignes (limite de PostgREST) ; total_count donne le
-- nombre total avant cette limite, pour dire qu'une liste est tronquée.
--
-- Contrat public, celui des cartes de la recherche : commune, département, type de bien, tribunal,
-- date, mise à prix. Ni adresse, ni coordonnées, ni documents, ni contacts, ni texte de l'annonce.
-- starting_price_eur et tribunal_code servent à l'appelant à ne montrer qu'une fois la même vente
-- publiée par deux sources (même tribunal, même jour, même mise à prix).

create or replace function app_private.get_public_upcoming_hearings(p_days integer default 30)
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
      s.starting_price_eur::numeric as starting_price_eur
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
    count(*) over () as total_count
  from hearings h
  order by h.sale_date, h.tribunal_name, h.id
  limit 1000;
$function$;

revoke all on function app_private.get_public_upcoming_hearings(integer)
  from public, anon, authenticated;
grant execute on function app_private.get_public_upcoming_hearings(integer)
  to anon, authenticated, service_role;

create or replace function public.get_public_upcoming_hearings(p_days integer default 30)
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
