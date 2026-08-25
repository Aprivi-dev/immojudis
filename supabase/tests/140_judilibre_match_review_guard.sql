begin;

select plan(43);

select ok(
  to_regprocedure('app_private.guard_judilibre_source_record_match_insert()') is not null,
  'the fail-closed Judilibre append guard exists'
);

select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.guard_judilibre_source_record_match_insert()'::regprocedure
  ),
  'the append guard is invoker-security with an empty search path'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.review_judilibre_match_candidate(uuid,text,text)'::regprocedure
  ),
  'the review RPC is security-definer with an empty search path'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.review_judilibre_match_candidate(uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.review_judilibre_match_candidate(uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.review_judilibre_match_candidate(uuid,text,text)',
    'EXECUTE'
  ),
  'only authenticated callers can invoke the terminal review RPC'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.judilibre_match_signals_are_safe(jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'app_private.judilibre_match_signals_are_safe(jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.judilibre_match_signals_are_safe(jsonb,text)',
    'EXECUTE'
  ),
  'the metadata-only signal validator is private to trusted ingestion'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.source_record_matches'::regclass
      and trigger_row.tgname = 'source_record_matches_judilibre_review_guard'
      and trigger_row.tgtype = 7
      and trigger_row.tgfoid =
        'app_private.guard_judilibre_source_record_match_insert()'::regprocedure
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ),
  'the exact enabled BEFORE INSERT ROW guard is installed'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.user_profiles'::regclass
      and trigger_row.tgname = 'user_profiles_judilibre_reviewer_update_guard'
      and trigger_row.tgtype = 19
      and trigger_row.tgfoid =
        'app_private.guard_judilibre_admin_review_history()'::regprocedure
  )
  and exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.user_profiles'::regclass
      and trigger_row.tgname = 'user_profiles_judilibre_reviewer_delete_guard'
      and trigger_row.tgtype = 11
      and trigger_row.tgfoid =
        'app_private.guard_judilibre_admin_review_history()'::regprocedure
  ),
  'reviewer role and identity durability guards are installed'
);

select ok(
  position(
    'judilibre-source-decision:' in pg_get_functiondef(
      'app_private.guard_judilibre_source_record_match_insert()'::regprocedure
    )
  ) > 0
  and position(
    'judilibre-match-successor:' in pg_get_functiondef(
      'app_private.guard_judilibre_source_record_match_insert()'::regprocedure
    )
  ) > 0,
  'terminal decisions serialize both the source branch and candidate successor'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.data_sources'::regclass
      and trigger_row.tgname = 'data_sources_judilibre_name_guard'
      and trigger_row.tgtype = 19
      and trigger_row.tgfoid =
        'app_private.guard_judilibre_source_name_update()'::regprocedure
  ),
  'the canonical Judilibre source-name guard is installed'
);

select throws_ok(
  $$update public.data_sources set name = 'judilibre-renamed'
    where name = 'judilibre'$$,
  '23514',
  'The canonical Judilibre source name is immutable.',
  'the Judilibre source cannot be renamed away'
);

select throws_ok(
  $$update public.data_sources set name = 'judilibre'
    where name = 'dvf_dgfip'$$,
  '23514',
  'The canonical Judilibre source name is immutable.',
  'another source cannot be renamed into the Judilibre identity'
);

create function pg_temp.judilibre_signals(
  p_case_number boolean default true,
  p_portalis_number boolean default false,
  p_hearing_date_exact boolean default true,
  p_source_projection_sha256 text default repeat('3', 64)
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', 'judilibre_match_signals_v1',
    'match_rule_version', 'judilibre-review-match-v1',
    'court', true,
    'court_resolution_method', 'outcome_court_code_exact',
    'court_resolution_reference_sha256', repeat('a', 64),
    'hearing_date', true,
    'hearing_date_exact', p_hearing_date_exact,
    'hearing_date_delta_days', case when p_hearing_date_exact then 0 else 2 end,
    'case_number', p_case_number,
    'portalis_number', p_portalis_number,
    'claim_types', jsonb_build_array('hammer_price_eur'),
    'claims_manifest_sha256', repeat('b', 64),
    'case_reference_manifest_sha256', repeat('c', 64),
    'source_projection_sha256', p_source_projection_sha256,
    'target_context_sha256', repeat('e', 64),
    'source_record_version_current_at_scan', true,
    'source_training_eligible', false,
    'selection_requires_human_review', true,
    'automatic_link_allowed', false,
    'outcome_creation_allowed', false,
    'training_eligible', false,
    'claim_value_used_for_matching', false,
    'price_used_for_matching', false,
    'text_used_for_matching', false,
    'address_used_for_matching', false,
    'personal_identity_used_for_matching', false,
    'source_record_sha256', repeat('f', 64)
  );
