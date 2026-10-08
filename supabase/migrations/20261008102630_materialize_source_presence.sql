begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Source presence is operational state, not source evidence. Keep it out of
-- auction_sales.raw_payload so each inventory completion does not rewrite a
-- wide sale row and re-run its history/projection triggers.
create table if not exists app_private.auction_sale_source_presence (
  sale_id uuid not null
    references public.auction_sales(id) on delete cascade,
  source_name text not null,
  availability text not null
    check (availability in ('unchecked','available','partial','unavailable','access_denied')),
  state text,
  attempted_at timestamptz,
  checked_at timestamptz,
  run_id text,
  extras jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(extras) = 'object'),
  legacy_raw boolean not null default false,
  primary key (sale_id, source_name)
);

comment on table app_private.auction_sale_source_presence is
  'Compact operational source-presence state; source evidence remains in auction_sales.raw_payload.';

create index if not exists auction_sale_source_presence_source_idx
  on app_private.auction_sale_source_presence (source_name, sale_id);

alter table app_private.auction_sale_source_presence enable row level security;
revoke all on table app_private.auction_sale_source_presence
  from public, anon, authenticated, service_role;
grant select, insert, update on table app_private.auction_sale_source_presence
  to service_role;
drop policy if exists auction_sale_source_presence_service_role
  on app_private.auction_sale_source_presence;
create policy auction_sale_source_presence_service_role
  on app_private.auction_sale_source_presence
  for all to service_role
  using (true)
  with check (true);

-- The compatibility shape is installed before any historical backfill.
alter table app_private.auction_sale_source_presence
  alter column attempted_at drop default,
  alter column attempted_at drop not null;

comment on column app_private.auction_sale_source_presence.extras is
  'Lossless source_presence metadata not represented by the compact operational columns.';
comment on column app_private.auction_sale_source_presence.attempted_at is
  'Nullable because legacy source_presence entries may omit or null this timestamp; never synthesize a timestamp during compatibility sync.';

