begin;

select plan(59);

select has_table(
  'public',
  'auction_ai_review_case_status',
  'AI review case outcomes have a private blocker table'
);
select has_table(
  'public',
  'auction_ai_review_projections',
  'AI review projections have a private quarantine table'
);
select has_view(
  'public',
  'v_auction_ai_review_publishable',
  'AI review projections expose a publishable-only read model'
);
select has_view(
  'public',
  'v_auction_ai_review_projection_read_model',
  'trusted adapters receive status-only AI review metadata'
);
select has_view(
  'public',
  'v_auction_ai_review_projection_reconciliation',
  'AI review projections expose an explicit canonical reconciliation contract'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_ai_review_projections'::regclass),
  'AI review projections enable RLS'
);
select ok(
  not has_table_privilege('anon', 'public.auction_ai_review_projections', 'SELECT')
    and not has_table_privilege('authenticated', 'public.auction_ai_review_projections', 'SELECT')
    and has_table_privilege('service_role', 'public.auction_ai_review_projections', 'SELECT')
    and not has_table_privilege('service_role', 'public.auction_ai_review_projections', 'INSERT')
    and has_table_privilege('postgres', 'public.auction_ai_review_projections', 'INSERT'),
  'service role can read AI review projections but only the postgres/maintenance owner can write them'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.auction_ai_review_case_status'::regclass)
    and not has_table_privilege('anon', 'public.auction_ai_review_case_status', 'SELECT')
    and not has_table_privilege('authenticated', 'public.auction_ai_review_case_status', 'SELECT')
    and has_table_privilege('service_role', 'public.auction_ai_review_case_status', 'SELECT')
    and not has_table_privilege('service_role', 'public.auction_ai_review_case_status', 'INSERT')
    and has_table_privilege('postgres', 'public.auction_ai_review_case_status', 'INSERT'),
  'non-captured case blockers remain service-role-readable and owner-written'
);
select has_function(
  'app_private',
  'import_ai_review_payload',
  array['jsonb'],
  'the sanitized AI review import function exists'
);
select ok(
  has_function_privilege(
    'postgres',
    'app_private.import_ai_review_payload(jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'app_private.import_ai_review_payload(jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'app_private.import_ai_review_payload(jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.import_ai_review_payload(jsonb)',
    'EXECUTE'
  ),
  'only the postgres/maintenance owner can import sanitized AI review payloads'
);
select ok(
  not has_table_privilege('anon', 'public.v_auction_ai_review_projection_read_model', 'SELECT')
    and not has_table_privilege('authenticated', 'public.v_auction_ai_review_projection_read_model', 'SELECT')
    and has_table_privilege('service_role', 'public.v_auction_ai_review_projection_read_model', 'SELECT')
    and has_function_privilege(
      'service_role',
      'app_private.ai_review_sale_is_blocked(uuid)',
      'EXECUTE'
    ),
  'status-only AI review metadata remains server-side'
);
select has_column(
  'public', 'auction_fact_claims', 'ai_review_projection_id',
  'fact claims expose the AI projection guard pointer'
);

-- All fixture inserts and the owner-only import run as postgres.  The
-- service_role read boundary is asserted above through its SELECT privileges.
set local role postgres;

insert into public.auction_sales(
  id, source_name, source_url, title, city, property_type, starting_price_eur, status,
  content_hash
)
values (
  '38300000-1000-4000-8000-000000000001',
  'ai-review-pgtap',
  'https://example.test/ai-review/sale-1',
  'AI review guard test sale',
  'Bordeaux',
  'apartment',
  120000,
  'upcoming',
  repeat('a', 64)
);

insert into public.auction_ai_review_case_status(
  schema_version, sample_sha256, case_id, source_name, source_url,
  access_state, access_reason, capture_sha256, auction_sale_id, mapping_status
)
values (
  'immojudis.real-extraction-review.v2', repeat('a', 64), 'case-not-captured',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-1',
  'capture_failed', 'HTTP 403 challenge', null,
  '38300000-1000-4000-8000-000000000001', 'exact'
);

select is(
  (select count(*)::integer from public.auction_ai_review_case_status
   where sample_sha256 = repeat('a', 64) and access_state <> 'captured'),
  1,
  'non-captured sample case is recorded without synthetic capture evidence'
);

insert into public.auction_ai_review_case_status(
  schema_version, sample_sha256, case_id, source_name, source_url,
  access_state, capture_sha256, canonical_content_hash_at_import,
  auction_sale_id, mapping_status
)
values (
  'immojudis.real-extraction-review.v2', repeat('a', 64), 'case-resolved',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-1',
  'captured', repeat('b', 64), repeat('a', 64),
  '38300000-1000-4000-8000-000000000001', 'exact'
);

select lives_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', 'c2a8d1d245e738efc7549be148a59716aa32a4958aed4db996ea860a0427f6f1',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', jsonb_build_array(jsonb_build_object(
        'schema_version', 'immojudis.real-extraction-review.v2',
        'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
        'case_id', 'case-offline-import',
        'source_name', 'ai-review-pgtap',
        'source_url', 'https://example.test/ai-review/sale-1',
        'access_state', 'captured',
        'access_reason', null,
        'capture_sha256', repeat('f', 64),
        'mapping_status', 'server_exact_required'
      )),
      'projections', jsonb_build_array(jsonb_build_object(
        'schema_version', 'immojudis.real-extraction-review.v2',
        'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
        'case_id', 'case-offline-import',
        'source_name', 'ai-review-pgtap',
        'source_url', 'https://example.test/ai-review/sale-1',
        'capture_sha256', repeat('f', 64),
        'mapping_status', 'server_exact_required',
        'field_key', 'property.property_type',
        'review_state', 'resolved',
        'citation_status', 'verified',
        'value_jsonb', to_jsonb('apartment'::text),
        'evidence_locator', '{}'::jsonb,
        'block_reason', null
      ))
    )
  )$$,
  'offline import resolves the exact source identity inside PostgreSQL'
);
select is(
  (select mapping_status from public.auction_ai_review_projections
   where sample_sha256 = '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424'
     and case_id = 'case-offline-import'),
  'exact',
  'server-side offline import records an exact mapping'
);
select ok(
  (select local_is_publishable from public.auction_ai_review_projections
   where sample_sha256 = '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424'
     and case_id = 'case-offline-import'),
  'server-side exact import preserves a verified AI value as private publishable metadata'
);
select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = '38300000-1000-4000-8000-000000000001'),
  'ai_review_projection_blocked',
  'a captured exact case stays quarantined until all twelve expected fields are present'
);

