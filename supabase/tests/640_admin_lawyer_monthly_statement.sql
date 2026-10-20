-- Relevé mensuel des avocats référencés (point 72) : trois nombres par avocat et par mois civil
-- (heure de Paris), lus par le serveur (service_role) et fermés aux rôles du navigateur. Aucune donnée
-- d'acquéreur ni de compte dans le résultat.
begin;

select plan(14);

-- Structure and privileges ----------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_lawyer_monthly_statement(date)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_lawyer_monthly_statement(date)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_lawyer_monthly_statement(date)', 'EXECUTE'),
  'the statement is for the server (service role) only'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_lawyer_monthly_statement(date)'::regprocedure),
  true,
  'the statement is stable, security definer and has an empty search_path'
);

set local role anon;
select throws_ok(
  $$select * from public.admin_lawyer_monthly_statement('2026-11-01')$$,
  '42501', null, 'anon cannot read the statement'
);
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c6400000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select * from public.admin_lawyer_monthly_statement('2026-11-01')$$,
  '42501', null, 'a signed-in account cannot read the statement'
);
reset role;
set local "request.jwt.claims" = '';

set local role service_role;
select lives_ok(
  $$select * from public.admin_lawyer_monthly_statement('2026-11-01')$$,
  'the service role can read the statement'
);
reset role;

select throws_ok(
  $$select * from public.admin_lawyer_monthly_statement(null)$$,
  '22023', 'The statement month is required.', 'a missing month is refused'
);

-- Fixtures ----------------------------------------------------------------------------------------
-- Paris is on UTC+1 from 25 October 2026 (end of summer time): November 2026 runs from
-- 2026-10-31 23:00 UTC (included) to 2026-11-30 23:00 UTC (excluded).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c6400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'statement-buyer@example.test', '', now(),
   now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.referenced_lawyers (id, status, display_name, firm_name, email)
values
  ('c6400000-1000-4000-8000-000000000001', 'active', 'Statement A', 'Cabinet A', 'a@example.test'),
  ('c6400000-1000-4000-8000-000000000002', 'active', 'Statement B', null, 'b@example.test'),
  ('c6400000-1000-4000-8000-000000000003', 'paused', 'Statement C', null, 'c@example.test'),
  ('c6400000-1000-4000-8000-000000000004', 'paused', 'Statement D', null, 'd@example.test');

insert into public.lawyer_placement_events (lawyer_id, event_type, created_at)
values
  -- A: three impressions in November (two on the edges), two just outside it.
  ('c6400000-1000-4000-8000-000000000001', 'impression', '2026-10-31T22:59:59Z'),
  ('c6400000-1000-4000-8000-000000000001', 'impression', '2026-10-31T23:00:00Z'),
  ('c6400000-1000-4000-8000-000000000001', 'impression', '2026-11-15T10:00:00Z'),
  ('c6400000-1000-4000-8000-000000000001', 'impression', '2026-11-30T22:59:59Z'),
  ('c6400000-1000-4000-8000-000000000001', 'impression', '2026-11-30T23:00:00Z'),
  -- A: one click in November, one in December.
  ('c6400000-1000-4000-8000-000000000001', 'cta_click', '2026-11-15T10:05:00Z'),
  ('c6400000-1000-4000-8000-000000000001', 'cta_click', '2026-12-02T10:00:00Z'),
  -- C (paused) has activity in November: it stays on the statement.
  ('c6400000-1000-4000-8000-000000000003', 'impression', '2026-11-10T10:00:00Z');

