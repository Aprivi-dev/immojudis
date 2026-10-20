-- Page admin « Pilotage » (point 65) : agrégats exacts sur 7 et 30 jours glissants, nombres seulement,
-- lus par le serveur (service_role) et fermés aux rôles du navigateur. La fonction a été remplacée par
-- la migration 20261029120200 (semaine précédente, comptes distincts, administrateurs exclus : voir le
-- test 547) ; les chiffres d'origine ci-dessous restent vrais. Les chiffres sont comparés à un
-- relevé pris avant les données de test (écarts), pour ne pas dépendre de ce que la base contient déjà.
begin;

select plan(30);

-- Structure and privileges ----------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE'),
  'the summary is for the server (service role) only'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_pilotage_summary(timestamptz)'::regprocedure),
  true,
  'the summary is stable, security definer and has an empty search_path'
);

set local role anon;
select throws_ok(
  $$select public.admin_pilotage_summary()$$, '42501', null, 'anon cannot read the summary'
);
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c5110000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.admin_pilotage_summary()$$, '42501', null, 'a signed-in account cannot read the summary'
);
reset role;
-- Sans compte connecté pour la suite : sinon auth.uid() reste ce compte et les déclencheurs des
-- tables de test (alertes) refusent d'écrire pour un autre.
set local "request.jwt.claims" = '';

-- Reading before the fixtures ----------------------------------------------------------------------
update app_private.account_product_events_measure set started_at = '2026-10-20T00:00:00Z';

create temporary table pgtap_511_summary (
  case_name text primary key,
  summary jsonb
) on commit drop;

insert into pgtap_511_summary
select 'before', public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz);

-- Fixtures: now is 2026-11-10 12:00 UTC, so the 7-day window starts on 2026-11-03 12:00 and the 30-day
-- window on 2026-10-11 12:00.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5110000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot-one@example.test', '', now(),
   '2026-11-09T10:00:00Z', now(), '2026-11-09T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5110000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot-two@example.test', '', now(),
   '2026-11-05T10:00:00Z', now(), '2026-11-08T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5110000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot-three@example.test', '', now(),
   '2026-10-20T10:00:00Z', now(), '2026-10-25T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5110000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot-four@example.test', '', now(),
   '2026-09-01T10:00:00Z', now(), '2026-11-01T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5110000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot-five@example.test', '', now(),
   '2026-09-01T10:00:00Z', now(), null, '{}'::jsonb, '{}'::jsonb),
  -- Created and seen after the reading instant: counted nowhere.
  ('c5110000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot-six@example.test', '', now(),
   '2026-11-11T10:00:00Z', now(), '2026-11-11T10:00:00Z', '{}'::jsonb, '{}'::jsonb);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c5110000-1000-4000-8000-000000000001', 'pilotage-test',
   'https://example.test/pilotage/1', 'Pilotage sale one', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c5110000-1000-4000-8000-000000000002', 'pilotage-test',
   'https://example.test/pilotage/2', 'Pilotage sale two', 'upcoming', '2099-01-02 12:00:00Z');

-- Alerts: one in both windows, one in the 30-day window, one in neither.
insert into public.user_alerts (id, user_id, name, alert_frequency, created_at)
values
  ('c5110000-2000-4000-8000-000000000001', 'c5110000-0000-4000-8000-000000000001',
   'Pilot alert one', 'weekly', '2026-11-08T10:00:00Z'),
  ('c5110000-2000-4000-8000-000000000002', 'c5110000-0000-4000-8000-000000000002',
   'Pilot alert two', 'weekly', '2026-10-15T10:00:00Z'),
  ('c5110000-2000-4000-8000-000000000003', 'c5110000-0000-4000-8000-000000000003',
   'Pilot alert three', 'weekly', '2026-09-01T10:00:00Z');

-- Waiting list: one in both windows, one withdrawn in the 30-day window, one active in it.
insert into public.offer_opening_notifications (
  user_id, consent_text_version, consented_at, notify_enabled, revoked_at
) values
  ('c5110000-0000-4000-8000-000000000001', 'v-test', '2026-11-09T10:00:00Z', true, null),
  ('c5110000-0000-4000-8000-000000000002', 'v-test', '2026-10-20T10:00:00Z', false,
   '2026-10-21T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000003', 'v-test', '2026-10-25T10:00:00Z', true, null);

-- Events (the second account is inside both windows too; the third is outside them).
insert into public.account_product_events (user_id, event_type, detail, sale_id, occurred_at)
values
  ('c5110000-0000-4000-8000-000000000001', 'sale_unlocked', null, 'c5110000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000002', 'sale_unlocked', null, 'c5110000-1000-4000-8000-000000000001', '2026-10-20T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000003', 'sale_unlocked', null, 'c5110000-1000-4000-8000-000000000001', '2026-09-01T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000003', 'sale_unlocked', null, 'c5110000-1000-4000-8000-000000000002', '2026-11-11T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000001', 'quota_reached', 'unlocks', null, '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000001', 'quota_reached', 'favorites', null, '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000002', 'quota_reached', 'daily', null, '2026-10-20T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c5110000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000002', 'bid_ceiling_calculated', null, 'c5110000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000002', 'bid_ceiling_calculated', null, 'c5110000-1000-4000-8000-000000000002', '2026-10-20T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000001', 'calendar_exported', null, 'c5110000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000001', 'calendar_exported', null, 'c5110000-1000-4000-8000-000000000001', '2026-10-15T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000001', 'email_clicked', 'alert', 'c5110000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000002', 'email_clicked', 'reminder', 'c5110000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5110000-0000-4000-8000-000000000002', 'email_clicked', 'alert', 'c5110000-1000-4000-8000-000000000001', '2026-10-12T10:00:00Z');