insert into public.auction_ai_review_projections(
  id, schema_version, sample_sha256, case_id, source_name, source_url,
  capture_sha256, canonical_content_hash_at_import, auction_sale_id,
  mapping_status, field_key, review_state,
  citation_status, value_jsonb, evidence_locator, block_reason
)
values (
  '38300000-2000-4000-8000-000000000001',
  'immojudis.real-extraction-review.v2',
  repeat('a', 64),
  'case-resolved',
  'ai-review-pgtap',
  'https://example.test/ai-review/sale-1',
  repeat('b', 64),
  repeat('a', 64),
  '38300000-1000-4000-8000-000000000001',
  'exact',
  'property.property_type',
  'resolved',
  'verified',
  '"apartment"'::jsonb,
  '{"final_locator":"visible field"}'::jsonb,
  null
), (
  '38300000-2000-4000-8000-000000000002',
  'immojudis.real-extraction-review.v2',
  repeat('a', 64),
  'case-unresolved',
  'ai-review-pgtap',
  'https://example.test/ai-review/sale-1',
  repeat('c', 64),
  repeat('a', 64),
  '38300000-1000-4000-8000-000000000001',
  'exact',
  'property.rooms_count',
  'unresolved',
  'not_required',
  null,
  '{"final_locator":"ambiguous text"}'::jsonb,
  'AI passes disagree'
), (
  '38300000-2000-4000-8000-000000000003',
  'immojudis.real-extraction-review.v2',
  repeat('a', 64),
  'case-unverified',
  'ai-review-pgtap',
  'https://example.test/ai-review/sale-1',
  repeat('d', 64),
  repeat('a', 64),
  '38300000-1000-4000-8000-000000000001',
  'exact',
  'property.city',
  'unverified',
  'unverified',
  null,
  '{"unverified_citations":[{"reviewer":"pass-a"}]}'::jsonb,
  'AI citation not found in frozen capture'
), (
  '38300000-2000-4000-8000-000000000004',
  'immojudis.real-extraction-review.v2',
  repeat('a', 64),
  'case-unmapped',
  'ai-review-pgtap',
  'https://example.test/ai-review/missing',
  repeat('e', 64),
  null,
  'unmapped',
  'property.property_type',
  'resolved',
  'verified',
  '"house"'::jsonb,
  '{}'::jsonb,
  'exact catalogue mapping is unavailable'
);

