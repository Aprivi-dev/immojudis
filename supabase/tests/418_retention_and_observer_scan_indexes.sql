begin;

select plan(10);

select ok(
  to_regclass('public.auction_sales_retention_fallback_candidate_idx') is not null,
  'retention fallback candidates have a partial index'
);
select ok(
  to_regclass('public.auction_enrichment_jobs_revision_detail_idx') is not null,
  'observer revision ranking has a covering order index'
);
select ok(
  position('with retention_candidates as (' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0,
  'purge separates materialized and fallback candidates'
);
select ok(
  position('union all' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0,
  'purge candidate branches are explicitly append-only and disjoint'
);
select ok(
  position('is not true' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0,
  'fallback retains materialized rows whose deadline is null'
);
select ok(
  position('limit least(p_limit, 1)' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0,
  'purge retains the one-row transaction budget'
);
select ok(
  position('pg_try_advisory_xact_lock' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('nowait' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0,
  'purge retains both concurrency protections'
);

create temporary table retention_equivalence_fixture(
  id integer primary key,
  sale_date timestamptz,
  status text,
  raw_payload jsonb,
  sale_procedure jsonb,
  catalogue_expiry_materialized boolean,
  catalogue_expiry_deadline timestamptz
) on commit drop;

insert into retention_equivalence_fixture values
  (1, '2026-10-04 10:00Z', 'upcoming',  '{}'::jsonb, '{}'::jsonb, true,  '2026-10-04 11:00Z'),
  (2, '2026-10-04 10:00Z', 'postponed', '{}'::jsonb, '{}'::jsonb, true,  null),
  (3, '2026-10-04 10:00Z', 'postponed', '{}'::jsonb, '{}'::jsonb, false, null),
  (4, '2026-10-04 10:00Z', 'postponed', '{}'::jsonb, '{}'::jsonb, true,  '2026-10-04 13:00Z'),
  (5, '2026-10-04 10:00Z', 'upcoming',  '{}'::jsonb, '{}'::jsonb, true,  '2026-10-04 13:00Z'),
  (6, '2026-10-04 10:00Z', 'upcoming',  '{"status":"reported"}'::jsonb, '{}'::jsonb, true, null),
  (7, '2026-10-04 10:00Z', 'upcoming',  '{}'::jsonb, '{}'::jsonb, true, null),
  (8, '2026-10-04 13:00Z', 'postponed', '{}'::jsonb, '{}'::jsonb, true, null);

select is(
  (
    with params as (select '2026-10-04 12:00Z'::timestamptz as p_now),
    original as (
      select fixture.id
        from retention_equivalence_fixture fixture, params
       where (
               fixture.catalogue_expiry_materialized
               and fixture.catalogue_expiry_deadline <= params.p_now
             )
          or (
               (
                 fixture.status = 'postponed'
                 or lower(coalesce(fixture.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
               )
               and app_private.sale_catalogue_expiry(
                     fixture.sale_date,
                     (case
                       when jsonb_typeof(coalesce(fixture.raw_payload, '{}'::jsonb)) = 'object'
                         then coalesce(fixture.raw_payload, '{}'::jsonb)
                       else '{}'::jsonb
                      end) || jsonb_build_object('sale_procedure', coalesce(fixture.sale_procedure, '{}'::jsonb))
                   ) <= params.p_now
             )
    )
    select count(*) from original
  ),
  5::bigint,
  'the original retention predicate selects the expected fixture set'
);

select is(
  (
    with params as (select '2026-10-04 12:00Z'::timestamptz as p_now),
    original as (
      select fixture.id
        from retention_equivalence_fixture fixture, params
       where (
               fixture.catalogue_expiry_materialized
               and fixture.catalogue_expiry_deadline <= params.p_now
             )
          or (
               (
                 fixture.status = 'postponed'
                 or lower(coalesce(fixture.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
               )
               and app_private.sale_catalogue_expiry(
                     fixture.sale_date,
                     (case
                       when jsonb_typeof(coalesce(fixture.raw_payload, '{}'::jsonb)) = 'object'
                         then coalesce(fixture.raw_payload, '{}'::jsonb)
                       else '{}'::jsonb
                      end) || jsonb_build_object('sale_procedure', coalesce(fixture.sale_procedure, '{}'::jsonb))
                   ) <= params.p_now
             )
    ),
    optimized as (
      with retention_candidates as (
        select fixture.id
          from retention_equivalence_fixture fixture, params
         where fixture.catalogue_expiry_materialized
           and fixture.catalogue_expiry_deadline <= params.p_now
        union all
        select fixture.id
          from retention_equivalence_fixture fixture, params
         where (
                 fixture.status = 'postponed'
                 or lower(coalesce(fixture.raw_payload->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
               )
           and (
                 fixture.catalogue_expiry_materialized
                 and fixture.catalogue_expiry_deadline <= params.p_now
               ) is not true
           and app_private.sale_catalogue_expiry(
                 fixture.sale_date,
                 (case
                   when jsonb_typeof(coalesce(fixture.raw_payload, '{}'::jsonb)) = 'object'
                     then coalesce(fixture.raw_payload, '{}'::jsonb)
                   else '{}'::jsonb
                  end) || jsonb_build_object('sale_procedure', coalesce(fixture.sale_procedure, '{}'::jsonb))
               ) <= params.p_now
      )
      select id from retention_candidates
    ),
    differences as (
      (select id from original except select id from optimized)
      union all
      (select id from optimized except select id from original)
    )
    select count(*) from differences
  ),
  0::bigint,
  'the indexed candidate rewrite is set-equivalent including null deadlines'
);

select ok(
  position('detail_source_name' in (select indexdef from pg_indexes where indexname = 'auction_enrichment_jobs_revision_detail_idx')) > 0
  and position('pipeline_v2:%' in (select indexdef from pg_indexes where indexname = 'auction_enrichment_jobs_revision_detail_idx')) > 0
  and position('status <> ''cancelled''' in (select indexdef from pg_indexes where indexname = 'auction_enrichment_jobs_revision_detail_idx')) > 0,
  'observer index matches the revision partition, ranking expression and active-row fence'
);

select * from finish();
rollback;