insert into pgtap_511_summary
select 'after', public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz);

-- Difference between the reading after and before the fixtures, for one figure of one window.
create function pg_temp.delta(p_path text[]) returns integer
language sql stable as $$
  select ((select summary from pgtap_511_summary where case_name = 'after') #>> p_path)::integer
       - ((select summary from pgtap_511_summary where case_name = 'before') #>> p_path)::integer;
$$;

-- Accounts ---------------------------------------------------------------------------------------
select is(pg_temp.delta('{windows,0,signups}'), 2, '7 days: two accounts created');
select is(pg_temp.delta('{windows,1,signups}'), 3, '30 days: three accounts created');
select is(pg_temp.delta('{windows,0,active_accounts}'), 2, '7 days: two accounts connected');
select is(pg_temp.delta('{windows,1,active_accounts}'), 4, '30 days: four accounts connected');

-- Alerts and waiting list -----------------------------------------------------------------------------
select is(pg_temp.delta('{windows,0,alerts_created}'), 1, '7 days: one alert created');
select is(pg_temp.delta('{windows,1,alerts_created}'), 2, '30 days: two alerts created');
select is(pg_temp.delta('{windows,0,waitlist_requests}'), 1, '7 days: one waiting list request');
select is(pg_temp.delta('{windows,1,waitlist_requests}'), 3, '30 days: three waiting list requests');
select is(pg_temp.delta('{waitlist_active}'), 2, 'two requests are active now (the withdrawn one is not)');

-- Events ----------------------------------------------------------------------------------------------
select is(pg_temp.delta('{windows,0,events,unlocks}'), 1, '7 days: one unlock');
select is(pg_temp.delta('{windows,1,events,unlocks}'), 2, '30 days: two unlocks (nothing before the window or after now)');
select is(pg_temp.delta('{windows,0,events,quota_reached,total}'), 2, '7 days: two quotas reached');
select is(pg_temp.delta('{windows,1,events,quota_reached,total}'), 3, '30 days: three quotas reached');
select is(
  array[
    pg_temp.delta('{windows,1,events,quota_reached,unlocks}'),
    pg_temp.delta('{windows,1,events,quota_reached,favorites}'),
    pg_temp.delta('{windows,1,events,quota_reached,daily}')
  ],
  array[1, 1, 1],
  '30 days: one quota of each kind'
);
select is(pg_temp.delta('{windows,0,events,bid_ceilings}'), 2, '7 days: two bid ceilings');
select is(pg_temp.delta('{windows,1,events,bid_ceilings}'), 3, '30 days: three bid ceilings');
select is(pg_temp.delta('{windows,0,events,calendar_exports}'), 1, '7 days: one calendar export');
select is(pg_temp.delta('{windows,1,events,calendar_exports}'), 2, '30 days: two calendar exports');
select is(
  array[
    pg_temp.delta('{windows,0,events,email_clicks,total}'),
    pg_temp.delta('{windows,0,events,email_clicks,alert}'),
    pg_temp.delta('{windows,0,events,email_clicks,reminder}')
  ],
  array[2, 1, 1],
  '7 days: two email clicks, one of each kind'
);
select is(
  array[
    pg_temp.delta('{windows,1,events,email_clicks,total}'),
    pg_temp.delta('{windows,1,events,email_clicks,alert}'),
    pg_temp.delta('{windows,1,events,email_clicks,reminder}')
  ],
  array[3, 2, 1],
  '30 days: three email clicks'
);

-- Measure start ----------------------------------------------------------------------------------------
select is(
  (select array[
      (summary #>> '{windows,0,events_complete}'),
      (summary #>> '{windows,1,events_complete}'),
      (summary ->> 'events_measured_since')::timestamptz::text
    ] from pgtap_511_summary where case_name = 'after'),
  array['true', 'false', '2026-10-20 00:00:00+00'],
  'the 7-day window is fully measured, the 30-day window is flagged partial with the start date'
);

delete from app_private.account_product_events_measure;
select is(
  (select array[
      public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{windows,0,events}',
      public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{windows,1,events}',
      public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) ->> 'events_measured_since'
    ]),
  array[null, null, null]::text[],
  'without a start of measure, the events are null (non mesuré), never zero'
);
select is(
  (public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{windows,0,signups}')::integer
    - (select (summary #>> '{windows,0,signups}')::integer from pgtap_511_summary where case_name = 'before'),
  2,
  'the account figures do not depend on the start of measure'
);

-- Shape: numbers and dates only, no person ------------------------------------------------------------------
select is(
  (select jsonb_array_length(summary -> 'windows') from pgtap_511_summary where case_name = 'after'),
  2,
  'two windows are returned'
);
select ok(
  (select summary::text !~* '(@|user_id|example\.test)' from pgtap_511_summary where case_name = 'after'),
  'the summary carries no address and no account identifier'
);
select is(
  (select array_agg(key order by key) from jsonb_object_keys(
     (select summary from pgtap_511_summary where case_name = 'after')) as key),
  array['events_measured_since', 'generated_at', 'snapshot', 'waitlist_active', 'windows'],
  'the summary has only its top-level fields (the snapshot was added by 20261029120200)'
);

select * from finish();
rollback;