set local role service_role;
select ok(
  (select local_is_publishable from public.auction_ai_review_projections
   where id = '38300000-2000-4000-8000-000000000001')
    and not (select is_publishable
             from public.v_auction_ai_review_projection_read_model
             where projection_id = '38300000-2000-4000-8000-000000000001'),
  'a locally publishable field remains blocked when the whole sale is not fully reconciled'
);
set local role postgres;
select ok(
  not (select local_is_publishable from public.auction_ai_review_projections
       where id = '38300000-2000-4000-8000-000000000002')
    and not (select local_is_publishable from public.auction_ai_review_projections
             where id = '38300000-2000-4000-8000-000000000003'),
  'unresolved and unverified AI review fields are never publishable'
);
select is(
  (select count(*)::integer from public.v_auction_ai_review_publishable),
  0,
  'publishable AI view excludes every field from a sale that is not fully reconciled'
);

insert into public.auction_ai_review_case_status(
  schema_version, sample_sha256, case_id, source_name, source_url,
  access_state, capture_sha256, canonical_content_hash_at_import,
  auction_sale_id, mapping_status
)
values (
  'immojudis.real-extraction-review.v2', repeat('6', 64), 'case-conflict',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-1',
  'captured', repeat('7', 64), repeat('a', 64),
  '38300000-1000-4000-8000-000000000001', 'exact'
);
insert into public.auction_ai_review_projections(
  id, schema_version, sample_sha256, case_id, source_name, source_url,
  capture_sha256, canonical_content_hash_at_import, auction_sale_id,
  mapping_status, field_key, review_state, citation_status, value_jsonb,
  evidence_locator
)
values (
  '38300000-2000-4000-8000-000000000005',
  'immojudis.real-extraction-review.v2', repeat('6', 64), 'case-conflict',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-1',
  repeat('7', 64), repeat('a', 64),
  '38300000-1000-4000-8000-000000000001', 'exact', 'property.city',
  'resolved', 'verified', '"Paris"'::jsonb, '{}'
);
select is(
  (select comparison_status
   from public.v_auction_ai_review_projection_reconciliation
   where projection_id = '38300000-2000-4000-8000-000000000005'),
  'conflict',
  'a canonically conflicting projection is excluded from the reconciliation match set'
);
select throws_ok(
  $$insert into public.auction_fact_claims(
      id, auction_sale_id, field_key, value_jsonb, claim_status,
      evidence_kind, source_url, evidence_locator, ai_review_projection_id
    ) values (
      '38300000-3000-4000-8000-000000000004',
      '38300000-1000-4000-8000-000000000001',
      'property.city', '"Paris"', 'candidate', 'source_listing',
      'https://example.test/ai-review/sale-1', '{}',
      '38300000-2000-4000-8000-000000000005'
    )$$,
  '55000',
  'An auction fact claim may link only to a publishable AI review projection for the same sale and field.',
  'a fact claim cannot link to a canonical conflict'
);
select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = '38300000-1000-4000-8000-000000000001'),
  'ai_review_projection_blocked',
  'an unresolved or unverified exact field quarantines its canonical sale from existing fiche/map views'
);

