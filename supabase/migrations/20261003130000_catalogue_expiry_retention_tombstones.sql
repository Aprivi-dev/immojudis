begin;

-- A timestamp is an observed instant. A date-only value is a civil-day
-- statement, so it remains in the catalogue until the next midnight in the
-- source's local zone. The default is deliberately explicit; a deployment
-- can choose start_of_day with SET app.date_only_catalogue_policy for a
-- controlled migration, without changing the retention window.
create or replace function app_private.sale_catalogue_expiry(
  p_sale_date timestamptz,
  p_raw jsonb,
  p_policy text default null
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_raw jsonb := case
    when jsonb_typeof(coalesce(p_raw, '{}'::jsonb)) = 'object' then coalesce(p_raw, '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_raw_date text := coalesce(v_raw->>'sale_date', '');
  v_precision text := lower(coalesce(
    nullif(btrim(v_raw->>'date_precision'), ''),
    nullif(btrim(v_raw->>'sale_date_precision'), ''),
    ''
  ));
  v_procedure jsonb := case
    when jsonb_typeof(coalesce(v_raw->'sale_procedure', '{}'::jsonb)) = 'object'
      then coalesce(v_raw->'sale_procedure', '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_schedule jsonb;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_policy text := lower(coalesce(
    nullif(btrim(p_policy), ''),
    nullif(btrim(current_setting('app.date_only_catalogue_policy', true)), ''),
    'end_of_local_day'
  ));
  v_local_date date;
begin
  if p_sale_date is null or not isfinite(p_sale_date) then
    return null;
  end if;

  if v_policy not in ('end_of_local_day', 'start_of_day') then
    v_policy := 'end_of_local_day';
  end if;

  -- Online windows may start at sale_date and close later. Keep the listing
  -- visible until the validated close instant when the procedure carries one.
  foreach v_schedule in array array[
    v_procedure->'sale_window',
    v_procedure->'sale_session',
    v_raw->'source_sale_schedule'
  ] loop
    if v_schedule is not null and v_schedule <> 'null'::jsonb
       and (v_schedule->>'opens_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
       and (v_schedule->>'closes_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$' then
      begin
        v_start_at := (v_schedule->>'opens_at')::timestamptz;
        v_end_at := (v_schedule->>'closes_at')::timestamptz;
        if isfinite(v_start_at) and isfinite(v_end_at) and v_end_at > v_start_at then
          return v_end_at;
        end if;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          null;
      end;
    end if;
  end loop;

  if v_precision not in ('day', 'date', 'day_only', 'date_only', 'unknown_time', 'time_unknown')
     and not (
       v_raw_date <> ''
       and v_raw_date !~ '[0-9]{1,2}[[:space:]]*([hH]|:[0-9]{2})'
     ) then
    return p_sale_date;
  end if;

  v_local_date := (p_sale_date at time zone 'Europe/Paris')::date;
  if v_policy = 'start_of_day' then
    return (v_local_date::timestamp at time zone 'Europe/Paris');
  end if;
  return (((v_local_date + 1)::timestamp) at time zone 'Europe/Paris');
end;
$$;

create or replace function app_private.sale_catalogue_entry_is_live(
  p_sale_date timestamptz,
  p_raw jsonb
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select app_private.sale_catalogue_expiry(p_sale_date, p_raw) > current_timestamp;
$$;

-- The historical retention deadline deliberately includes a 24-hour grace
-- period for queue consumers.  Catalogue deletion has a different contract:
-- once the observed instant (or the end of the stated civil day) is reached,
-- the sale is eligible for archival in the same retention tick.  Keep this
-- exact deadline in its own materialized column so the existing enrichment
-- grace fence remains backwards compatible.
create or replace function app_private.sale_catalogue_retention_deadline(
  p_sale_date timestamptz,
  p_status text,
  p_procedure jsonb,
  p_raw jsonb
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_raw jsonb := case
    when jsonb_typeof(coalesce(p_raw, '{}'::jsonb)) = 'object' then coalesce(p_raw, '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_schedule jsonb;
  v_start_at timestamptz;
  v_end_at timestamptz;
begin
  -- A source-level postponement is not enough evidence to expire the old
  -- hearing.  A row carrying a concrete rescheduled date remains visible
  -- through sale_catalogue_expiry and is handled by the explicit postponed
  -- fallback in the purge below.
  if lower(coalesce(v_raw->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
     or lower(coalesce(p_status, '')) in ('postponed', 'reported', 'reportee', 'reporté', 'reportée') then
    return null;
  end if;

  -- A contradictory upcoming/unknown date is retained for investigation.
  -- Terminal status is positive evidence that the contradiction is stale and
  -- may be archived at its exact catalogue cutoff.
  if jsonb_path_exists(
       coalesce(v_raw, '{}'::jsonb),
       '$.source_conflicts[*] ? (@.field == "sale_date")'
     )
     and lower(coalesce(p_status, '')) not in ('past', 'adjudicated', 'cancelled', 'withdrawn') then
    return null;
  end if;

  foreach v_schedule in array array[
    coalesce(p_procedure, '{}'::jsonb)->'sale_window',
    coalesce(p_procedure, '{}'::jsonb)->'sale_session',
    v_raw->'source_sale_schedule'
  ] loop
    if v_schedule is not null and v_schedule <> 'null'::jsonb then
      begin
        if (v_schedule->>'opens_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
           or (v_schedule->>'closes_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
           or v_schedule->>'opens_at' is null
           or v_schedule->>'closes_at' is null then
          return null;
        end if;
        v_start_at := (v_schedule->>'opens_at')::timestamptz;
        v_end_at := (v_schedule->>'closes_at')::timestamptz;
        if not isfinite(v_start_at) or not isfinite(v_end_at) or v_end_at <= v_start_at then
          return null;
        end if;
        return v_end_at;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          return null;
      end;
    end if;
  end loop;

  return app_private.sale_catalogue_expiry(p_sale_date, v_raw);
end;
$$;

revoke all on function app_private.sale_catalogue_expiry(timestamptz, jsonb, text)
  from public, anon, authenticated;
grant execute on function app_private.sale_catalogue_expiry(timestamptz, jsonb, text)
  to anon, authenticated, service_role;
revoke all on function app_private.sale_catalogue_entry_is_live(timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function app_private.sale_catalogue_entry_is_live(timestamptz, jsonb)
  to anon, authenticated, service_role;
revoke all on function app_private.sale_catalogue_retention_deadline(timestamptz, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function app_private.sale_catalogue_retention_deadline(timestamptz, text, jsonb, jsonb)
  to service_role;

comment on function app_private.sale_catalogue_expiry(timestamptz, jsonb, text) is
  'Catalogue cutoff: timed sales expire at their observed instant; date-only sales expire at the next Europe/Paris midnight by default.';

alter table public.auction_sales
  add column if not exists catalogue_expiry_deadline timestamptz,
  add column if not exists catalogue_expiry_materialized boolean not null default false;

comment on column public.auction_sales.catalogue_expiry_deadline is
  'Exact catalogue and destructive-retention cutoff. Timed sales use the observed instant; date-only sales use the next Europe/Paris midnight.';
comment on column public.auction_sales.catalogue_expiry_materialized is
  'Internal backfill fence; true means catalogue_expiry_deadline was computed from the source fields.';

create index if not exists auction_sales_catalogue_expiry_deadline_idx
  on public.auction_sales (catalogue_expiry_deadline, sale_date, id)
  where catalogue_expiry_materialized and catalogue_expiry_deadline is not null;

-- A tombstone is the durable identity/date fence left by retention. It is
-- kept separately from the listing so a source replay cannot recreate the
-- same expired hearing, while a legitimate later hearing at the same source
-- URL remains admissible.
create table if not exists public.auction_sale_retention_tombstones (
  source_url text primary key,
  sale_date timestamptz,
  expired_at timestamptz not null default statement_timestamp(),
  reason text not null default 'retention_deadline_elapsed',
  constraint auction_sale_retention_tombstones_source_url_nonempty
    check (length(btrim(source_url)) > 0)
);

comment on table public.auction_sale_retention_tombstones is
  'Source/date fence for auction sales removed after their retention deadline; later scheduled dates at the same URL remain admissible.';
comment on column public.auction_sale_retention_tombstones.sale_date is
  'Last expired sale date snapshot retained for audit; a newer date at the same source URL may be reimported.';

alter table public.auction_sale_retention_tombstones enable row level security;
revoke all on table public.auction_sale_retention_tombstones from public, anon, authenticated;
grant select, insert on table public.auction_sale_retention_tombstones to service_role;

create or replace function app_private.prevent_retention_tombstone_reimport()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.source_url is not null and exists (
    select 1
    from public.auction_sale_retention_tombstones tombstone
    where tombstone.source_url = new.source_url
      and (
        tombstone.sale_date is null
        or new.sale_date is null
        or new.sale_date <= tombstone.sale_date
      )
  ) then
    raise exception using
      errcode = '23505',
      message = 'This auction sale date was retired by retention.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.prevent_retention_tombstone_reimport()
  from public, anon, authenticated, service_role;
grant execute on function app_private.prevent_retention_tombstone_reimport()
  to service_role;

-- Keep the historical retention deadline for enrichment grace, while the new
-- catalogue fence drives the actual sale-row deletion at the exact cutoff.
create or replace function app_private.set_auction_sale_retention_deadline()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.retention_deadline := app_private.sale_retention_deadline(
    new.sale_date,
    new.status,
    new.sale_procedure,
    new.raw_payload
  );
  new.retention_deadline_materialized := true;
  new.catalogue_expiry_deadline := app_private.sale_catalogue_retention_deadline(
    new.sale_date,
    new.status,
    new.sale_procedure,
    new.raw_payload
  );
  new.catalogue_expiry_materialized := true;
  return new;
end;
$$;

revoke all on function app_private.set_auction_sale_retention_deadline()
  from public, anon, authenticated, service_role;
grant execute on function app_private.set_auction_sale_retention_deadline()
  to service_role;

-- The original materialization trigger also guards direct deadline tampering;
-- extend its UPDATE OF-independent WHEN clause to the exact catalogue fence.
drop trigger if exists zzzz_auction_sales_retention_deadline_insert on public.auction_sales;
create trigger zzzz_auction_sales_retention_deadline_insert
before insert on public.auction_sales
for each row
execute function app_private.set_auction_sale_retention_deadline();
drop trigger if exists zzzz_auction_sales_retention_deadline_update on public.auction_sales;
create trigger zzzz_auction_sales_retention_deadline_update
before update on public.auction_sales
for each row
when (
  old.sale_date is distinct from new.sale_date
  or old.status is distinct from new.status
  or old.sale_procedure is distinct from new.sale_procedure
  or old.raw_payload is distinct from new.raw_payload
  or old.retention_deadline is distinct from new.retention_deadline
  or old.retention_deadline_materialized is distinct from new.retention_deadline_materialized
  or old.catalogue_expiry_deadline is distinct from new.catalogue_expiry_deadline
  or old.catalogue_expiry_materialized is distinct from new.catalogue_expiry_materialized
)
execute function app_private.set_auction_sale_retention_deadline();

-- Recompute every existing row exactly once in deterministic UUID order. The
-- cursor prevents the old 500-row batch from selecting the same terminal rows
-- repeatedly and the hard bound fails closed for an unexpectedly large table.
do $block$
declare
  batch_size constant integer := 500;
  max_batches constant integer := 200;
  changed integer;
  batches integer := 0;
  last_id uuid := '00000000-0000-0000-0000-000000000000';
begin
  loop
    with batch as materialized (
      select sale.id
      from public.auction_sales sale
      where sale.id > last_id
      order by sale.id
      limit batch_size
    ), updated as (
      update public.auction_sales sale
         set catalogue_expiry_deadline = app_private.sale_catalogue_retention_deadline(
               sale.sale_date, sale.status, sale.sale_procedure, sale.raw_payload
             ),
             catalogue_expiry_materialized = true
        from batch
       where sale.id = batch.id
      returning sale.id
    )
    select count(*)::integer,
           (select updated_row.id from updated updated_row order by updated_row.id desc limit 1)
      into changed, last_id
      from updated;

    exit when changed = 0;
    batches := batches + 1;
    if batches >= max_batches then
      if exists (select 1 from public.auction_sales sale where sale.id > last_id) then
        raise exception using
          errcode = '54000',
          message = 'Catalogue expiry backfill exceeded its 100000-row safety bound.';
      end if;
      exit;
    end if;
  end loop;

  if exists (
    select 1 from public.auction_sales sale
    where not sale.catalogue_expiry_materialized
  ) then
    raise exception using
      errcode = '54000',
      message = 'Catalogue expiry backfill left unmaterialized rows.';
  end if;
end;
$block$;

drop trigger if exists auction_sales_retention_tombstone_guard on public.auction_sales;
drop trigger if exists aaaa_auction_sales_retention_tombstone_guard_insert on public.auction_sales;
drop trigger if exists aaaa_auction_sales_retention_tombstone_guard_update on public.auction_sales;
create trigger aaaa_auction_sales_retention_tombstone_guard_insert
before insert on public.auction_sales
for each row
execute function app_private.prevent_retention_tombstone_reimport();
create trigger aaaa_auction_sales_retention_tombstone_guard_update
before update on public.auction_sales
for each row
when (old.source_url is distinct from new.source_url)
execute function app_private.prevent_retention_tombstone_reimport();

-- Preserve the existing bridge, storage queue and dependency cleanup order.
-- Only add the tombstone immediately before the destructive deletes, so a
-- failed statistical archive cannot fence a row that was not removed.
do $block$
declare
  v_definition text;
  v_changed boolean := false;
  v_eligibility_anchor constant text := $eligibility$where sale.retention_deadline_materialized
      and sale.retention_deadline <= p_now$eligibility$;
  v_eligibility_parenthesized_anchor constant text := $eligibility_parenthesized$where (
        sale.retention_deadline_materialized
        and sale.retention_deadline <= p_now
      )$eligibility_parenthesized$;
  v_eligibility_replacement constant text := $replacement$where (
        sale.catalogue_expiry_materialized
        and sale.catalogue_expiry_deadline <= p_now
      )
      or (
        (
          sale.status = 'postponed'
          or lower(coalesce(sale.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
        )
        and app_private.sale_catalogue_expiry(
          sale.sale_date,
          (case
            when jsonb_typeof(coalesce(sale.raw_payload, '{}'::jsonb)) = 'object'
              then coalesce(sale.raw_payload, '{}'::jsonb)
            else '{}'::jsonb
           end) || jsonb_build_object('sale_procedure', coalesce(sale.sale_procedure, '{}'::jsonb))
        ) <= p_now
      )$replacement$;
  v_anchor constant text := $anchor$    delete from public.valuation_estimates$anchor$;
  v_insert constant text := $insert$
    insert into public.auction_sale_retention_tombstones(source_url, sale_date, expired_at)
    values (sale_row.source_url, sale_row.sale_date, p_now)
    on conflict (source_url) do update
      set sale_date = case
        when excluded.sale_date is null then public.auction_sale_retention_tombstones.sale_date
        when public.auction_sale_retention_tombstones.sale_date is null then excluded.sale_date
        else greatest(public.auction_sale_retention_tombstones.sale_date, excluded.sale_date)
      end,
      expired_at = greatest(public.auction_sale_retention_tombstones.expired_at, excluded.expired_at),
      reason = excluded.reason;
$insert$;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(
    'public.purge_expired_auction_sales(timestamptz,integer)'
  )::oid;

  if v_definition is null then
    raise exception using
      errcode = '42883',
      message = 'Missing public.purge_expired_auction_sales(timestamptz,integer).';
  end if;

  -- The first revision of this migration added a +24-hour postponed fallback.
  -- Remove it when replaying the migration so an interrupted/local dry run
  -- converges to the exact catalogue cutoff as well.
  if position('+ interval ''24 hours''' in v_definition) > 0 then
    v_definition := regexp_replace(
      v_definition,
      $legacy$\s+or\s+\(\s*sale\.status = 'postponed'\s+and\s+app_private\.sale_catalogue_expiry\(sale\.sale_date, sale\.raw_payload\) \+ interval '24 hours' <= p_now\s*\)$legacy$,
      '',
      'g'
    );
    v_changed := true;
  end if;

  if position('catalogue_expiry_materialized' in v_definition) = 0 then
    if position(v_eligibility_anchor in v_definition) > 0 then
      v_definition := replace(v_definition, v_eligibility_anchor, v_eligibility_replacement);
      v_changed := true;
    elsif position(v_eligibility_parenthesized_anchor in v_definition) > 0 then
      v_definition := replace(v_definition, v_eligibility_parenthesized_anchor, v_eligibility_replacement);
      v_changed := true;
    else
      raise exception using
        errcode = 'P0001',
        message = 'Unexpected retention function definition; postponed expiry policy was not installed.';
    end if;
  end if;

  if position('auction_sale_retention_tombstones' in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0 then
      raise exception using
        errcode = 'P0001',
        message = 'Unexpected retention function definition; tombstone insertion was not installed.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_insert || v_anchor);
    v_changed := true;
  end if;
  if v_changed then
    execute v_definition;
  end if;
end;
$block$;

-- The public preview intentionally remains four columns wide. Its visibility
-- gate now admits coordinate-less future rows while applying the same status,
-- date and quarantine rules as the search RPCs.
create or replace function app_private.auction_sale_is_publicly_visible(
  p_sale_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (
      select coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
        and app_private.sale_catalogue_entry_is_live(
          s.sale_date,
          (case
            when jsonb_typeof(coalesce(s.raw_payload, '{}'::jsonb)) = 'object'
              then coalesce(s.raw_payload, '{}'::jsonb)
            else '{}'::jsonb
           end) || jsonb_build_object('sale_procedure', coalesce(s.sale_procedure, '{}'::jsonb))
        )
        and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
      from public.auction_sales s
      where s.id = p_sale_id
    ),
    false
  );
$function$;

revoke all on function app_private.auction_sale_is_publicly_visible(uuid)
  from public, anon, authenticated;
grant execute on function app_private.auction_sale_is_publicly_visible(uuid)
  to anon, authenticated, service_role;

alter policy auction_sales_public_preview_read
on public.auction_sales
to anon
using (app_private.auction_sale_is_publicly_visible(id));

create or replace view public.v_auction_sales_app_preview
with (security_invoker = true)
as
select
  s.id,
  s.starting_price_eur,
  s.sale_venue_type,
  s.sale_verification_status
from public.auction_sales s
where app_private.auction_sale_is_publicly_visible(s.id);

-- The current view definitions are intentionally read and rewritten instead
-- of copied here: this keeps every premium projection and its grants intact
-- while making the predicate change independent of the long projection list.
do $block$
declare
  v_name text;
  v_definition text;
  v_old_live_qualified constant text := $old_live_qualified$app_private.sale_catalogue_entry_is_live(s.sale_date, s.raw_payload)$old_live_qualified$;
  v_old_live_unqualified constant text := $old_live_unqualified$app_private.sale_catalogue_entry_is_live(sale_date, raw_payload)$old_live_unqualified$;
  v_new_live constant text := $new_live$app_private.sale_catalogue_entry_is_live(
      s.sale_date,
      (CASE
        WHEN jsonb_typeof(COALESCE(s.raw_payload, '{}'::jsonb)) = 'object'
          THEN COALESCE(s.raw_payload, '{}'::jsonb)
        ELSE '{}'::jsonb
       END) || jsonb_build_object('sale_procedure', COALESCE(s.sale_procedure, '{}'::jsonb))
    )$new_live$;
  v_old constant text := $old$WHERE (s.status = ANY (ARRAY['upcoming'::text, 'unknown'::text, 'postponed'::text])) AND COALESCE(s.raw_payload ->> 'publication_quarantine'::text, ''::text) = ''::text$old$;
  v_old_unqualified constant text := $old_unqualified$WHERE (status = ANY (ARRAY['upcoming'::text, 'unknown'::text, 'postponed'::text])) AND COALESCE(raw_payload ->> 'publication_quarantine'::text, ''::text) = ''::text$old_unqualified$;
  v_new constant text := $new$WHERE s.status = ANY (ARRAY['upcoming'::text, 'unknown'::text, 'postponed'::text])
    AND app_private.sale_catalogue_entry_is_live(
      s.sale_date,
      (CASE
        WHEN jsonb_typeof(COALESCE(s.raw_payload, '{}'::jsonb)) = 'object'
          THEN COALESCE(s.raw_payload, '{}'::jsonb)
        ELSE '{}'::jsonb
       END) || jsonb_build_object('sale_procedure', COALESCE(s.sale_procedure, '{}'::jsonb))
    )
    AND COALESCE(s.raw_payload ->> 'publication_quarantine'::text, ''::text) = ''::text$new$;
begin
  for v_name, v_definition in
    select view_row.relname, pg_catalog.pg_get_viewdef(view_row.oid, true)
    from pg_catalog.pg_class view_row
    join pg_catalog.pg_namespace schema_row on schema_row.oid = view_row.relnamespace
    where schema_row.nspname = 'public'
      and view_row.relname in ('v_auction_sales_app', 'v_auction_sales_discovery')
      and view_row.relkind = 'v'
  loop
    if position('app_private.sale_catalogue_entry_is_live' in v_definition) > 0 then
      if position(v_new_live in v_definition) = 0 then
        if position(v_old_live_qualified in v_definition) > 0 then
          v_definition := replace(v_definition, v_old_live_qualified, v_new_live);
        elsif position(v_old_live_unqualified in v_definition) > 0 then
          v_definition := replace(v_definition, v_old_live_unqualified, v_new_live);
        elsif position('jsonb_build_object(''sale_procedure''' in v_definition) > 0 then
          null;
        else
          raise exception using
            errcode = 'P0001',
            message = 'Unexpected catalogue view definition; procedure window predicate was not installed.';
        end if;
      end if;
      if v_name = 'v_auction_sales_app' then
        execute 'create or replace view public.v_auction_sales_app with (security_invoker = true) as ' || v_definition;
      else
        -- Discovery deliberately remains a security-definer barrier view.
        -- auction_sales is RLS-protected and authenticated users read this
        -- projection through its owner, as in the existing production view.
        execute 'create or replace view public.v_auction_sales_discovery with (security_invoker = false, security_barrier = true) as ' || v_definition;
      end if;
    else
      if position(v_old in v_definition) > 0 then
        v_definition := replace(v_definition, v_old, v_new);
      elsif position(v_old_unqualified in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_unqualified, v_new);
      else
        raise exception using
          errcode = 'P0001',
          message = 'Unexpected catalogue view definition; future-only predicate was not installed.';
      end if;
      if v_name = 'v_auction_sales_app' then
        execute 'create or replace view public.v_auction_sales_app with (security_invoker = true) as ' || v_definition;
      else
        -- Keep the existing discovery security boundary when installing the
        -- future-only predicate on a pre-policy view as well.
        execute 'create or replace view public.v_auction_sales_discovery with (security_invoker = false, security_barrier = true) as ' || v_definition;
      end if;
    end if;
  end loop;
end;
$block$;

-- PostgREST cannot express a CASE expression in its order builder. Dedicated
-- search projections expose a stable rank so mapped rows are ordered first,
-- while the original detail/discovery view contracts stay unchanged.
create or replace view public.v_auction_sales_app_search
with (security_invoker = true)
as
select
  sale_view.*,
  case
    when sale_view.latitude is null or sale_view.longitude is null then 1
    else 0
  end as coordinates_rank
from public.v_auction_sales_app sale_view;

create or replace view public.v_auction_sales_discovery_search
with (security_invoker = false, security_barrier = true)
as
select
  sale_view.*,
  case
    when sale_view.latitude is null or sale_view.longitude is null then 1
    else 0
  end as coordinates_rank
from public.v_auction_sales_discovery sale_view;

revoke all on table public.v_auction_sales_app_search, public.v_auction_sales_discovery_search
  from public, anon;
grant select on table public.v_auction_sales_app_search, public.v_auction_sales_discovery_search
  to authenticated, service_role;

-- Apply the same predicate before count, ordering, pagination and the map
-- coordinate projection. Coordinate-bearing rows sort first, while rows with
-- no coordinates remain in the list and can still be opened or enriched.
do $block$
declare
  v_definition text;
  v_proc oid;
  v_signature text;
  v_status_anchor text;
  v_old_live_qualified constant text := $old_live_qualified$app_private.sale_catalogue_entry_is_live(s.sale_date, s.raw_payload)$old_live_qualified$;
  v_old_live_unqualified constant text := $old_live_unqualified$app_private.sale_catalogue_entry_is_live(sale_date, raw_payload)$old_live_unqualified$;
  v_new_live constant text := $new_live$app_private.sale_catalogue_entry_is_live(
        s.sale_date,
        (CASE
          WHEN jsonb_typeof(COALESCE(s.raw_payload, '{}'::jsonb)) = 'object'
            THEN COALESCE(s.raw_payload, '{}'::jsonb)
          ELSE '{}'::jsonb
         END) || jsonb_build_object('sale_procedure', COALESCE(s.sale_procedure, '{}'::jsonb))
      )$new_live$;
  v_status_replacement constant text := $replacement$where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
      and app_private.sale_catalogue_entry_is_live(
        s.sale_date,
        (CASE
          WHEN jsonb_typeof(COALESCE(s.raw_payload, '{}'::jsonb)) = 'object'
            THEN COALESCE(s.raw_payload, '{}'::jsonb)
          ELSE '{}'::jsonb
         END) || jsonb_build_object('sale_procedure', COALESCE(s.sale_procedure, '{}'::jsonb))
      )$replacement$;
  v_filtered_anchor constant text := $filtered$  with filtered as (
    select
$filtered$;
  v_coordinate_rank_projection constant text := $rank$      case
        when s.latitude is null or s.longitude is null then 1
        else 0
      end as coordinates_rank,
$rank$;
  v_order_anchor constant text := $order$  order by
$order$;
  v_order_replacement constant text := $order$  order by
    counted.coordinates_rank,
$order$;
  v_old_order_replacement constant text := $old_order$  order by
    case when counted.latitude is null or counted.longitude is null then 1 else 0 end,
$old_order$;
  v_coordinate_guard constant text := $coordinates$      and s.latitude is not null
      and s.longitude is not null
$coordinates$;
begin
  foreach v_signature in array array[
    'app_private.search_auction_sales_preview(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer)',
    'app_private.search_auction_sales_preview_v2(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)',
    'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)',
    'app_private.search_auction_sales_preview_v4(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text,date,date)'
  ]
  loop
    v_proc := pg_catalog.to_regprocedure(v_signature)::oid;
    if v_proc is null then
      continue;
    end if;
    select pg_catalog.pg_get_functiondef(v_proc) into v_definition;
    v_status_anchor := case
      when v_signature like '%preview_v4%' then $$where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')$$
      else $$where coalesce(s.status, 'unknown') in ('upcoming', 'unknown')$$
    end;

    if position(v_new_live in v_definition) = 0 then
      if position(v_old_live_qualified in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_live_qualified, v_new_live);
      elsif position(v_old_live_unqualified in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_live_unqualified, v_new_live);
      elsif position('jsonb_build_object(''sale_procedure''' in v_definition) > 0 then
        null;
      else
      if position(v_status_anchor in v_definition) = 0 then
        raise exception using
          errcode = 'P0001',
          message = 'Unexpected preview function definition; future-only predicate was not installed.';
      end if;
      v_definition := replace(v_definition, v_status_anchor, v_status_replacement);
      end if;
    end if;
    if position(v_coordinate_guard in v_definition) > 0 then
      v_definition := replace(v_definition, v_coordinate_guard, '');
    end if;
    -- The v1/v2 filtered CTEs do not return latitude/longitude, so ranking
    -- from counted.latitude would fail at CREATE FUNCTION time. Materialize
    -- only an internal rank in filtered; every public SELECT remains exactly
    -- its declared return contract.
    if position('coordinates_rank' in v_definition) = 0 then
      if position(v_filtered_anchor in v_definition) = 0 then
        raise exception using
          errcode = 'P0001',
          message = 'Unexpected preview function definition; internal coordinate rank was not installed.';
      end if;
      v_definition := replace(v_definition, v_filtered_anchor, v_filtered_anchor || v_coordinate_rank_projection);
    end if;
    if position(v_order_replacement in v_definition) = 0 then
      if position(v_old_order_replacement in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_order_replacement, v_order_replacement);
      elsif position(v_order_anchor in v_definition) > 0 then
        v_definition := replace(v_definition, v_order_anchor, v_order_replacement);
      else
        raise exception using
          errcode = 'P0001',
          message = 'Unexpected preview function definition; coordinate ranking was not installed.';
      end if;
    end if;
    execute v_definition;
  end loop;
end;
$block$;

notify pgrst, 'reload schema';

commit;
