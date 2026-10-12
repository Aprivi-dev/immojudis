begin;

select plan(7);

select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.api_ip_rate_limit_buckets'::regclass),
  'the IP rate-limit table has row level security enabled'
);

select ok(
  not has_table_privilege('anon', 'public.api_ip_rate_limit_buckets', 'select')
  and not has_table_privilege('authenticated', 'public.api_ip_rate_limit_buckets', 'select'),
  'browser roles cannot read the IP rate-limit table'
);

select ok(
  not has_function_privilege(
    'anon', 'public.consume_ip_rate_limit(text,text,integer,integer)', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'public.consume_ip_rate_limit(text,text,integer,integer)', 'execute'
  )
  and has_function_privilege(
    'service_role', 'public.consume_ip_rate_limit(text,text,integer,integer)', 'execute'
  ),
  'only service_role may consume IP rate-limit units'
);

select is(
  public.consume_ip_rate_limit(repeat('a', 64), 'test.bucket', 3600, 2),
  1,
  'the first call in a window counts as one'
);

select is(
  public.consume_ip_rate_limit(repeat('a', 64), 'test.bucket', 3600, 2),
  2,
  'the second call counts as two'
);

select throws_ok(
  $$select public.consume_ip_rate_limit(repeat('a', 64), 'test.bucket', 3600, 2)$$,
  'P0001',
  'Rate limit exceeded.',
  'the call above the limit is rejected'
);

select throws_ok(
  $$select public.consume_ip_rate_limit('203.0.113.9', 'test.bucket', 3600, 2)$$,
  '22023',
  'Invalid rate-limit parameters.',
  'a raw IP address is refused: only a SHA-256 digest is accepted'
);

select * from finish();
rollback;