select throws_ok(
  $$insert into public.auction_ai_review_projections(
      schema_version, sample_sha256, case_id, source_name, source_url,
      capture_sha256, auction_sale_id, mapping_status, field_key, review_state,
      citation_status, value_jsonb
    ) values (
      'immojudis.real-extraction-review.v2', repeat('a', 64), 'case-invalid-field',
      'ai-review-pgtap', 'https://example.test/ai-review/sale-1', repeat('f', 64),
      '38300000-1000-4000-8000-000000000001', 'exact', 'property.fake_field',
      'resolved', 'verified', '"unexpected"'::jsonb
    )$$,
  '23514',
  null,
  'the projection table rejects field keys outside the fixed twelve-field scope'
);

insert into public.auction_sales(
  id, source_name, source_url, title, city, property_type, starting_price_eur, status,
  content_hash, sale_date, habitable_surface_m2, carrez_surface_m2,
  land_surface_m2, occupancy_status, rooms_count, parking_count, raw_payload
)
values (
  '38300000-1000-4000-8000-000000000002',
  'ai-review-pgtap',
  'https://example.test/ai-review/sale-2',
  'AI review complete test sale',
  'Bordeaux',
  'house',
  180000,
  'upcoming',
  repeat('e', 64),
  '2026-09-30 10:00:00+02'::timestamptz,
  100,
  95,
  500,
  'vacant',
  3,
  1,
  '{"source_energy_diagnostics":{"dpe_class":"D","ges_class":"E"},"pdf_energy_diagnostics":{"dpe_class":"D","ges_class":"E"}}'::jsonb
);

select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.property_type', '" House "'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'property type comparison ignores case and surrounding spaces'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.city', '"  BÔRDEAUX  "'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'city comparison ignores accents, case and repeated spaces'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'sale.sale_date', '"2026-09-30"'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'sale date comparison uses the Paris local civil date'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'sale.starting_price_eur', to_jsonb(180000.0),
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'starting price comparison uses numeric equality'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.habitable_surface_m2', to_jsonb(100),
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'habitable surface comparison uses numeric equality'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.carrez_surface_m2', to_jsonb(95),
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'Carrez surface comparison uses numeric equality'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.land_surface_m2', to_jsonb(500),
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'land surface comparison uses numeric equality'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.occupancy_status', '"LIBRE DE TOUTE OCCUPATION"'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'occupancy comparison normalizes the free occupancy enum'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.rooms_count', to_jsonb(3),
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'rooms comparison uses numeric equality'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.parking_count', to_jsonb(1),
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'parking comparison uses numeric equality'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.source_energy_dpe_class', '"d"'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'DPE comparison is case-insensitive for a valid diagnostic class'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.source_energy_ges_class', '"E"'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'match',
  'GES comparison accepts a valid diagnostic class'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.city', '"Paris"'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'conflict',
  'a canonical city mismatch is an explicit conflict'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.carrez_surface_m2', to_jsonb(95),
    '38300000-1000-4000-8000-000000000001'
  )),
  'missing',
  'a missing canonical field is explicit and fail-closed'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.source_energy_dpe_class', '"Z"'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'unsupported',
  'an invalid energy class is unsupported and cannot publish'
);
update public.auction_sales
set raw_payload = '{"source_energy_diagnostics":{"dpe_class":"D","ges_class":"E"},"pdf_energy_diagnostics":{"dpe_class":"E","ges_class":"E"}}'::jsonb
where id = '38300000-1000-4000-8000-000000000002';
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.source_energy_dpe_class', '"D"'::jsonb,
    '38300000-1000-4000-8000-000000000002'
  )),
  'unsupported',
  'disagreeing canonical energy sources fail closed as unsupported'
);
select is(
  (select comparison_status from app_private.ai_review_compare_field(
    'property.city', '"Bordeaux"'::jsonb, null
  )),
  'not_publishable',
  'an orphan projection has no canonical comparison'
);