create or replace function app_private.sync_auction_sale_source_presence(
  p_sale_id uuid,
  p_source_presence jsonb,
  p_previous_source_presence jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_presence jsonb;
  v_previous_presence jsonb;
begin
  v_presence := case
    when pg_catalog.jsonb_typeof(p_source_presence) = 'object' then p_source_presence
    else '{}'::jsonb
  end;
  v_previous_presence := case
    when pg_catalog.jsonb_typeof(p_previous_source_presence) = 'object'
      then p_previous_source_presence
    else '{}'::jsonb
  end;

  -- A changed legacy object is a replacement only for the legacy keys that
  -- were present in the previous raw object.  Compact rows written by a new
  -- worker are deliberately preserved when an old worker sends a raw object
  -- that does not know those source names.
  delete from app_private.auction_sale_source_presence existing_row
   where existing_row.sale_id = p_sale_id
     and existing_row.legacy_raw
     and exists (
       select 1
         from pg_catalog.jsonb_each(v_previous_presence) previous_entry
        where previous_entry.key = existing_row.source_name
     )
     and not exists (
       select 1
         from pg_catalog.jsonb_each(v_presence) incoming
        where incoming.key = existing_row.source_name
     );

  insert into app_private.auction_sale_source_presence (
    sale_id,
    source_name,
    availability,
    state,
    attempted_at,
    checked_at,
    run_id,
    extras,
    legacy_raw
  )
  select p_sale_id,
         incoming.key,
         case
           when pg_catalog.jsonb_typeof(incoming.value) = 'object'
             and incoming.value->>'availability' in
               ('unchecked','available','partial','unavailable','access_denied')
             then incoming.value->>'availability'
           else 'unchecked'
         end,
         case
           when pg_catalog.jsonb_typeof(incoming.value) = 'object'
             then nullif(incoming.value->>'state', '')
           else null
         end,
         case
           when pg_catalog.jsonb_typeof(incoming.value) = 'object'
             then app_private.pipeline_checked_at(incoming.value->>'attempted_at')
           else null
         end,
         case
           when pg_catalog.jsonb_typeof(incoming.value) = 'object'
             then app_private.pipeline_checked_at(incoming.value->>'checked_at')
           else null
         end,
         case
           when pg_catalog.jsonb_typeof(incoming.value) = 'object'
             then nullif(incoming.value->>'run_id', '')
           else null
         end,
         (
           case
             when pg_catalog.jsonb_typeof(incoming.value) = 'object' then
               incoming.value - array[
                 'availability', 'state', 'attempted_at', 'checked_at', 'run_id'
               ]::text[]
             else
               pg_catalog.jsonb_build_object('_raw_entry', incoming.value)
           end
           || case
             when pg_catalog.jsonb_typeof(incoming.value) = 'object'
               and incoming.value ? 'availability'
               and coalesce(incoming.value->>'availability', '') not in
                 ('unchecked','available','partial','unavailable','access_denied')
               then pg_catalog.jsonb_build_object(
                 '_raw_availability', incoming.value->'availability'
               )
             else '{}'::jsonb
           end
           || case
             when pg_catalog.jsonb_typeof(incoming.value) = 'object'
               and incoming.value ? 'state'
               and pg_catalog.jsonb_typeof(incoming.value->'state') <> 'string'
               then pg_catalog.jsonb_build_object(
                 '_raw_state', incoming.value->'state'
               )
             else '{}'::jsonb
           end
           || case
             when pg_catalog.jsonb_typeof(incoming.value) = 'object'
               and incoming.value ? 'attempted_at'
               and pg_catalog.jsonb_typeof(incoming.value->'attempted_at') <> 'null'
               and app_private.pipeline_checked_at(incoming.value->>'attempted_at') is null
               then pg_catalog.jsonb_build_object(
                 '_raw_attempted_at', incoming.value->'attempted_at'
               )
             else '{}'::jsonb
           end
           || case
             when pg_catalog.jsonb_typeof(incoming.value) = 'object'
               and incoming.value ? 'checked_at'
               and pg_catalog.jsonb_typeof(incoming.value->'checked_at') <> 'null'
               and app_private.pipeline_checked_at(incoming.value->>'checked_at') is null
               then pg_catalog.jsonb_build_object(
                 '_raw_checked_at', incoming.value->'checked_at'
               )
             else '{}'::jsonb
           end
           || case
             when pg_catalog.jsonb_typeof(incoming.value) = 'object'
               and incoming.value ? 'run_id'
               and pg_catalog.jsonb_typeof(incoming.value->'run_id') <> 'string'
               then pg_catalog.jsonb_build_object(
                 '_raw_run_id', incoming.value->'run_id'
               )
             else '{}'::jsonb
           end
         ),
         true
    from pg_catalog.jsonb_each(v_presence) incoming
   where incoming.key <> ''
  on conflict (sale_id, source_name) do update
    set availability = excluded.availability,
        state = excluded.state,
        attempted_at = excluded.attempted_at,
        checked_at = excluded.checked_at,
        run_id = excluded.run_id,
        extras = excluded.extras,
        legacy_raw = excluded.legacy_raw;
end;
$function$;

revoke execute on function app_private.sync_auction_sale_source_presence(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create or replace function app_private.sync_auction_sale_source_presence_raw_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
     and new.raw_payload->'source_presence'
         is not distinct from old.raw_payload->'source_presence' then
    return new;
  end if;

  perform app_private.sync_auction_sale_source_presence(
    new.id,
    new.raw_payload->'source_presence',
    case when tg_op = 'UPDATE' then old.raw_payload->'source_presence' else null end
  );
  return new;
end;
$function$;

revoke execute on function app_private.sync_auction_sale_source_presence_raw_trigger()
  from public, anon, authenticated, service_role;
grant execute on function app_private.sync_auction_sale_source_presence_raw_trigger()
  to service_role;

-- Hold the same table lock explicitly across trigger installation and the
-- backfill.  CREATE TRIGGER also takes a ShareRowExclusiveLock, but making the
-- cutover lock visible here prevents a concurrent legacy writer from changing
-- raw_payload between the backfill snapshot and trigger installation.
lock table public.auction_sales in share row exclusive mode;

drop trigger if exists auction_sales_sync_source_presence_raw
  on public.auction_sales;
create trigger auction_sales_sync_source_presence_raw
  after insert or update of raw_payload on public.auction_sales
  for each row
  execute function app_private.sync_auction_sale_source_presence_raw_trigger();

-- Reconcile existing raw rows without inventing timestamps.  Calling the same
-- helper as the trigger makes the one-time repair and future old-worker writes
-- obey the exact same lossless normalization rules.
select app_private.sync_auction_sale_source_presence(
  sale.id,
  sale.raw_payload->'source_presence'
)
  from public.auction_sales sale
 where pg_catalog.jsonb_typeof(sale.raw_payload->'source_presence') = 'object';

-- Preserve extras in the compatibility JSON projection while canonical fields
-- remain normalized and null canonical timestamps remain omitted as before.
create or replace function app_private.auction_sale_source_presence_json(
  p_sale_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    pg_catalog.jsonb_object_agg(
      presence.source_name,
      coalesce(presence.extras, '{}'::jsonb)
      || pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'availability', presence.availability,
          'state', presence.state,
          'attempted_at', presence.attempted_at,
          'checked_at', presence.checked_at,
          'run_id', presence.run_id
        )
      )
      order by presence.source_name
    ),
    '{}'::jsonb
  )
    from app_private.auction_sale_source_presence presence
   where presence.sale_id = p_sale_id;
