begin;

set local lock_timeout = '5s';

-- « Historique de la vente » (offre Analyse).
--
-- 1. public.auction_sale_timeline keeps the events a buyer cares about for ONE
--    listing, with the previous AND the new value: first seen, hearing moved,
--    starting price changed, postponed, cancelled, adjudicated.
--    auction_sale_history only stores new values of every column (and is purged
--    after 12 months), so it cannot tell « la mise à prix est passée de 120 000 €
--    à 90 000 € ». A dedicated trigger records it from now on, and the existing
--    history is replayed once below.
-- 2. app_private.get_sale_passages(sale) returns that timeline plus the earlier
--    passages of the same property: archived catalogue listings (outcome graph)
--    and other catalogue rows with the same street number and street, the same
--    commune, the same property type, a surface within 2 % and a hearing at
--    least 14 days earlier (a re-listing after a carence, a surenchère or a
--    lowered starting price). Same-day rows are the same hearing published by
--    several sources, not a new passage.
--
-- No foreign key to auction_sales: catalogue retention deletes past sales, and
-- their passages must survive to be shown on the next listing of the property.

create table if not exists public.auction_sale_timeline (
  id bigint generated always as identity primary key,
  sale_id uuid not null,
  source_url text,
  event_kind text not null check (
    event_kind in (
      'first_seen',
      'sale_date_changed',
      'starting_price_changed',
      'postponed',
      'cancelled',
      'adjudicated'
    )
  ),
  previous_value jsonb,
  new_value jsonb,
  observed_at timestamptz not null default statement_timestamp(),
  origin text not null default 'trigger' check (origin in ('trigger', 'history_backfill'))
);

create index if not exists auction_sale_timeline_sale_idx
  on public.auction_sale_timeline (sale_id, observed_at);

alter table public.auction_sale_timeline enable row level security;
revoke all on table public.auction_sale_timeline from public, anon, authenticated;
grant select, insert, delete on table public.auction_sale_timeline to service_role;

-- Day of the hearing in France: a time or offset rewrite is not a new date.
create or replace function app_private.sale_hearing_day(p_value timestamptz)
returns date
language sql
immutable
set search_path = ''
as $function$
  select (p_value at time zone 'Europe/Paris')::date;
$function$;

-- A starting price rewritten by less than 1 € or 0.5 % is a rounding of the
-- same figure (369 436 € vs 369 436,16 €), not a new price.
create or replace function app_private.sale_price_really_changed(p_old numeric, p_new numeric)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_old > 0 and p_new > 0
     and abs(p_new - p_old) >= 1
     and abs(p_new - p_old) >= 0.005 * p_old;
$function$;