insert into public.auction_ai_review_case_status(
  schema_version, sample_sha256, case_id, source_name, source_url,
  access_state, capture_sha256, auction_sale_id, mapping_status
)
values (
  'immojudis.real-extraction-review.v2', repeat('c', 64), 'case-complete',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-2',
  'captured', repeat('d', 64),
  '38300000-1000-4000-8000-000000000002', 'exact'
);

insert into public.auction_ai_review_projections(
  schema_version, sample_sha256, case_id, source_name, source_url,
  capture_sha256, canonical_content_hash_at_import, auction_sale_id,
  mapping_status, field_key, review_state,
  citation_status, value_jsonb, evidence_locator
)
select
  'immojudis.real-extraction-review.v2', repeat('c', 64), 'case-complete',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-2', repeat('d', 64),
  repeat('e', 64),
  '38300000-1000-4000-8000-000000000002', 'exact', fields.field_key,
  case when fields.field_key = 'property.rooms_count' then 'unknown' else 'resolved' end,
  case when fields.field_key = 'property.rooms_count' then 'not_required' else 'verified' end,
  case
    when fields.field_key = 'property.rooms_count' then null::jsonb
    when fields.field_key = 'property.property_type' then '"house"'::jsonb
    when fields.field_key = 'property.city' then '"Bordeaux"'::jsonb
    when fields.field_key = 'sale.sale_date' then '"2026-09-30"'::jsonb
    when fields.field_key = 'sale.starting_price_eur' then to_jsonb(180000)
    when fields.field_key = 'property.habitable_surface_m2' then to_jsonb(100)
    when fields.field_key = 'property.carrez_surface_m2' then to_jsonb(95)
    when fields.field_key = 'property.land_surface_m2' then to_jsonb(500)
    when fields.field_key = 'property.occupancy_status' then '"vacant"'::jsonb
    when fields.field_key = 'property.parking_count' then to_jsonb(1)
    when fields.field_key = 'property.source_energy_dpe_class' then '"D"'::jsonb
    when fields.field_key = 'property.source_energy_ges_class' then '"E"'::jsonb
  end,
  '{}'::jsonb
from (values
  ('property.property_type'::text),
  ('property.city'::text),
  ('sale.sale_date'::text),
  ('sale.starting_price_eur'::text),
  ('property.habitable_surface_m2'::text),
  ('property.carrez_surface_m2'::text),
  ('property.land_surface_m2'::text),
  ('property.occupancy_status'::text),
  ('property.rooms_count'::text),
  ('property.parking_count'::text),
  ('property.source_energy_dpe_class'::text),
  ('property.source_energy_ges_class'::text)
) as fields(field_key);

select is(
  (select count(*)::integer
   from public.auction_ai_review_projections
   where sample_sha256 = repeat('c', 64) and case_id = 'case-complete'),
  12,
  'a captured exact case stores one projection for each expected field'
);
select ok(
  not (select local_is_publishable
       from public.auction_ai_review_projections
       where sample_sha256 = repeat('c', 64)
         and case_id = 'case-complete'
         and field_key = 'property.rooms_count'),
  'unknown remains blocked at field level even in a complete review set'
);
select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = '38300000-1000-4000-8000-000000000002'),
  'ai_review_projection_blocked',
  'a captured exact case without an imported canonical hash remains quarantined'
);
select is(
  (select comparison_status
   from public.v_auction_ai_review_projection_reconciliation
   where auction_sale_id = '38300000-1000-4000-8000-000000000002'
     and field_key = 'property.property_type'),
  'not_publishable',
  'a missing canonical case hash prevents a projection from becoming publishable'
);

insert into public.auction_sales(
  id, source_name, source_url, title, city, property_type, starting_price_eur, status,
  content_hash
)
values (
  '38300000-1000-4000-8000-000000000003',
  'ai-review-pgtap',
  'https://example.test/ai-review/sale-3',
  'AI review orphan test sale',
  'Bordeaux',
  'house',
  210000,
  'upcoming',
  repeat('e', 64)
);

