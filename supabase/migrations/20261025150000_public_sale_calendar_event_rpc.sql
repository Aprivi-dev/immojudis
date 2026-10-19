begin;

set local lock_timeout = '5s';

-- « Ajouter à mon agenda » (fichier .ics) : the hearing date of ONE publicly visible sale, for
-- signed-out visitors as well as signed-in accounts.
--
-- get_public_sale_summary hides what tells a reliable date from an obsolete one (the status of a
-- postponed sale keeps its old date, the conflicts and the time precision live in raw_payload).
-- This function decides it on the server and returns the facts only when the date can be written
-- into someone's calendar:
--   * a tribunal hearing, status 'upcoming' (never postponed, cancelled, withdrawn or unknown);
--   * a stored date that is not in the past, not rejected as implausible (sale_date_unverified),
--     not in conflict between sources, and not announced with an online sale window (opening and
--     closing instants are not one hearing date);
--   * date_only = true when the hour is not known (precision marker, raw date without hour, or a
--     stored midnight): the file then holds an all-day event, never an invented hour.
-- Same visibility predicate as get_public_sale_summary. When the date is not exportable the row is
-- still returned (so the route answers 409, not 404) but every fact is null. The property
-- address, coordinates, documents, visit text and contacts are not part of the contract.

create or replace function app_private.get_public_sale_calendar_event(p_sale_id uuid)
returns table (
  id uuid,
  exportable boolean,
  sale_date timestamptz,
  date_only boolean,
  property_type text,
  city text,
  tribunal_name text,
  tribunal_city text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.id,
    check_result.ok as exportable,
    case when check_result.ok then s.sale_date::timestamptz end as sale_date,
    case when check_result.ok then check_result.day_only end as date_only,
    case when check_result.ok then s.property_type end as property_type,
    case when check_result.ok then s.city end as city,
    case when check_result.ok then coalesce(t.canonical_name, s.tribunal) end as tribunal_name,
    case when check_result.ok then t.city end as tribunal_city,
    case when check_result.ok then s.updated_at::timestamptz end as updated_at
  from public.auction_sales s
  left join public.tribunals t on t.code = s.tribunal_code
  cross join lateral (
    select
      lower(coalesce(
        nullif(btrim(s.raw_payload->>'date_precision'), ''),
        nullif(btrim(s.raw_payload->>'sale_date_precision'), ''),
        ''
      )) as raw_precision,
      coalesce(s.raw_payload->>'sale_date', '') as raw_date
  ) raw_facts
  cross join lateral (
    select
      s.sale_date is not null and isfinite(s.sale_date) as has_date,
      -- Same markers as app_private.sale_retention_deadline, plus a stored midnight (UTC or Paris).
      (
        raw_facts.raw_precision in ('day', 'date', 'day_only', 'date_only', 'unknown_time', 'time_unknown')
        or (raw_facts.raw_date <> '' and raw_facts.raw_date !~ '[0-9]{1,2}[[:space:]]*([hH]|:[0-9]{2})')
        or (s.sale_date at time zone 'UTC')::time = time '00:00'
        or (s.sale_date at time zone 'Europe/Paris')::time = time '00:00'
      ) as day_only
  ) facts
  cross join lateral (
    select
      coalesce(
        s.sale_venue_type = 'tribunal'
        and s.status = 'upcoming'
        and facts.has_date
        and coalesce(s.sale_verification_status, '') <> 'conflict'
        and lower(coalesce(s.raw_payload->>'status', '')) !~ '(postponed|reported|report[eé]e?|cancel|annul|withdrawn|retir)'
        and (s.raw_payload->'sale_date_unverified') is null
        and not jsonb_path_exists(
          case when jsonb_typeof(s.raw_payload) = 'object' then s.raw_payload else '{}'::jsonb end,
          '$.source_conflicts[*] ? (@.field == "sale_date")'
        )
        and not exists (
          select 1
          from jsonb_array_elements_text(
            case when jsonb_typeof(s.quality_flags) = 'array' then s.quality_flags else '[]'::jsonb end
          ) as flag(value)
          where flag.value in (
            'date_conflict', 'sale_date_conflict', 'sale_time_conflict', 'sale_date_implausible'
          )
        )
        and coalesce(s.sale_procedure->'sale_window', 'null'::jsonb) = 'null'::jsonb
        and coalesce(s.sale_procedure->'sale_session', 'null'::jsonb) = 'null'::jsonb
        and coalesce(s.raw_payload->'source_sale_schedule', 'null'::jsonb) = 'null'::jsonb
        and (
          case
            when facts.day_only then
              (s.sale_date at time zone 'Europe/Paris')::date
                >= (statement_timestamp() at time zone 'Europe/Paris')::date
            else s.sale_date > statement_timestamp()
          end
        ),
        false
      ) as ok,
      facts.day_only as day_only
  ) check_result
  where s.id = p_sale_id
    and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and app_private.sale_catalogue_entry_is_live_materialized(
      s.catalogue_expiry_materialized,
      s.catalogue_expiry_deadline,
      s.sale_date,
      s.raw_payload,
      s.sale_procedure
    )
    and coalesce(s.raw_payload->>'publication_quarantine', '') = '';
$function$;

revoke all on function app_private.get_public_sale_calendar_event(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_calendar_event(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_public_sale_calendar_event(p_sale_id uuid)
returns table (
  id uuid,
  exportable boolean,
  sale_date timestamptz,
  date_only boolean,
  property_type text,
  city text,
  tribunal_name text,
  tribunal_city text,
  updated_at timestamptz
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_sale_calendar_event(p_sale_id);
$function$;

revoke all on function public.get_public_sale_calendar_event(uuid) from public;
grant execute on function public.get_public_sale_calendar_event(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