$$;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values
  (
    'b1900000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'judilibre-admin-reviewer@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'b1900000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'judilibre-regular-reviewer@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  );

update public.user_profiles
set user_role = 'admin'
where user_id = 'b1900000-0000-4000-8000-000000000001';

insert into public.raw_artifacts (
  id, source_id, external_record_id, storage_object_path, mime_type,
  byte_size, content_hash, captured_at, connector_version
) values
  (
    'b1100000-0000-4000-8000-000000000001',
    (select id from public.data_sources where name = 'judilibre'),
    'judilibre-review-guard',
    'outcome-sources/test/judilibre-review-guard.json',
    'application/json', 2, repeat('1', 64), now(), 'pgtap/1.0'
  ),
  (
    'b1100000-0000-4000-8000-000000000002',
    (select id from public.data_sources where name = 'dvf_dgfip'),
    'dvf-review-guard',
    'outcome-sources/test/dvf-review-guard.json',
    'application/json', 2, repeat('2', 64), now(), 'pgtap/1.0'
  );

insert into public.judicial_source_records (
  id, source_id, raw_artifact_id, record_kind, external_record_id,
  normalized_data, content_hash, connector_version
) values
  (
    'b1400000-0000-4000-8000-000000000001',
    (select id from public.data_sources where name = 'judilibre'),
    'b1100000-0000-4000-8000-000000000001',
    'judicial_decision_candidate', 'judilibre-review-guard-1',
    '{"schema_version":"judilibre_decision_candidate_v3"}'::jsonb,
    repeat('3', 64), 'pgtap/1.0'
  ),
  (
    'b1400000-0000-4000-8000-000000000002',
    (select id from public.data_sources where name = 'dvf_dgfip'),
    'b1100000-0000-4000-8000-000000000002',
    'other_candidate', 'dvf-review-guard',
    '{"schema_version":"dvf_match_candidate_v1"}'::jsonb,
    repeat('4', 64), 'pgtap/1.0'
  ),
  (
    'b1400000-0000-4000-8000-000000000003',
    (select id from public.data_sources where name = 'judilibre'),
    'b1100000-0000-4000-8000-000000000001',
    'judicial_decision_candidate', 'judilibre-review-guard-2',
    '{"schema_version":"judilibre_decision_candidate_v3"}'::jsonb,
    repeat('5', 64), 'pgtap/1.0'
  );

insert into public.outcome_courts (id, code, name)
values (
  'b1500000-0000-4000-8000-000000000001',
  'TJ-JUDILIBRE-GUARD-TEST',
  'Tribunal judiciaire Judilibre guard test'
);

insert into public.auction_cases (id, court_id, court_case_number, procedure_type)
values
  (
    'b1600000-0000-4000-8000-000000000001',
    'b1500000-0000-4000-8000-000000000001',
    'RG-JUDILIBRE-GUARD-1', 'saisie_immobiliere'
  ),
  (
    'b1600000-0000-4000-8000-000000000002',
    'b1500000-0000-4000-8000-000000000001',
    'RG-JUDILIBRE-GUARD-2', 'saisie_immobiliere'
  );

set local role service_role;

select lives_ok(
  $$insert into public.source_record_matches (
      id, source_record_id, case_id, match_score, match_method,
      match_signals, status, created_at
    ) values (
      'b1800000-0000-4000-8000-000000000001',
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number', pg_temp.judilibre_signals(),
      'candidate', '2100-01-01 00:00:00+00'
    )$$,
  'trusted ingestion can append an exact-contract root candidate'
);

