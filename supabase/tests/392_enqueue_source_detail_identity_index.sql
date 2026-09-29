begin;

select plan(10);

select ok(
  exists (
    select 1
    from pg_class index_relation
    join pg_namespace index_schema
      on index_schema.oid = index_relation.relnamespace
    where index_schema.nspname = 'public'
      and index_relation.relname = 'auction_enrichment_jobs_source_detail_open_idx'
      and index_relation.relkind = 'i'
  ),
  'source-detail open identity index exists'
);

select ok(
  exists (
    select 1
    from pg_index index_metadata
    join pg_class index_relation
      on index_relation.oid = index_metadata.indexrelid
    join pg_namespace index_schema
      on index_schema.oid = index_relation.relnamespace
    where index_schema.nspname = 'public'
      and index_relation.relname = 'auction_enrichment_jobs_source_detail_open_idx'
      and index_metadata.indpred is not null
      and position(
        'job_type' in lower(
          pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        )
      ) > 0
      and position(
        'status' in lower(
          pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        )
      ) > 0
      and position(
        'attempt_count' in lower(
          pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        )
      ) > 0
      and position(
        'max_attempts' in lower(
          pg_get_expr(index_metadata.indpred, index_metadata.indrelid)
        )
      ) > 0
  ),
  'source-detail index is partial on open and retryable jobs'
);

select is(
  (
    select string_agg(attribute.attname, ',' order by indexed_columns.ordinality)
    from pg_index index_metadata
    join pg_class index_relation
      on index_relation.oid = index_metadata.indexrelid
    join pg_namespace index_schema
      on index_schema.oid = index_relation.relnamespace
    cross join lateral unnest(index_metadata.indkey)
      with ordinality as indexed_columns(attnum, ordinality)
    join pg_attribute attribute
      on attribute.attrelid = index_metadata.indrelid
     and attribute.attnum = indexed_columns.attnum
    where index_schema.nspname = 'public'
      and index_relation.relname = 'auction_enrichment_jobs_source_detail_open_idx'
  ),
  'source_url,detail_source_name,detail_source_url',
  'source-detail index keys match the recurring identity'
);

select ok(
  regexp_count(
    lower(
      pg_get_functiondef(
        'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
      )
    ),
    'where not exists'
  ) = 2
  and position(
    'j.input_hash = d.signature' in lower(
      pg_get_functiondef(
        'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
      )
    )
  ) > 0
  and position(
    'j.status in (''queued'', ''running'')' in lower(
      pg_get_functiondef(
        'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
      )
    )
  ) > 0,
  'source-detail admission uses separate exact-signature and open-job anti-joins'
);

select ok(
  position(
    'j.status = ''failed''' in lower(
      pg_get_functiondef(
        'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
      )
    )
  ) > 0
  and position(
    'j.attempt_count < j.max_attempts' in lower(
      pg_get_functiondef(
        'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
      )
    )
  ) > 0,
  'retryable failed jobs remain part of the open identity predicate'
);

set local role service_role;

update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = true
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  suspended_until
)
values (
  'pgtap-source-detail-index',
  true,
  null
);

create temporary table pgtap_source_detail_clock (
  p_now timestamptz not null
) on commit drop;

insert into pgtap_source_detail_clock (p_now)
values (statement_timestamp());

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload,
  sale_procedure
)
values (
  'f3920000-0000-4000-8000-000000000001',
  'pgtap-source-detail-index',
  'https://example.test/pgtap/source-detail-index/canonical',
  'upcoming',
  (select p_now + interval '2 days' from pgtap_source_detail_clock),
  '{}'::jsonb,
  '{}'::jsonb
);

delete from public.auction_enrichment_jobs
 where source_url = 'https://example.test/pgtap/source-detail-index/canonical';

select is(
  public.enqueue_due_source_details(
    (select p_now from pgtap_source_detail_clock),
    10
  ),
  1,
  'a due canonical source-detail alias is inserted once'
);

update public.auction_enrichment_jobs
   set status = 'completed'
 where source_url = 'https://example.test/pgtap/source-detail-index/canonical'
   and job_type = 'source_detail';

select is(
  public.enqueue_due_source_details(
    (select p_now from pgtap_source_detail_clock),
    10
  ),
  0,
  'a completed job with the same signature blocks a duplicate'
);

update public.auction_enrichment_jobs
   set status = 'queued',
       input_hash = 'pgtap-source-detail-index-alternate',
       attempt_count = 0,
       max_attempts = 4
 where source_url = 'https://example.test/pgtap/source-detail-index/canonical'
   and job_type = 'source_detail';

select is(
  public.enqueue_due_source_details(
    (select p_now from pgtap_source_detail_clock),
    10
  ),
  0,
  'an open job with another signature blocks a duplicate'
);

update public.auction_enrichment_jobs
   set status = 'failed',
       attempt_count = max_attempts
 where source_url = 'https://example.test/pgtap/source-detail-index/canonical'
   and job_type = 'source_detail';

select is(
  public.enqueue_due_source_details(
    (select p_now from pgtap_source_detail_clock),
    10
  ),
  1,
  'an exhausted failed job permits the next signature'
);

select is(
  (
    select count(*)
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/source-detail-index/canonical'
      and job_type = 'source_detail'
  ),
  2::bigint,
  'exact and exhausted revisions remain the only source-detail rows'
);

select * from finish();
rollback;
