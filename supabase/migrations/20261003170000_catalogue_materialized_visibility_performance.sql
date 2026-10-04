-- The catalogue expiry migration materializes the exact visibility cutoff for
-- every sale.  The public preview and catalogue views were still invoking the
-- JSONB/date parser for every row, which made an otherwise simple anonymous
-- search exceed the API statement timeout.  Read the materialized deadline on
-- the hot path and keep the parser only as a compatibility fallback for rows
-- whose deadline is deliberately null (postponed/conflicting/legacy data).
create or replace function app_private.sale_catalogue_entry_is_live_materialized(
  p_materialized boolean,
  p_deadline timestamptz,
  p_sale_date timestamptz,
  p_raw jsonb,
  p_sale_procedure jsonb
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when coalesce(p_materialized, false) and p_deadline is not null
      then p_deadline > current_timestamp
    else app_private.sale_catalogue_entry_is_live(
      p_sale_date,
      (case
        when jsonb_typeof(coalesce(p_raw, '{}'::jsonb)) = 'object'
          then coalesce(p_raw, '{}'::jsonb)
        else '{}'::jsonb
       end) || jsonb_build_object('sale_procedure', coalesce(p_sale_procedure, '{}'::jsonb))
    )
  end;
$function$;

revoke all on function app_private.sale_catalogue_entry_is_live_materialized(
  boolean, timestamptz, timestamptz, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function app_private.sale_catalogue_entry_is_live_materialized(
  boolean, timestamptz, timestamptz, jsonb, jsonb
) to anon, authenticated, service_role;

-- The retention worker uses INSERT ... ON CONFLICT DO UPDATE when it records a
-- source tombstone.  INSERT alone is insufficient for that conflict path.
grant update on table public.auction_sale_retention_tombstones to service_role;

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
        and app_private.sale_catalogue_entry_is_live_materialized(
          s.catalogue_expiry_materialized,
          s.catalogue_expiry_deadline,
          s.sale_date,
          s.raw_payload,
          s.sale_procedure
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

-- Keep the existing projections, grants and security options.  Only replace
-- the visibility expression in the two base views; their search companions
-- inherit the optimized predicate.
do $views$
declare
  v_name text;
  v_definition text;
  v_old_live constant text := $old$app_private.sale_catalogue_entry_is_live(sale_date,
        CASE
            WHEN jsonb_typeof(COALESCE(raw_payload, '{}'::jsonb)) = 'object'::text THEN COALESCE(raw_payload, '{}'::jsonb)
            ELSE '{}'::jsonb
        END || jsonb_build_object('sale_procedure', COALESCE(sale_procedure, '{}'::jsonb)))$old$;
  v_old_live_qualified constant text := $old_qualified$app_private.sale_catalogue_entry_is_live(s.sale_date,
        CASE
            WHEN jsonb_typeof(COALESCE(s.raw_payload, '{}'::jsonb)) = 'object'::text THEN COALESCE(s.raw_payload, '{}'::jsonb)
            ELSE '{}'::jsonb
        END || jsonb_build_object('sale_procedure', COALESCE(s.sale_procedure, '{}'::jsonb)))$old_qualified$;
  v_new_live constant text := $new$app_private.sale_catalogue_entry_is_live_materialized(
        s.catalogue_expiry_materialized,
        s.catalogue_expiry_deadline,
        s.sale_date,
        s.raw_payload,
        s.sale_procedure
      )$new$;
begin
  for v_name, v_definition in
    select view_row.relname, pg_catalog.pg_get_viewdef(view_row.oid, true)
    from pg_catalog.pg_class view_row
    join pg_catalog.pg_namespace schema_row on schema_row.oid = view_row.relnamespace
    where schema_row.nspname = 'public'
      and view_row.relname in ('v_auction_sales_app', 'v_auction_sales_discovery')
      and view_row.relkind = 'v'
  loop
    if position('app_private.sale_catalogue_entry_is_live_materialized(' in v_definition) = 0 then
      if position(v_old_live_qualified in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_live_qualified, v_new_live);
      elsif position(v_old_live in v_definition) > 0 then
        v_definition := replace(v_definition, v_old_live, v_new_live);
      else
        raise exception using
          errcode = 'P0001',
          message = 'Unexpected catalogue view definition; materialized visibility was not installed.';
      end if;
    end if;

    if v_name = 'v_auction_sales_app' then
      execute 'create or replace view public.v_auction_sales_app with (security_invoker = true) as ' || v_definition;
    else
      execute 'create or replace view public.v_auction_sales_discovery with (security_invoker = false, security_barrier = true) as ' || v_definition;
    end if;
  end loop;
end;
$views$;

-- The four preview versions share the same stable return contracts.  Replace
-- only their internal live predicate, leaving filters, count, ordering and
-- pagination unchanged.
do $previews$
declare
  v_definition text;
  v_signature text;
  v_old_live constant text := $old$app_private.sale_catalogue_entry_is_live(
        s.sale_date,
        (CASE
          WHEN jsonb_typeof(COALESCE(s.raw_payload, '{}'::jsonb)) = 'object'
            THEN COALESCE(s.raw_payload, '{}'::jsonb)
          ELSE '{}'::jsonb
         END) || jsonb_build_object('sale_procedure', COALESCE(s.sale_procedure, '{}'::jsonb))
      )$old$;
  v_new_live constant text := $new$app_private.sale_catalogue_entry_is_live_materialized(
        s.catalogue_expiry_materialized,
        s.catalogue_expiry_deadline,
        s.sale_date,
        s.raw_payload,
        s.sale_procedure
      )$new$;
begin
  foreach v_signature in array array[
    'app_private.search_auction_sales_preview(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer)',
    'app_private.search_auction_sales_preview_v2(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)',
    'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)',
    'app_private.search_auction_sales_preview_v4(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text,date,date)'
  ]
  loop
    if pg_catalog.to_regprocedure(v_signature) is null then
      continue;
    end if;
    select pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature)::oid)
      into v_definition;

    if position(v_new_live in v_definition) = 0 then
      if position(v_old_live in v_definition) = 0 then
        raise exception using
          errcode = 'P0001',
          message = 'Unexpected preview function definition; materialized visibility was not installed.';
      end if;
      v_definition := replace(v_definition, v_old_live, v_new_live);
      execute v_definition;
    end if;
  end loop;
end;
$previews$;

notify pgrst, 'reload schema';
