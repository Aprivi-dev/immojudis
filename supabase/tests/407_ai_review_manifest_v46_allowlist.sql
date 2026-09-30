begin;

select plan(7);

set local role postgres;

select lives_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '2f35c35b50abc9709178ae935bad4d140724c37d94c165fd11188236dc6c1af4',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  'the final v4.6 manifest is accepted after its explicit allowlist approval'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '24085f1160cfb514a62b75182d93cd8569254b2faf9347ffb19060f7b3c98a4a',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'the v4.3 intermediate manifest remains rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '945fd0634077f5ee7adf1a79183de3912cb649165ab1e827f30ee96a5c61c271',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'the v4.4 intermediate manifest remains rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '1c25823b5d79ce1a97100e8329501dd44394712c31fe3147e746c1e4643c8ae3',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'the v4.5 intermediate manifest remains rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', repeat('f', 64),
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'an arbitrary manifest digest remains rejected after v4.6 approval'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', null,
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'a null manifest digest remains rejected after v4.6 approval'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v3',
      'manifest_sha256', '2f35c35b50abc9709178ae935bad4d140724c37d94c165fd11188236dc6c1af4',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'a wrong schema version remains rejected after v4.6 approval'
);

select * from finish();

rollback;