select ok(
  (
    select created_at < clock_timestamp() + interval '1 minute'
    from public.source_record_matches
    where id = 'b1800000-0000-4000-8000-000000000001'
  ),
  'candidate created_at is server-stamped instead of caller-controlled'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number',
      pg_temp.judilibre_signals() || '{"price":true}'::jsonb,
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'an extra price signal is rejected by the closed metadata-only schema'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number',
      jsonb_set(
        pg_temp.judilibre_signals(),
        '{court_resolution_method}',
        '"garbage"'::jsonb
      ),
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'court resolution is restricted to the two objective repository methods'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number',
      jsonb_set(pg_temp.judilibre_signals(), '{claim_types}', '[]'::jsonb),
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'a candidate must carry at least one reviewed claim type'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number',
      jsonb_set(
        pg_temp.judilibre_signals(),
        '{claim_types}',
        '["decision_date"]'::jsonb
      ),
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'claim types are restricted to the reviewed Judilibre extraction allowlist'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number',
      jsonb_set(
        pg_temp.judilibre_signals(),
        '{claim_types}',
        '["hammer_price_eur","hammer_price_eur"]'::jsonb
      ),
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'duplicate Judilibre claim types are rejected'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number',
      pg_temp.judilibre_signals(true, false, true, repeat('9', 64)),
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'source projection provenance must equal the immutable source-record hash'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number',
      pg_temp.judilibre_signals(true, true, true),
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'an exact case-number method cannot downgrade an available exact Portalis signal'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9000, 'exact_case_number', pg_temp.judilibre_signals(),
      'candidate'
    )$$,
  '23514',
  'Judilibre candidates require the closed metadata-only v1 match contract.',
  'a caller cannot lower the canonical exact-case score'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number', pg_temp.judilibre_signals(),
      'weak_candidate'
    )$$,
  '23514',
  'Judilibre ingestion may append only a root candidate without reviewer attribution.',
  'legacy weak candidate states are closed for Judilibre'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status, decided_at
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number', pg_temp.judilibre_signals(),
      'auto_matched', now()
    )$$,
  '23514',
  'Judilibre source-record matches may not be auto-matched.',
  'Judilibre can never enter the generic auto-match state'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method,
      match_signals, status, reviewer_user_id, decision_notes,
      decided_at, supersedes_match_id
    ) values (
      'b1400000-0000-4000-8000-000000000001',
      'b1600000-0000-4000-8000-000000000001',
      0.9500, 'exact_case_number', pg_temp.judilibre_signals(),
      'confirmed', 'b1900000-0000-4000-8000-000000000001',
      'direct service-role spoof', now(),
      'b1800000-0000-4000-8000-000000000001'
    )$$,
  '42501',
  'Terminal Judilibre match decisions must use the authenticated review RPC.',
  'service-role ingestion cannot spoof a terminal reviewer decision'
);

insert into public.source_record_matches (
  id, source_record_id, case_id, match_score, match_method,
  match_signals, status
) values
  (
    'b1800000-0000-4000-8000-000000000002',
    'b1400000-0000-4000-8000-000000000001',
    'b1600000-0000-4000-8000-000000000002',
    0.9500, 'exact_case_number', pg_temp.judilibre_signals(), 'candidate'
  ),
  (
    'b1800000-0000-4000-8000-000000000003',
    'b1400000-0000-4000-8000-000000000003',
    'b1600000-0000-4000-8000-000000000001',
    0.9500, 'exact_case_number',
    pg_temp.judilibre_signals(true, false, true, repeat('5', 64)), 'candidate'
  ),
  (
    'b1800000-0000-4000-8000-000000000004',
    'b1400000-0000-4000-8000-000000000003',
    'b1600000-0000-4000-8000-000000000002',
    0.9500, 'exact_case_number',
    pg_temp.judilibre_signals(true, false, true, repeat('5', 64)), 'candidate'
  );

reset role;
select set_config(
  'request.jwt.claim.sub',
  'b1900000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

select throws_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000001',
      'confirmed', 'regular user attempt'
    )$$,
  '42501',
  'Only an administrator may decide a Judilibre match.',
  'a non-admin authenticated user cannot decide a candidate'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  'b1900000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

select throws_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000001',
      'confirmed', '   '
    )$$,
  '23514',
  'Terminal Judilibre match decisions require an audit note.',
  'the RPC requires a non-blank audit note'
);

select throws_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000001',
      'candidate', 'invalid status'
    )$$,
  '23514',
  'Judilibre review status must be terminal.',
  'the RPC accepts only terminal review statuses'
);

select lives_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000001',
      'confirmed', '  confirmed from source evidence  '
    )$$,
  'an authenticated administrator can confirm a candidate'
);

reset role;

select ok(
  (
    select terminal_match.source_record_id = candidate.source_record_id
      and terminal_match.case_id is not distinct from candidate.case_id
      and terminal_match.lot_id is not distinct from candidate.lot_id
      and terminal_match.round_id is not distinct from candidate.round_id
      and terminal_match.outcome_id is not distinct from candidate.outcome_id
      and terminal_match.match_score = candidate.match_score
      and terminal_match.match_method = candidate.match_method
      and terminal_match.match_signals = candidate.match_signals
    from public.source_record_matches terminal_match
    join public.source_record_matches candidate
      on candidate.id = terminal_match.supersedes_match_id
    where candidate.id = 'b1800000-0000-4000-8000-000000000001'
  ),
  'the terminal row preserves the complete immutable candidate evidence'
);

select ok(
  (
    select terminal_match.created_at = terminal_match.decided_at
      and terminal_match.reviewer_user_id =
        'b1900000-0000-4000-8000-000000000001'::uuid
    from public.source_record_matches terminal_match
    where terminal_match.supersedes_match_id =
      'b1800000-0000-4000-8000-000000000001'
  ),
  'the server stamps one audit timestamp and auth.uid reviewer identity'
);