insert into public.auction_ai_review_projections(
  schema_version, sample_sha256, case_id, source_name, source_url,
  capture_sha256, canonical_content_hash_at_import, auction_sale_id,
  mapping_status, field_key, review_state,
  citation_status, value_jsonb, evidence_locator
)
values (
  'immojudis.real-extraction-review.v2', repeat('e', 64), 'case-orphan',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-3', repeat('f', 64),
  repeat('e', 64), '38300000-1000-4000-8000-000000000003', 'exact', 'property.property_type',
  'resolved', 'verified', '"house"'::jsonb, '{}'::jsonb
);

select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = '38300000-1000-4000-8000-000000000003'),
  'ai_review_projection_blocked',
  'a publishable-looking projection without a captured case status quarantines its sale'
);

-- Keep one fully reconciled sale available for the positive fact-claim path.
-- The publication view and fact guard both require the complete twelve-field
-- set to be current, captured, and canonically matching.
insert into public.auction_sales(
  id, source_name, source_url, title, city, property_type, starting_price_eur, status,
  content_hash, sale_date, habitable_surface_m2, carrez_surface_m2,
  land_surface_m2, occupancy_status, rooms_count, parking_count, raw_payload
)
values (
  '38300000-1000-4000-8000-000000000004',
  'ai-review-pgtap',
  'https://example.test/ai-review/sale-4',
  'AI review fully reconciled test sale',
  'Bordeaux',
  'apartment',
  200000,
  'upcoming',
  repeat('4', 64),
  '2026-10-01 10:00:00+02'::timestamptz,
  100,
  95,
  500,
  'vacant',
  3,
  1,
  '{"source_energy_diagnostics":{"dpe_class":"D","ges_class":"E"}}'::jsonb
);

insert into public.auction_ai_review_case_status(
  schema_version, sample_sha256, case_id, source_name, source_url,
  access_state, capture_sha256, canonical_content_hash_at_import,
  auction_sale_id, mapping_status
)
values (
  'immojudis.real-extraction-review.v2', repeat('8', 64), 'case-valid-all',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-4',
  'captured', repeat('9', 64), repeat('4', 64),
  '38300000-1000-4000-8000-000000000004', 'exact'
);

insert into public.auction_ai_review_projections(
  schema_version, sample_sha256, case_id, source_name, source_url,
  capture_sha256, canonical_content_hash_at_import, auction_sale_id,
  mapping_status, field_key, review_state,
  citation_status, value_jsonb, evidence_locator
)
select
  'immojudis.real-extraction-review.v2', repeat('8', 64), 'case-valid-all',
  'ai-review-pgtap', 'https://example.test/ai-review/sale-4', repeat('9', 64),
  repeat('4', 64),
  '38300000-1000-4000-8000-000000000004', 'exact', fields.field_key,
  'resolved',
  'verified',
  case
    when fields.field_key = 'property.property_type' then '"apartment"'::jsonb
    when fields.field_key = 'property.city' then '"Bordeaux"'::jsonb
    when fields.field_key = 'sale.sale_date' then '"2026-10-01"'::jsonb
    when fields.field_key = 'sale.starting_price_eur' then to_jsonb(200000)
    when fields.field_key = 'property.habitable_surface_m2' then to_jsonb(100)
    when fields.field_key = 'property.carrez_surface_m2' then to_jsonb(95)
    when fields.field_key = 'property.land_surface_m2' then to_jsonb(500)
    when fields.field_key = 'property.occupancy_status' then '"vacant"'::jsonb
    when fields.field_key = 'property.rooms_count' then to_jsonb(3)
    when fields.field_key = 'property.parking_count' then to_jsonb(1)
    when fields.field_key = 'property.source_energy_dpe_class' then '"D"'::jsonb
    when fields.field_key = 'property.source_energy_ges_class' then '"E"'::jsonb
  end,
  '{}'::jsonb
