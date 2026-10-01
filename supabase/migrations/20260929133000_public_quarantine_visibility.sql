begin;

-- Keep publication quarantine enforceable for every caller of the teaser
-- view, including authenticated clients.  The helper is security definer so
-- the security-invoker view does not need to grant anon access to raw_payload.
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
      select coalesce(s.raw_payload->>'publication_quarantine', '') = ''
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

comment on function app_private.auction_sale_is_publicly_visible(uuid) is
  'Returns true only when a sale has no publication quarantine marker.';

-- Authenticated premium clients have direct SELECT on auction_sales in
-- addition to the curated views.  Preserve the admin review path, but make
-- the publication marker effective for every other authenticated caller.
alter policy auction_sales_authenticated_read on public.auction_sales
using (
  public.is_admin()
  or (
    public.has_analysis_access()
    and public.catalogue_readiness_allows_premium(
      premium_readiness_status,
      premium_readiness_override,
      premium_readiness_override_expires_at
    )
    and coalesce(raw_payload->>'publication_quarantine', '') = ''
  )
);

-- The preview keeps its four-column API contract while applying the same
-- publication gate to anonymous and authenticated callers.
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

-- Apply the gate inside all privileged search implementations, before the
-- count, ORDER BY, LIMIT and OFFSET.  Reading and rewriting the exact prior
-- definitions keeps every validation branch, argument and return column
-- unchanged while avoiding a post-pagination wrapper that would create short
-- pages and inflated total_count values.
do $block$
declare
  v_definition text;
  v_anchor constant text := $anchor$where coalesce(s.status, 'unknown') in ('upcoming', 'unknown')$anchor$;
  v_predicate constant text := $predicate$
      and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
$predicate$;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(
    'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'
  )::oid;

  if v_definition is null then
    raise exception using
      errcode = '42883',
      message = 'Missing app_private.search_auction_sales_preview_v3.';
  end if;

  if position(v_predicate in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0
      or (length(v_definition) - length(replace(v_definition, v_anchor, '')))
        <> length(v_anchor) then
      raise exception using
        errcode = 'P0001',
        message = 'Unexpected v3 preview function definition; quarantine predicate was not installed.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_anchor || v_predicate);
    execute v_definition;
  end if;
end;
$block$;

do $block$
declare
  v_definition text;
  v_anchor constant text := $anchor$where coalesce(s.status, 'unknown') in ('upcoming', 'unknown')$anchor$;
  v_predicate constant text := $predicate$
      and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
$predicate$;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(
    'app_private.search_auction_sales_preview(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer)'
  )::oid;

  if v_definition is null then
    raise exception using
      errcode = '42883',
      message = 'Missing app_private.search_auction_sales_preview.';
  end if;

  if position(v_predicate in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0
      or (length(v_definition) - length(replace(v_definition, v_anchor, '')))
        <> length(v_anchor) then
      raise exception using
        errcode = 'P0001',
        message = 'Unexpected v2 preview function definition; quarantine predicate was not installed.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_anchor || v_predicate);
    execute v_definition;
  end if;
end;
$block$;

do $block$
declare
  v_definition text;
  v_anchor constant text := $anchor$where coalesce(s.status, 'unknown') in ('upcoming', 'unknown')$anchor$;
  v_predicate constant text := $predicate$
      and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
$predicate$;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
  from pg_catalog.pg_proc p
  where p.oid = pg_catalog.to_regprocedure(
    'app_private.search_auction_sales_preview_v2(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'
  )::oid;

  if v_definition is null then
    raise exception using
      errcode = '42883',
      message = 'Missing app_private.search_auction_sales_preview_v2.';
  end if;

  if position(v_predicate in v_definition) = 0 then
    if position(v_anchor in v_definition) = 0
      or (length(v_definition) - length(replace(v_definition, v_anchor, '')))
        <> length(v_anchor) then
      raise exception using
        errcode = 'P0001',
        message = 'Unexpected v2 preview function definition; quarantine predicate was not installed.';
    end if;
    v_definition := replace(v_definition, v_anchor, v_anchor || v_predicate);
    execute v_definition;
  end if;
end;
$block$;

notify pgrst, 'reload schema';

commit;