-- True when this value was already recorded for the sale. Two sources that
-- disagree make the pipeline alternate between their values (one listing went
-- 182 times between 15 000 € and 20 000 €): only a value never seen before is
-- a real change, a return to an earlier value is that alternation.
create or replace function app_private.sale_timeline_value_seen(
  p_sale_id uuid,
  p_kind text,
  p_value jsonb
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists (
    select 1
      from public.auction_sale_timeline e
     where e.sale_id = p_sale_id
       and e.event_kind = p_kind
       and (
         case when p_kind = 'sale_date_changed' then
           app_private.sale_hearing_day((e.previous_value #>> '{}')::timestamptz)
             = app_private.sale_hearing_day((p_value #>> '{}')::timestamptz)
           or app_private.sale_hearing_day((e.new_value #>> '{}')::timestamptz)
             = app_private.sale_hearing_day((p_value #>> '{}')::timestamptz)
         else
           not app_private.sale_price_really_changed((e.previous_value #>> '{}')::numeric, (p_value #>> '{}')::numeric)
           or not app_private.sale_price_really_changed((e.new_value #>> '{}')::numeric, (p_value #>> '{}')::numeric)
         end
       )
  );
$function$;

create or replace function app_private.record_auction_sale_timeline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    insert into public.auction_sale_timeline (sale_id, source_url, event_kind, new_value)
    values (
      new.id,
      new.source_url,
      'first_seen',
      jsonb_build_object('sale_date', new.sale_date, 'starting_price_eur', new.starting_price_eur)
    );
    return new;
  end if;

  if new.sale_date is not null
    and old.sale_date is not null
    and app_private.sale_hearing_day(new.sale_date) <> app_private.sale_hearing_day(old.sale_date)
    and not app_private.sale_timeline_value_seen(new.id, 'sale_date_changed', to_jsonb(new.sale_date)) then
    insert into public.auction_sale_timeline (sale_id, source_url, event_kind, previous_value, new_value)
    values (new.id, new.source_url, 'sale_date_changed', to_jsonb(old.sale_date), to_jsonb(new.sale_date));
  end if;

  if app_private.sale_price_really_changed(old.starting_price_eur::numeric, new.starting_price_eur::numeric)
    and not app_private.sale_timeline_value_seen(
      new.id, 'starting_price_changed', to_jsonb(new.starting_price_eur::numeric)
    ) then
    insert into public.auction_sale_timeline (sale_id, source_url, event_kind, previous_value, new_value)
    values (
      new.id, new.source_url, 'starting_price_changed',
      to_jsonb(old.starting_price_eur::numeric), to_jsonb(new.starting_price_eur::numeric)
    );
  end if;

  if new.status is distinct from old.status
    and new.status in ('postponed', 'cancelled', 'adjudicated') then
    insert into public.auction_sale_timeline (sale_id, source_url, event_kind, previous_value, new_value)
    values (
      new.id, new.source_url, new.status,
      to_jsonb(old.status),
      case when new.status = 'adjudicated'
        then jsonb_build_object('adjudication_price_eur', new.adjudication_price_eur)
        else to_jsonb(new.status)
      end
    );
  elsif new.adjudication_price_eur is not null
    and new.adjudication_price_eur is distinct from old.adjudication_price_eur then
    insert into public.auction_sale_timeline (sale_id, source_url, event_kind, previous_value, new_value)
    values (
      new.id, new.source_url, 'adjudicated',
      to_jsonb(old.adjudication_price_eur),
      jsonb_build_object('adjudication_price_eur', new.adjudication_price_eur)
    );
  end if;
  return new;
end;
$function$;

revoke all on function app_private.record_auction_sale_timeline() from public, anon, authenticated;
revoke all on function app_private.sale_timeline_value_seen(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function app_private.sale_price_really_changed(numeric, numeric) from public, anon, authenticated;

drop trigger if exists trg_record_auction_sale_timeline on public.auction_sales;
create trigger trg_record_auction_sale_timeline
  after insert or update of sale_date, starting_price_eur, status, adjudication_price_eur
  on public.auction_sales
  for each row
  execute function app_private.record_auction_sale_timeline();

-- « Annonce repérée » for listings published before the trigger existed. Their
-- values at that time are unknown, so the event carries none.
insert into public.auction_sale_timeline (sale_id, source_url, event_kind, observed_at, origin)
select sale.id, sale.source_url, 'first_seen', sale.created_at, 'history_backfill'
  from public.auction_sales sale
 where sale.created_at is not null
   and not exists (
     select 1 from public.auction_sale_timeline existing where existing.sale_id = sale.id
   );

-- Replay of the existing history (new values only): each change of hearing day
-- or starting price against the previous logged value becomes an event. The
-- first logged value has no known predecessor and only sets the baseline.
-- Idempotent: nothing is replayed for a sale that already has backfilled rows.
with logged as (
  select sale.id as sale_id,
         history.source_url,
         history.changed_at,
         case when history.changed_fields ? 'sale_date'
              then nullif(history.changed_fields ->> 'sale_date', '')::timestamptz end as sale_date,
         case when history.changed_fields ? 'starting_price_eur'
              then nullif(history.changed_fields ->> 'starting_price_eur', '')::numeric end as starting_price_eur
    from public.auction_sale_history history
    join public.auction_sales sale on sale.source_url = history.source_url
   where not exists (
           select 1 from public.auction_sale_timeline replayed
            where replayed.sale_id = sale.id
              and replayed.origin = 'history_backfill'
              and replayed.event_kind in ('sale_date_changed', 'starting_price_changed')
         )
     and ((history.changed_fields ? 'sale_date' and jsonb_typeof(history.changed_fields -> 'sale_date') = 'string')
      or (history.changed_fields ? 'starting_price_eur' and jsonb_typeof(history.changed_fields -> 'starting_price_eur') = 'number'))
),
-- First appearance of each distinct value only (see sale_timeline_value_seen):
-- the alternation between two sources replays as a single change.
date_firsts as (
  select distinct on (sale_id, app_private.sale_hearing_day(sale_date))
         sale_id, source_url, changed_at, sale_date
    from logged where sale_date is not null
   order by sale_id, app_private.sale_hearing_day(sale_date), changed_at
),
dates as (
  select sale_id, source_url, changed_at, sale_date,
         lag(sale_date) over (partition by sale_id order by changed_at) as previous_date
    from date_firsts
),
price_firsts as (
  select distinct on (sale_id, starting_price_eur)
         sale_id, source_url, changed_at, starting_price_eur
    from logged where starting_price_eur is not null and starting_price_eur > 0
   order by sale_id, starting_price_eur, changed_at
),
prices as (
  select sale_id, source_url, changed_at, starting_price_eur,
         lag(starting_price_eur) over (partition by sale_id order by changed_at) as previous_price
    from price_firsts
)
insert into public.auction_sale_timeline (sale_id, source_url, event_kind, previous_value, new_value, observed_at, origin)
select sale_id, source_url, 'sale_date_changed', to_jsonb(previous_date), to_jsonb(sale_date), changed_at, 'history_backfill'
  from dates
 where previous_date is not null
union all
select sale_id, source_url, 'starting_price_changed', to_jsonb(previous_price), to_jsonb(starting_price_eur), changed_at, 'history_backfill'
  from prices
 where app_private.sale_price_really_changed(previous_price, starting_price_eur);

-- « 38, av. des Valampes » and « 38 avenue des Valampes » → « 38 valampes »:
-- the street number and the longest word of the street name. NULL when the
-- address has no street number: a street alone is not enough to say that two
-- listings describe the same property.
create or replace function app_private.sale_street_key(p_address text)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  parts text[];
  street text;
  word text;
begin
  if p_address is null then
    return null;
  end if;
  parts := regexp_match(
    lower(extensions.unaccent(p_address)),
    '(?:^|[^0-9])([0-9]{1,4})\s*(?:bis|ter|b)?\s*,?\s*'
    || '(?:rue|avenue|av|bd|boulevard|chemin|ch|allee|place|pl|impasse|imp|route|rte|quai|cours|square|'
    || 'voie|passage|traverse|montee|sentier|hameau|faubourg|fg|lotissement|residence|cite|parvis|esplanade|promenade)'
    || '\.?\s+(.*)$'
  );
  if parts is null then
    return null;
  end if;
  street := split_part(regexp_replace(parts[2], '[0-9]{5}.*$', ''), ',', 1);
  select token into word
    from regexp_split_to_table(street, '[^a-z-]+') as token
   where length(token) >= 4
     and token not in (
       'des', 'les', 'aux', 'sous', 'sur',
       -- Titles shared by many streets of one commune (« Général Leclerc »,
       -- « Général de Gaulle »): the surname, not the title, names the street.
       'general', 'generale', 'president', 'marechal', 'docteur', 'commandant',
       'colonel', 'capitaine', 'lieutenant', 'professeur', 'abbe'
     )
   order by length(token) desc, token
   limit 1;
  if word is null then
    return null;
  end if;
  return parts[1] || ' ' || word;
end;
$function$;

revoke all on function app_private.sale_street_key(text) from public, anon, authenticated;
grant execute on function app_private.sale_street_key(text) to service_role;

create or replace function app_private.get_sale_passages(p_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with target as (
    select s.id, s.source_url, s.city, s.property_type, s.sale_date,
           coalesce(s.habitable_surface_m2, s.app_surface_m2, s.surface_m2)::numeric as surface,
           app_private.sale_street_key(s.address) as street_key
      from public.auction_sales s
     where s.id = p_sale_id
  ),
  archived as (
    select l.auction_sale_id as sale_id,
           r.scheduled_at as sale_date,
           coalesce(r.effective_starting_price_eur, r.initial_starting_price_eur, l.initial_starting_price_eur) as starting_price_eur,
           r.current_status as status,
           'archive'::text as origin
      from target t
      join public.auction_lots l on l.property_type = t.property_type
      join public.auction_rounds r on r.lot_id = l.id
      join public.outcome_addresses a on a.id = l.address_id
     where t.street_key is not null
       and t.surface > 0
       and l.living_area_m2 > 0
       and abs(l.living_area_m2 - t.surface) <= greatest(1, 0.02 * t.surface)
       and lower(extensions.unaccent(a.city)) = lower(extensions.unaccent(t.city))
       and app_private.sale_street_key(coalesce(a.street, a.label)) = t.street_key
       and r.scheduled_at <= t.sale_date - interval '14 days'
       and l.auction_sale_id is distinct from t.id
  ),
  catalogue as (
    select s.id as sale_id, s.sale_date, s.starting_price_eur::numeric as starting_price_eur,
           s.status, 'catalogue'::text as origin
      from target t
      join public.auction_sales s
        on s.property_type = t.property_type
       and lower(extensions.unaccent(s.city)) = lower(extensions.unaccent(t.city))
     where t.street_key is not null
       and t.surface > 0
       and s.id <> t.id
       and coalesce(s.habitable_surface_m2, s.app_surface_m2, s.surface_m2) > 0
       and abs(coalesce(s.habitable_surface_m2, s.app_surface_m2, s.surface_m2)::numeric - t.surface)
           <= greatest(1, 0.02 * t.surface)
       and app_private.sale_street_key(s.address) = t.street_key
       and s.sale_date <= t.sale_date - interval '14 days'
  ),
  passages as (
    select distinct on (app_private.sale_hearing_day(sale_date))
           sale_id, sale_date, starting_price_eur, status, origin
      from (select * from catalogue union all select * from archived) found
     where sale_date is not null
     order by app_private.sale_hearing_day(sale_date), origin, starting_price_eur nulls last
  )
  select jsonb_build_object(
    'sale_id', (select id from target),
    'timeline', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'kind', e.event_kind,
                 'previous', e.previous_value,
                 'value', e.new_value,
                 'observed_at', e.observed_at,
                 'backfilled', e.origin = 'history_backfill'
               )
               order by e.observed_at, e.id
             )
        from public.auction_sale_timeline e
       where e.sale_id = p_sale_id
    ), '[]'::jsonb),
    'previous_passages', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'sale_date', p.sale_date,
                 'starting_price_eur', p.starting_price_eur,
                 'status', p.status,
                 'origin', p.origin
               )
               order by p.sale_date desc
             )
        from passages p
    ), '[]'::jsonb)
  )
  where exists (select 1 from target);
$function$;

revoke all on function app_private.get_sale_passages(uuid) from public, anon, authenticated;
grant execute on function app_private.get_sale_passages(uuid) to service_role;

create or replace function public.get_sale_passages(p_sale_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select app_private.get_sale_passages(p_sale_id);
$function$;

revoke all on function public.get_sale_passages(uuid) from public, anon, authenticated;
grant execute on function public.get_sale_passages(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