from (values
  ('property.property_type'::text),
  ('property.city'::text),
  ('sale.sale_date'::text),
  ('sale.starting_price_eur'::text),
  ('property.habitable_surface_m2'::text),
  ('property.carrez_surface_m2'::text),
  ('property.land_surface_m2'::text),
  ('property.occupancy_status'::text),
  ('property.rooms_count'::text),
  ('property.parking_count'::text),
  ('property.source_energy_dpe_class'::text),
  ('property.source_energy_ges_class'::text)
) as fields(field_key);

select is(
  coalesce((select raw_payload->>'publication_quarantine' from public.auction_sales
            where id = '38300000-1000-4000-8000-000000000004'), ''),
  '',
  'a fully reconciled twelve-field sale clears the AI quarantine marker'
);

update public.auction_sales
set raw_payload = '{}'::jsonb
where id = '38300000-1000-4000-8000-000000000001';

select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = '38300000-1000-4000-8000-000000000001'),
  'ai_review_projection_blocked',
  'the canonical sale guard reapplies the quarantine after a pipeline update'
);

update public.auction_sales
set raw_payload = '{"publication_quarantine":"operator_hold"}'::jsonb
where id = '38300000-1000-4000-8000-000000000001';

select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = '38300000-1000-4000-8000-000000000001'),
  'operator_hold',
  'an existing operator quarantine is preserved while the AI blocker remains'
);
select throws_ok(
  $$insert into public.auction_ai_review_projections(
      schema_version, sample_sha256, case_id, source_name, source_url,
      capture_sha256, auction_sale_id, mapping_status, field_key, review_state,
      citation_status, value_jsonb
    ) values (
      'immojudis.real-extraction-review.v2', repeat('a', 64), 'case-mismatch',
      'other-source', 'https://example.test/ai-review/sale-1', repeat('f', 64),
      '38300000-1000-4000-8000-000000000001', 'exact', 'property.property_type',
      'resolved', 'verified', '"apartment"'::jsonb
    )$$,
  '55000',
  'AI review mapping must match one exact source name and URL.',
  'a mismatched source identity cannot become an exact mapping'
);

select throws_ok(
  $$insert into public.auction_fact_claims(
      id, auction_sale_id, field_key, value_jsonb, claim_status,
      evidence_kind, source_url, evidence_locator, ai_review_projection_id
    ) values (
      '38300000-3000-4000-8000-000000000001',
      '38300000-1000-4000-8000-000000000001',
      'property.city', '"Bordeaux"'::jsonb, 'candidate', 'source_listing',
      'https://example.test/ai-review/sale-1', '{}',
      '38300000-2000-4000-8000-000000000003'
    )$$,
  '55000',
  'An auction fact claim may link only to a publishable AI review projection for the same sale and field.',
  'a fact claim cannot link to an unverified AI review field'
);

select lives_ok(
  $$insert into public.auction_fact_claims(
      id, auction_sale_id, field_key, value_jsonb, claim_status,
      evidence_kind, source_url, evidence_locator, ai_review_projection_id
    ) values (
      '38300000-3000-4000-8000-000000000002',
      '38300000-1000-4000-8000-000000000004',
      'property.property_type', '"apartment"'::jsonb, 'candidate', 'source_listing',
      'https://example.test/ai-review/sale-4', '{}',
      (select id
       from public.auction_ai_review_projections
       where sample_sha256 = repeat('8', 64)
         and case_id = 'case-valid-all'
         and field_key = 'property.property_type')
    )$$,
  'a fact claim may link to a fully reconciled AI review projection'
);
update public.auction_fact_claims
set claim_status = 'accepted',
    resolution_actor_type = 'rule',
    resolved_at = '2026-09-29T12:00:00+02'::timestamptz,
    resolution_note = 'The linked AI projection is fully reconciled.'
where id = '38300000-3000-4000-8000-000000000002';
select is(
  (select is_publishable
   from public.v_auction_fact_claims_read_model
   where claim_id = '38300000-3000-4000-8000-000000000002'),
  true,
  'a fact claim linked to a fully reconciled AI projection is publishable'
);

