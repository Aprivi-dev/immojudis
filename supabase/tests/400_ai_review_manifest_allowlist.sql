begin;

select plan(10);

set local role postgres;

select lives_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', 'c2a8d1d245e738efc7549be148a59716aa32a4958aed4db996ea860a0427f6f1',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  'the original v4 manifest remains accepted'
);

select lives_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '1fc0cab8cb191476d073f384ce52e14a05a1ce953bed4f75521d0eecc12e95ae',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  'the v4.2 manifest is accepted after its explicit allowlist approval'
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
  'an arbitrary manifest digest remains rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '7b3173e09f3a3989700022cb5bea0a79c2af12e0a75c0ddee8d9f26365b2cbb8',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'the rejected v4.1 manifest remains blocked'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'a payload without a manifest digest is rejected'
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
  'a payload with a null manifest digest is rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '1fc0cab8cb191476d073f384ce52e14a05a1ce953bed4f75521d0eecc12e95ae',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload format.',
  'a payload without the import format is rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'manifest_sha256', '1fc0cab8cb191476d073f384ce52e14a05a1ce953bed4f75521d0eecc12e95ae',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'a payload without the schema version is rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '1fc0cab8cb191476d073f384ce52e14a05a1ce953bed4f75521d0eecc12e95ae',
      'case_statuses', '[]'::jsonb,
      'projections', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'a payload without the sample digest is rejected'
);

select throws_ok(
  $$select app_private.import_ai_review_payload(
    jsonb_build_object(
      'format', 'immojudis.ai-review-import.v1',
      'schema_version', 'immojudis.real-extraction-review.v2',
      'manifest_sha256', '1fc0cab8cb191476d073f384ce52e14a05a1ce953bed4f75521d0eecc12e95ae',
      'sample_sha256', '19e9756c127e1246353ef879aae92c83a254da8c95acb4bad9afb2479bfce424',
      'case_statuses', '[]'::jsonb
    )
  )$$,
  '22023',
  'Invalid AI review import payload metadata.',
  'a payload without the projections array is rejected'
);

select * from finish();

rollback;
