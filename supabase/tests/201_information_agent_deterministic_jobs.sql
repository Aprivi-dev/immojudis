begin;

select plan(4);

select has_function(
  'public',
  'review_information_agent_fact_candidate',
  array['uuid', 'uuid', 'text', 'text'],
  'the fact review RPC remains available after the deterministic job-key replacement'
);

select ok(
  (
    select position('jsonb_build_object' in pg_get_functiondef(
      'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure
    )) > 0
    and position('fingerprint_version' in pg_get_functiondef(
      'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure
    )) > 0
    and position('evidence_asset_id' in pg_get_functiondef(
      'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure
    )) > 0
  ),
  'the enrichment input hash includes a deterministic evidence-state fingerprint'
);

select ok(
  (
    select position('v_now::text' in pg_get_functiondef(
      'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure
    )) = 0
    and position('statement_timestamp()' in pg_get_functiondef(
      'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure
    )) > 0
  ),
  'audit timestamps remain available but are not part of the enrichment job hash'
);

select ok(
  position(
    'on conflict (source_url, job_type, input_hash) do nothing'
    in pg_get_functiondef('public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure)
  ) > 0,
  'the existing enrichment-job uniqueness and retry guard is preserved'
);

select * from finish();

rollback;
