begin;

select plan(26);

select has_table(
  'public',
  'auction_fact_claims',
  'fact claims have an additive source-backed registry'
);
select has_view(
  'public',
  'v_auction_fact_claims_read_model',
  'fact claims expose a stable trusted read model'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_fact_claims'::regclass),
  'fact claims enable RLS'
);
select ok(
  not has_table_privilege('anon', 'public.auction_fact_claims', 'SELECT')
    and not has_table_privilege('authenticated', 'public.auction_fact_claims', 'SELECT')
    and not has_table_privilege('authenticated', 'public.v_auction_fact_claims_read_model', 'SELECT'),
  'browser roles cannot read claim evidence before a dedicated exposure policy exists'
);
select ok(
  has_table_privilege('service_role', 'public.auction_fact_claims', 'SELECT')
    and has_table_privilege('service_role', 'public.auction_fact_claims', 'INSERT')
    and has_table_privilege('service_role', 'public.auction_fact_claims', 'UPDATE')
    and not has_table_privilege('service_role', 'public.auction_fact_claims', 'DELETE')
    and has_table_privilege('service_role', 'public.v_auction_fact_claims_read_model', 'SELECT'),
  'trusted workers can append, resolve and read fact claims without deleting evidence'
);
select is(
  (
    select count(*)::integer
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_fact_claims'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid in (
        'public.data_sources'::regclass,
        'public.raw_artifacts'::regclass,
        'public.judicial_source_records'::regclass,
        'public.artifact_extractions'::regclass
      )
      and constraint_row.confdeltype = 'r'
  ),
  5,
  'claim provenance links use ON DELETE RESTRICT so Outcome Graph evidence rows remain durable'
);

insert into public.data_sources (
  id, name, publisher, official, base_url, legal_review_status,
  ingestion_policy, active
) values (
  '37000000-0000-4000-8000-000000000001',
  'fact-claims-pgtap',
  'Fact claims test fixture',
  false,
  'https://example.test/fact-claims',
  'approved',
  'allowed_manual',
  true
);

insert into public.data_sources (
  id, name, publisher, official, base_url, legal_review_status,
  ingestion_policy, active
) values (
  '37000000-0000-4000-8000-000000000002',
  'fact-claims-pgtap-source-only',
  'Fact claims source FK fixture',
  false,
  'https://example.test/fact-claims-source-only',
  'approved',
  'allowed_manual',
  true
);

insert into public.auction_sales (
  id, source_name, source_url, title, status
) values (
  '37000000-1000-4000-8000-000000000001',
  'fact-claims-pgtap',
  'https://example.test/fact-claims/sale',
  'Fact claims test sale',
  'upcoming'
);

insert into public.raw_artifacts (
  id, source_id, external_record_id, canonical_url, storage_object_path,
  mime_type, byte_size, content_hash, captured_at, connector_version
) values (
  '37000000-2000-4000-8000-000000000001',
  '37000000-0000-4000-8000-000000000001',
  'fact-claims-record',
  'https://example.test/fact-claims/sale',
  'outcome-sources/test/fact-claims-record.json',
  'application/json',
  42,
  repeat('a', 64),
  '2026-09-28T10:00:00Z',
  'fact-claims-pgtap/1.0'
);

insert into auth.users(id) values (
  '37000000-4000-4000-8000-000000000001'
);

set local role service_role;

select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind
    ) values (
      '37000000-1000-4000-8000-000000000001',
      'property.surface_m2',
      '92'::jsonb,
      'manual_review'
    )$$,
  '23514',
  'Fact claims require at least one provenance pointer.',
  'a claim cannot be created without source or actor provenance'
);

select throws_ok(
  $$insert into public.auction_fact_claims (
      field_key, value_jsonb, evidence_kind, source_id
    ) values (
      'property.surface_m2',
      '92'::jsonb,
      'source_listing',
      '37000000-0000-4000-8000-000000000001'
    )$$,
  '23514',
  'A fact claim must target an auction sale or Outcome Graph lot.',
  'a claim cannot float without a sale or lot target'
);