select is(
  (
    select decision_notes
    from public.source_record_matches
    where supersedes_match_id = 'b1800000-0000-4000-8000-000000000001'
  ),
  'confirmed from source evidence',
  'the RPC trims and stores the mandatory audit note'
);

select set_config(
  'request.jwt.claim.sub',
  'b1900000-0000-4000-8000-000000000001',
  true
);
set local role authenticated;

select throws_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000001',
      'rejected', 'second successor'
    )$$,
  '23505',
  'The Judilibre candidate already has a terminal successor.',
  'a candidate can have only one serialized terminal successor'
);

select throws_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000002',
      'confirmed', 'competing target'
    )$$,
  '23505',
  'The Judilibre source record already has a confirmed target.',
  'one Judilibre source record cannot confirm two target branches'
);

select lives_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000003',
      'rejected', 'court metadata did not support this target'
    )$$,
  'an administrator can reject an independent candidate'
);

select lives_ok(
  $$select public.review_judilibre_match_candidate(
      'b1800000-0000-4000-8000-000000000004',
      'superseded', 'candidate replaced during review'
    )$$,
  'an administrator can supersede a distinct candidate target'
);

reset role;

select throws_ok(
  $$update public.user_profiles set user_role = 'user'
    where user_id = 'b1900000-0000-4000-8000-000000000001'$$,
  '55000',
  'A Judilibre reviewer identity and administrator role are immutable after decision.',
  'a historical Judilibre reviewer cannot be demoted'
);

select throws_ok(
  $$delete from public.user_profiles
    where user_id = 'b1900000-0000-4000-8000-000000000001'$$,
  '55000',
  'A Judilibre reviewer identity and administrator role are immutable after decision.',
  'a historical Judilibre reviewer profile cannot be deleted'
);

set local role service_role;

select lives_ok(
  $$insert into public.source_record_matches (
      id, source_record_id, case_id, match_score, match_method,
      match_signals, status, decided_at
    ) values (
      'b1800000-0000-4000-8000-000000000005',
      'b1400000-0000-4000-8000-000000000002',
      'b1600000-0000-4000-8000-000000000001',
      0.9900, 'exact_case_number', '{"case_number":true}'::jsonb,
      'auto_matched', now()
    )$$,
  'the source-scoped guard preserves valid DVF auto-match behavior'
);

select lives_ok(
  $$insert into public.source_record_matches (
      id, source_record_id, case_id, match_score, match_method,
      match_signals, status, reviewer_user_id
    ) values (
      'b1800000-0000-4000-8000-000000000006',
      'b1400000-0000-4000-8000-000000000002',
      'b1600000-0000-4000-8000-000000000001',
      0.7000, 'exact_case_number', '{"case_number":true}'::jsonb,
      'review_required', 'b1900000-0000-4000-8000-000000000001'
    )$$,
  'the source-scoped guard preserves another source review workflow'
);

reset role;

select is(
  (
    select count(*)
    from public.source_record_matches match_row
    join public.judicial_source_records record
      on record.id = match_row.source_record_id
    join public.data_sources source on source.id = record.source_id
    where source.name = 'judilibre'
      and (
        match_row.status not in ('candidate', 'confirmed', 'rejected', 'superseded')
        or (
          match_row.status = 'candidate'
          and (
            match_row.reviewer_user_id is not null
            or match_row.decided_at is not null
            or match_row.supersedes_match_id is not null
            or not app_private.judilibre_match_signals_are_safe(
              match_row.match_signals,
              record.content_hash
            )
          )
        )
        or (
          match_row.status in ('confirmed', 'rejected', 'superseded')
          and (
            match_row.reviewer_user_id is null
            or match_row.decided_at is distinct from match_row.created_at
            or match_row.supersedes_match_id is null
            or nullif(btrim(match_row.decision_notes), '') is null
          )
        )
      )
  ),
  0::bigint,
  'all persisted Judilibre match history obeys the closed review workflow'
);

select is(
  (
    select count(*)
    from (
      select source_record_id
      from public.source_record_matches
      where source_record_id in (
        select record.id
        from public.judicial_source_records record
        join public.data_sources source on source.id = record.source_id
        where source.name = 'judilibre'
      )
        and status = 'confirmed'
      group by source_record_id
      having count(*) > 1
    ) duplicate_source
  ),
  0::bigint,
  'no Judilibre source has more than one confirmed target'
);

select throws_ok(
  $$update public.source_record_matches set match_score = 0.5000
    where id = 'b1800000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.source_record_matches is append-only; insert a correcting version instead.',
  'Judilibre candidate evidence remains append-only'
);

select throws_ok(
  $$delete from public.source_record_matches
    where id = 'b1800000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.source_record_matches is append-only; insert a correcting version instead.',
  'Judilibre candidate evidence cannot be deleted'
);

select * from finish();

rollback;