insert into public.lawyer_referral_requests (
  id, requester_id, requester_email, requested_lawyer_id, status, message, phone, sent_at, created_at
) values
  -- Sent in November.
  ('c6400000-2000-4000-8000-000000000001', 'c6400000-0000-4000-8000-000000000001',
   'statement-buyer@example.test', 'c6400000-1000-4000-8000-000000000001',
   'sent_to_lawyer', 'private message', '0600000000', '2026-11-10T09:00:00Z', '2026-11-09T09:00:00Z'),
  -- Sent in November, answered since: still counted in November.
  ('c6400000-2000-4000-8000-000000000002', 'c6400000-0000-4000-8000-000000000001',
   'statement-buyer@example.test', 'c6400000-1000-4000-8000-000000000001',
   'responded', null, null, '2026-11-20T09:00:00Z', '2026-11-19T09:00:00Z'),
  -- Received in November, not sent yet: not counted.
  ('c6400000-2000-4000-8000-000000000003', 'c6400000-0000-4000-8000-000000000001',
   'statement-buyer@example.test', 'c6400000-1000-4000-8000-000000000001',
   'new', null, null, null, '2026-11-25T09:00:00Z'),
  -- Received in November, sent in December: counted in December only.
  ('c6400000-2000-4000-8000-000000000004', 'c6400000-0000-4000-8000-000000000001',
   'statement-buyer@example.test', 'c6400000-1000-4000-8000-000000000001',
   'sent_to_lawyer', null, null, '2026-12-01T09:00:00Z', '2026-11-28T09:00:00Z'),
  -- Not attributed to a lawyer: counted nowhere.
  ('c6400000-2000-4000-8000-000000000005', 'c6400000-0000-4000-8000-000000000001',
   'statement-buyer@example.test', null,
   'sent_to_lawyer', null, null, '2026-11-12T09:00:00Z', '2026-11-12T08:00:00Z');

create temporary table pgtap_640_november on commit drop as
select * from public.admin_lawyer_monthly_statement('2026-11-17');
create temporary table pgtap_640_december on commit drop as
select * from public.admin_lawyer_monthly_statement('2026-12-01');

-- Figures ------------------------------------------------------------------------------------------
select is(
  (select array[impressions, cta_clicks, referral_requests_sent]
     from pgtap_640_november where lawyer_id = 'c6400000-1000-4000-8000-000000000001'),
  array[3, 1, 2]::bigint[],
  'November: lawyer A has 3 displays, 1 click and 2 requests sent (edges of the Paris month respected)'
);
select is(
  (select array[impressions, cta_clicks, referral_requests_sent]
     from pgtap_640_november where lawyer_id = 'c6400000-1000-4000-8000-000000000002'),
  array[0, 0, 0]::bigint[],
  'an active lawyer without activity is listed with zeros'
);
select is(
  (select array[impressions, cta_clicks, referral_requests_sent]
     from pgtap_640_november where lawyer_id = 'c6400000-1000-4000-8000-000000000003'),
  array[1, 0, 0]::bigint[],
  'a paused lawyer with activity in the month stays on the statement'
);
select is(
  (select count(*) from pgtap_640_november where lawyer_id = 'c6400000-1000-4000-8000-000000000004'),
  0::bigint,
  'a paused lawyer without activity is not listed'
);
select is(
  (select array_agg(lawyer_id order by display_name)
     from pgtap_640_november
    where lawyer_id::text like 'c6400000-1000-4000-8000-00000000000%'),
  array[
    'c6400000-1000-4000-8000-000000000001',
    'c6400000-1000-4000-8000-000000000002',
    'c6400000-1000-4000-8000-000000000003'
  ]::uuid[],
  'the lawyers of the statement are the active ones and those with activity'
);
select is(
  (select array[impressions, cta_clicks, referral_requests_sent]
     from pgtap_640_december where lawyer_id = 'c6400000-1000-4000-8000-000000000001'),
  array[1, 1, 1]::bigint[],
  'December: the edge events and the request sent on 1 December belong to December'
);
select is(
  (select array_agg(row(lawyer_id, impressions, cta_clicks, referral_requests_sent)::text order by lawyer_id)
     from public.admin_lawyer_monthly_statement('2026-11-01')
    where lawyer_id::text like 'c6400000-1000-4000-8000-00000000000%'),
  (select array_agg(row(lawyer_id, impressions, cta_clicks, referral_requests_sent)::text order by lawyer_id)
     from public.admin_lawyer_monthly_statement('2026-11-30')
    where lawyer_id::text like 'c6400000-1000-4000-8000-00000000000%'),
  'only the month of the date counts, not its day'
);

-- Shape: numbers and the lawyer's own name, no buyer data ------------------------------------------------
select is(
  (select array_agg(attribute.attname::text order by attribute.attnum)
     from pg_attribute attribute
    where attribute.attrelid = 'pgtap_640_november'::regclass
      and attribute.attnum > 0 and not attribute.attisdropped),
  array['lawyer_id', 'display_name', 'firm_name', 'impressions', 'cta_clicks', 'referral_requests_sent'],
  'the statement has only the lawyer identity and three counts: no requester, message or phone'
);

select * from finish();
rollback;