$function$;

revoke execute on function app_private.auction_sale_source_presence_json(uuid)
  from public, anon, authenticated, service_role;
grant execute on function app_private.auction_sale_source_presence_json(uuid)
  to authenticated, service_role;
do $grants$
begin
  if exists (
    select 1 from pg_catalog.pg_roles where rolname = 'lovable_readonly'
  ) then
    execute 'grant execute on function app_private.auction_sale_source_presence_json(uuid) to lovable_readonly';
  end if;
end;
$grants$;

-- Keep the service-role compatibility view additive and lossless.
create or replace view public.auction_sale_source_presence
as
select sale_id, source_name, availability, state,
       attempted_at, checked_at, run_id, extras
  from app_private.auction_sale_source_presence;

revoke all on table public.auction_sale_source_presence
  from public, anon, authenticated, service_role;
grant select on table public.auction_sale_source_presence to service_role;

-- Replace only the source-presence expression in the current catalogue views.
-- Reading and rewriting the current definitions keeps all existing redactions,
-- filters, visibility predicates and grants intact. Fail closed if a later
-- migration has changed the expression unexpectedly.
do $views$
declare
  v_name text;
  v_definition text;
  v_old_qualified constant text := $old$COALESCE(s.raw_payload -> 'source_presence'::text, '{}'::jsonb) AS source_presence$old$;
  v_old_simple constant text := $old_simple$COALESCE(raw_payload -> 'source_presence'::text, '{}'::jsonb) AS source_presence$old_simple$;
  v_old_unqualified constant text := $old_unqualified$coalesce(s.raw_payload->'source_presence','{}'::jsonb) as source_presence$old_unqualified$;
  v_new constant text := $new$app_private.auction_sale_source_presence_json(s.id) AS source_presence$new$;
begin
  for v_name in
    select view_row.relname
      from pg_catalog.pg_class view_row
      join pg_catalog.pg_namespace schema_row
        on schema_row.oid = view_row.relnamespace
     where schema_row.nspname = 'public'
       and view_row.relname in ('v_auction_sales_app', 'v_auction_sales_discovery')
       and view_row.relkind = 'v'
     order by view_row.relname
  loop
    v_definition := pg_catalog.pg_get_viewdef(
      format('public.%I', v_name)::regclass,
      true
    );

    -- A replay after the marker has been installed must be a true no-op. In
    -- particular, do not issue CREATE OR REPLACE again: it needlessly rewrites
    -- the view dependency and can make an otherwise harmless replay contend
    -- with readers.
    if position('app_private.auction_sale_source_presence_json(' in v_definition) = 0 then
      if position(v_old_qualified in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_qualified, v_new);
      elsif position(v_old_simple in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_simple, v_new);
      elsif position(v_old_unqualified in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_unqualified, v_new);
      else
        raise exception using
          errcode = 'P0001',
          message = format(
            'Unexpected %s view definition; compact source presence was not installed.',
            v_name
          );
      end if;
      if v_name = 'v_auction_sales_app' then
        execute 'create or replace view public.v_auction_sales_app with (security_invoker = true) as ' || v_definition;
      else
        execute 'create or replace view public.v_auction_sales_discovery with (security_invoker = false, security_barrier = true) as ' || v_definition;
      end if;
    end if;
  end loop;
end;
$views$;

notify pgrst, 'reload schema';

commit;
