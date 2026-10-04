begin;

select plan(10);

select ok(
  app_private.sale_catalogue_entry_is_live_materialized(
    true,
    '2099-01-01 12:00Z'::timestamptz,
    null,
    '[]'::jsonb,
    '[]'::jsonb
  ),
  'a materialized future deadline is live without parsing the raw payload'
);
select ok(
  not app_private.sale_catalogue_entry_is_live_materialized(
    true,
    '2000-01-01 12:00Z'::timestamptz,
    '2099-01-01 12:00Z'::timestamptz,
    '{}'::jsonb,
    '{}'::jsonb
  ),
  'a materialized elapsed deadline is not live'
);
select ok(
  app_private.sale_catalogue_entry_is_live_materialized(
    true,
    null,
    '2099-01-01 00:00Z'::timestamptz,
    '{"date_precision":"day"}'::jsonb,
    '{}'::jsonb
  ),
  'a null materialized deadline keeps the date-only fallback semantics'
);
select ok(
  not app_private.sale_catalogue_entry_is_live_materialized(
    true,
    null,
    '2000-01-01 00:00Z'::timestamptz,
    '{"date_precision":"day"}'::jsonb,
    '{}'::jsonb
  ),
  'the date-only fallback still expires an elapsed sale'
);

select ok(
  position('sale_catalogue_entry_is_live_materialized' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer)'::regprocedure
  ))) > 0,
  'preview v1 uses the materialized visibility fast path'
);
select ok(
  position('sale_catalogue_entry_is_live_materialized' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v2(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'::regprocedure
  ))) > 0,
  'preview v2 uses the materialized visibility fast path'
);
select ok(
  position('sale_catalogue_entry_is_live_materialized' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'::regprocedure
  ))) > 0,
  'preview v3 uses the materialized visibility fast path'
);
select ok(
  position('sale_catalogue_entry_is_live_materialized' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v4(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text,date,date)'::regprocedure
  ))) > 0,
  'preview v4 uses the materialized visibility fast path'
);

select ok(
  has_table_privilege('service_role', 'public.auction_sale_retention_tombstones', 'update'),
  'the retention worker can complete its tombstone upsert conflict path'
);
select ok(
  not has_table_privilege('anon', 'public.auction_sale_retention_tombstones', 'update')
  and not has_table_privilege('authenticated', 'public.auction_sale_retention_tombstones', 'update'),
  'tombstone updates remain unavailable to client roles'
);

select * from finish();
rollback;
