begin;

select plan(10);

select has_function(
  'app_private',
  'guard_information_agent_fact_associations',
  array[]::text[],
  'fact candidates have a provenance and extraction guard'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.information_agent_fact_candidates'::regclass
      and tgname = 'information_agent_fact_associations_guard'
      and not tgisinternal
  ),
  'the provenance guard is active on fact candidate writes'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.information_agent_fact_candidates'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) =
        'UNIQUE NULLS NOT DISTINCT (message_id, fact_key, evidence_asset_id, source_page, display_value)'
  ),
  'candidate uniqueness preserves attachment and page provenance'
);

select has_function(
  'app_private',
  'guard_information_agent_evidence_associations',
  array[]::text[],
  'evidence associations cannot be reassigned'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.information_agent_evidence_assets'::regclass
      and tgname = 'information_agent_evidence_assets_association_guard'
      and not tgisinternal
  ),
  'asset association guard is active'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.information_agent_evidence_extractions'::regclass
      and tgname = 'information_agent_evidence_extractions_association_guard'
      and not tgisinternal
  ),
  'extraction association guard is active'
);

select has_function(
  'public',
  'review_information_agent_fact_candidate_with_path',
  array['uuid', 'uuid', 'text', 'text', 'text'],
  'attachment acceptance is bound to the staged object'
);

select has_function(
  'public',
  'abort_information_agent_evidence_publication',
  array['uuid', 'text'],
  'failed staging can be cancelled before deleting the object'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.information_agent_cases'::regclass
      and tgname = 'information_agent_reject_candidates_on_case_close'
      and not tgisinternal
  ),
  'closing a case automatically rejects unresolved candidates'
);

select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.information_agent_evidence_assets'::regclass
      and tgname = 'information_agent_rights_restriction_guard'
      and not tgisinternal
  ),
  'staged or accepted evidence cannot have its rights silently revoked'
);

select * from finish();

rollback;