select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, claim_status,
      evidence_kind, source_id, resolved_at, resolution_actor_type
    ) values (
      '37000000-1000-4000-8000-000000000001',
      'property.surface_m2',
      '92'::jsonb,
      'conflicted',
      'source_listing',
      '37000000-0000-4000-8000-000000000001',
      now(),
      'rule'
    )$$,
  '23514',
  'Fact claim conflict groups require a non-empty identifier.',
  'a conflict cannot be resolved without a conflict group'
);

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, claim_status,
  evidence_kind, source_id, raw_artifact_id, source_url, evidence_locator,
  confidence_score, extractor_name, extractor_version, captured_at
) values (
  '37000000-3000-4000-8000-000000000001',
  '37000000-1000-4000-8000-000000000001',
  'property.surface_m2',
  '92'::jsonb,
  'candidate',
  'source_listing',
  '37000000-0000-4000-8000-000000000001',
  '37000000-2000-4000-8000-000000000001',
  'https://example.test/fact-claims/sale',
  '{"page":1,"quote":"Surface : 92 m²"}'::jsonb,
  0.91,
  'fact-claims-test',
  '1.0.0',
  '2026-09-28T10:00:00Z'
);

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind,
  source_id, source_url
) values (
  '37000000-3000-4000-8000-000000000005',
  '37000000-1000-4000-8000-000000000001',
  'property.starting_price_eur',
  '92000'::jsonb,
  'source_listing',
  '37000000-0000-4000-8000-000000000002',
  'https://example.test/fact-claims-source-only/sale'
);

select is(
  (select fact_status from public.v_auction_fact_claims_read_model
   where claim_id = '37000000-3000-4000-8000-000000000001'),
  'candidate',
  'candidate claims appear in the trusted read model'
);
select is(
  (select is_publishable from public.v_auction_fact_claims_read_model
   where claim_id = '37000000-3000-4000-8000-000000000001'),
  false,
  'candidate claims are never publishable'
);

select throws_ok(
  $$update public.auction_fact_claims
    set value_jsonb = '93'::jsonb
    where id = '37000000-3000-4000-8000-000000000001'$$,
  '55000',
  'Fact claim observations and provenance are immutable.',
  'a source value cannot be edited in place'
);

update public.auction_fact_claims
set claim_status = 'accepted',
    resolution_actor_type = 'rule',
    resolved_at = '2026-09-28T10:05:00Z',
    resolution_note = 'Single source observation in the fixture.'
where id = '37000000-3000-4000-8000-000000000001';

select is(
  (select value_jsonb from public.v_auction_fact_claims_read_model
   where claim_id = '37000000-3000-4000-8000-000000000001'),
  '92'::jsonb,
  'the read model preserves the observed claim value'
);
select is(
  (select is_publishable from public.v_auction_fact_claims_read_model
   where claim_id = '37000000-3000-4000-8000-000000000001'),
  true,
  'accepted claims are publishable in the trusted read model'
);

select throws_ok(
  $$update public.auction_fact_claims
    set resolution_note = 'changed after resolution'
    where id = '37000000-3000-4000-8000-000000000001'$$,
  '55000',
  'A resolved fact claim decision is immutable.',
  'a resolved decision cannot be edited in place'
);

select throws_ok(
  $$delete from public.auction_fact_claims
    where id = '37000000-3000-4000-8000-000000000001'$$,
  '55000',
  'Fact claims cannot be deleted; supersede or withdraw them.',
  'evidence rows cannot be deleted'
);

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, claim_status,
  conflict_group, evidence_kind, source_id, source_url, evidence_locator
) values (
  '37000000-3000-4000-8000-000000000002',
  '37000000-1000-4000-8000-000000000001',
  'property.surface_m2',
  '89'::jsonb,
  'candidate',
  'surface-37000000-1',
  'source_document',
  '37000000-0000-4000-8000-000000000001',
  'https://example.test/fact-claims/sale-notice.pdf',
  '{"page":3,"quote":"89 m² Carrez"}'::jsonb
);