update public.auction_sales
set content_hash = repeat('5', 64)
where id = '38300000-1000-4000-8000-000000000004';

select is(
  (select is_publishable
   from public.v_auction_fact_claims_read_model
   where claim_id = '38300000-3000-4000-8000-000000000002'),
  false,
  'an accepted fact claim disappears from the publishable contract when its AI projection is stale'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', 'c2a8d1d245e738efc7549be148a59716aa32a4958aed4db996ea860a0427f6f1',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', jsonb_build_array(jsonb_build_object(
        'schema_version', 'immojudis.real-extraction-review.v2',
        'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
        'case_id', 'case-bounded-value',
        'source_name', 'ai-review-pgtap',
        'source_url', 'https://example.test/ai-review/sale-1',
        'access_state', 'captured',
        'capture_sha256', repeat('1', 64),
        'mapping_status', 'server_exact_required'
      )),
      'projections', jsonb_build_array(jsonb_build_object(
        'schema_version', 'immojudis.real-extraction-review.v2',
        'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
        'case_id', 'case-bounded-value',
        'source_name', 'ai-review-pgtap',
        'source_url', 'https://example.test/ai-review/sale-1',
        'capture_sha256', repeat('1', 64),
        'mapping_status', 'server_exact_required',
        'field_key', 'property.city',
        'review_state', 'resolved',
        'citation_status', 'verified',
        'value_jsonb', to_jsonb(42),
        'evidence_locator', '{}'::jsonb,
        'block_reason', null
      ))
    )
  )$$,
  '23514',
  'AI review projection value is outside the bounded field contract.',
  'the import function rejects a resolved AI value outside the field contract'
);

select throws_ok(
  $$insert into public.auction_fact_claims(
      id, auction_sale_id, field_key, value_jsonb, claim_status,
      evidence_kind, source_url, evidence_locator, ai_review_projection_id
    ) values (
      '38300000-3000-4000-8000-000000000003',
      '38300000-1000-4000-8000-000000000001',
      'property.property_type', '"house"'::jsonb, 'candidate', 'source_listing',
      'https://example.test/ai-review/sale-1', '{}',
      '38300000-2000-4000-8000-000000000001'
    )$$,
  '55000',
  'An auction fact claim may link only to a publishable AI review projection for the same sale and field.',
  'a fact claim value must equal the linked AI review projection value'
);

select throws_ok(
  $$insert into public.auction_ai_review_projections(
      schema_version, sample_sha256, case_id, source_name, source_url,
      capture_sha256, auction_sale_id, mapping_status, field_key, review_state,
      citation_status, value_jsonb
    ) values (
      'immojudis.real-extraction-review.v2', repeat('a', 64), 'case-no-reason',
      'ai-review-pgtap', 'https://example.test/ai-review/sale-1', repeat('f', 64),
      '38300000-1000-4000-8000-000000000001', 'exact', 'property.city',
      'unresolved', 'not_required', null
    )$$,
  '23514',
  'new row for relation "auction_ai_review_projections" violates check constraint "auction_ai_review_projection_block_reason"',
  'blocked AI review rows retain an explicit reason'
);

select throws_ok(
  $$update public.auction_sales
      set source_url = 'https://example.test/ai-review/changed-identity'
    where id = '38300000-1000-4000-8000-000000000001'$$,
  '55000',
  'AI_REVIEW_SOURCE_IDENTITY_IMMUTABLE',
  'a reviewed sale cannot change source identity while its exact AI mapping remains stored'
);

update public.auction_sales
set raw_payload = '{}'::jsonb,
    content_hash = repeat('f', 64)
where id = '38300000-1000-4000-8000-000000000003';

-- Exercise the application read role after all owner writes are complete,
-- then restore the owner role for pgTAP finalization.
set local role service_role;
select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = '38300000-1000-4000-8000-000000000003'),
  'ai_review_content_hash_changed',
  'a canonical content hash change quarantines the reviewed sale'
);
set local role postgres;

select * from finish();

rollback;