update public.auction_fact_claims
set claim_status = 'conflicted',
    resolution_actor_type = 'agent',
    resolved_at = '2026-09-28T10:10:00Z',
    resolution_note = 'Conflicts with the catalogue value until document review.',
    conflict_group = 'surface-37000000-1'
where id = '37000000-3000-4000-8000-000000000002';

select is(
  (select count(*)::integer from public.v_auction_fact_claims_read_model
   where auction_sale_id = '37000000-1000-4000-8000-000000000001'
     and field_key = 'property.surface_m2'),
  2,
  'the read model keeps accepted and explicit conflicting claims available for review'
);
select is(
  (select count(*)::integer from public.v_auction_fact_claims_read_model
   where fact_status = 'rejected'),
  0,
  'rejected claims stay out of the listing read model'
);

select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind,
      source_id, source_url
    ) values (
      '37000000-1000-4000-8000-000000000001',
      'property.surface_m2',
      '92'::jsonb,
      'source_listing',
      '37000000-0000-4000-8000-000000000001',
      'http://example.test/insecure'
    )$$,
  '23514',
  'Fact claim evidence links must use HTTPS.',
  'source evidence links must use HTTPS'
);

-- Auth actor deletion is allowed to redact only the actor pointers.  The
-- immutable observation and its provenance remain available for audit.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, created_by
) values (
  '37000000-3000-4000-8000-000000000003',
  '37000000-1000-4000-8000-000000000001',
  'property.occupation_status',
  '"vacant"'::jsonb,
  'manual_review',
  '37000000-4000-4000-8000-000000000001'
);

insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, claim_status,
  evidence_kind, source_id, source_url, resolution_actor_type,
  resolution_actor_id, resolved_at, resolution_note
) values (
  '37000000-3000-4000-8000-000000000004',
  '37000000-1000-4000-8000-000000000001',
  'property.sale_date',
  '"2026-10-15"'::jsonb,
  'accepted',
  'source_listing',
  '37000000-0000-4000-8000-000000000001',
  'https://example.test/fact-claims/sale',
  'human',
  '37000000-4000-4000-8000-000000000001',
  '2026-09-28T10:15:00Z',
  'Actor deletion cascade test.'
);

select lives_ok(
  $$delete from auth.users where id = '37000000-4000-4000-8000-000000000001'$$,
  'deleting an auth actor redacts actor pointers without deleting fact claims'
);
select is(
  (select created_by from public.auction_fact_claims
   where id = '37000000-3000-4000-8000-000000000003'),
  null::uuid,
  'created_by is redacted after auth account deletion'
);
select ok(
  (select created_by_redacted_at is not null from public.auction_fact_claims
   where id = '37000000-3000-4000-8000-000000000003'),
  'created_by redaction is timestamped'
);
select is(
  (select resolution_actor_id from public.auction_fact_claims
   where id = '37000000-3000-4000-8000-000000000004'),
  null::uuid,
  'resolution actor is redacted after auth account deletion'
);
select ok(
  (select resolution_actor_redacted_at is not null from public.auction_fact_claims
   where id = '37000000-3000-4000-8000-000000000004'),
  'resolution actor redaction is timestamped'
);

reset role;

select throws_ok(
  $$delete from public.data_sources
    where id = '37000000-0000-4000-8000-000000000002'$$,
  '23503',
  null,
  'source rows cannot be deleted while fact claims retain their provenance; retention keeps DB evidence rows'
);
select throws_ok(
  $$delete from public.raw_artifacts
    where id = '37000000-2000-4000-8000-000000000001'$$,
  '55000',
  'public.raw_artifacts is append-only; insert a correcting version instead.',
  'raw artifact rows cannot be deleted while fact claims retain their evidence; retention purges Storage objects only'
);

select * from finish();
rollback;
