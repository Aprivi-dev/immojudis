-- 20261110200000 : messages reçus à l'adresse de réponse de l'agent d'information SANS dossier ouvert.
--   * table réservée à service_role (RLS activée, aucun droit ni politique pour anon ni authenticated : un
--     administrateur passe par les routes d'administration, qui lisent avec service_role) ;
--   * contraintes (motif connu, état cohérent avec la date de traitement, extrait borné, une ligne par message
--     du fournisseur) ;
--   * purge isolée, seizième partie de public.run_data_retention : 12 mois si l'expéditeur était connu, 21 jours
--     sinon, repère created_at, quel que soit l'état « à traiter » ou « traité ».
-- Les durées sont celles de la migration, à confirmer par juridique-rgpd.
begin;

select plan(23);

-- Structure et droits -------------------------------------------------------------------------------------------

select has_table('public', 'information_agent_unrouted_messages', 'the unrouted messages table exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.information_agent_unrouted_messages'::regclass),
  'the table has RLS enabled'
);

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'information_agent_unrouted_messages'),
  0::bigint,
  'no policy opens the table to the browser roles'
);

select ok(
  not has_table_privilege('anon', 'public.information_agent_unrouted_messages', 'SELECT')
  and not has_table_privilege('anon', 'public.information_agent_unrouted_messages', 'INSERT')
  and not has_table_privilege('anon', 'public.information_agent_unrouted_messages', 'UPDATE')
  and not has_table_privilege('anon', 'public.information_agent_unrouted_messages', 'DELETE')
  and not has_table_privilege('authenticated', 'public.information_agent_unrouted_messages', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_unrouted_messages', 'INSERT')
  and not has_table_privilege('authenticated', 'public.information_agent_unrouted_messages', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.information_agent_unrouted_messages', 'DELETE'),
  'anon and signed-in accounts have no privilege on the table'
);

select ok(
  has_table_privilege('service_role', 'public.information_agent_unrouted_messages', 'SELECT')
  and has_table_privilege('service_role', 'public.information_agent_unrouted_messages', 'INSERT')
  and has_table_privilege('service_role', 'public.information_agent_unrouted_messages', 'UPDATE')
  and has_table_privilege('service_role', 'public.information_agent_unrouted_messages', 'DELETE'),
  'service_role reads and writes the table'
);

-- Contraintes ----------------------------------------------------------------------------------------------------

select throws_ok(
  $$insert into public.information_agent_unrouted_messages (provider_email_id, received_at, reason)
    values ('865-bad-reason', now(), 'spam')$$,
  '23514', null, 'an unknown reason is refused'
);

select throws_ok(
  $$insert into public.information_agent_unrouted_messages
      (provider_email_id, received_at, reason, status)
    values ('865-bad-status', now(), 'no_token', 'handled')$$,
  '23514', null, 'a handled message without a handling date is refused'
);

select throws_ok(
  $$insert into public.information_agent_unrouted_messages (provider_email_id, received_at, reason, excerpt)
    values ('865-long', now(), 'no_token', repeat('a', 1001))$$,
  '23514', null, 'an excerpt over 1 000 characters is refused'
);

insert into public.information_agent_unrouted_messages (provider_email_id, received_at, reason)
values ('865-duplicate', now(), 'no_token');

select throws_ok(
  $$insert into public.information_agent_unrouted_messages (provider_email_id, received_at, reason)
    values ('865-duplicate', now(), 'unknown_case')$$,
  '23505', null, 'a second row for the same provider message is refused'
);

delete from public.information_agent_unrouted_messages where provider_email_id = '865-duplicate';

-- Lecture et écriture selon le rôle ----------------------------------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8650000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unrouted-user@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c8650000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unrouted-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c8650000-0000-4000-8000-000000000002';

-- Jeu d'essai de la purge (instant de la purge : 2026-12-01). 12 mois avant : 2025-12-01 ; 21 jours avant :
-- 2026-11-10. Les deux bornes exactes sont conservées (comparaison stricte).
insert into public.information_agent_unrouted_messages
  (provider_email_id, sender, sender_email, subject, received_at, reason, sender_known, status, handled_at, created_at)
values
  ('865-known-old', 'Me A <a@example.test>', 'a@example.test', 'Re: A', '2025-11-30T23:59:59Z', 'case_not_open', true,
   'pending', null, '2025-11-30T23:59:59Z'),
  ('865-known-edge', 'Me B <b@example.test>', 'b@example.test', 'Re: B', '2025-12-01T00:00:00Z', 'case_not_open', true,
   'pending', null, '2025-12-01T00:00:00Z'),
  ('865-known-recent', 'Me C <c@example.test>', 'c@example.test', 'Re: C', '2026-06-01T00:00:00Z', 'unknown_case', true,
   'handled', '2026-06-02T00:00:00Z', '2026-06-01T00:00:00Z'),
  ('865-unknown-old', 'd@example.test', 'd@example.test', 'Re: D', '2026-11-09T23:59:59Z', 'no_token', false,
   'pending', null, '2026-11-09T23:59:59Z'),
  ('865-unknown-edge', 'e@example.test', 'e@example.test', 'Re: E', '2026-11-10T00:00:00Z', 'no_token', false,
   'pending', null, '2026-11-10T00:00:00Z'),
  ('865-unknown-recent', 'f@example.test', 'f@example.test', 'Re: F', '2026-11-25T00:00:00Z', 'no_token', false,
   'pending', null, '2026-11-25T00:00:00Z'),
  ('865-unknown-handled-old', 'g@example.test', 'g@example.test', 'Re: G', '2026-10-01T00:00:00Z', 'unknown_case', false,
   'handled', '2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z');

set local role anon;
select throws_ok(
  $$select count(*) from public.information_agent_unrouted_messages$$,
  '42501', null, 'anon cannot read the table'
);
reset role;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c8650000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select count(*) from public.information_agent_unrouted_messages$$,
  '42501', null, 'an ordinary signed-in account cannot read the table'
);
select throws_ok(
  $$insert into public.information_agent_unrouted_messages (provider_email_id, received_at, reason)
    values ('865-by-user', now(), 'no_token')$$,
  '42501', null, 'a signed-in account cannot write'
);
reset role;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c8650000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$select count(*) from public.information_agent_unrouted_messages$$,
  '42501', null, 'even an administrator has no direct access (the admin routes read with service_role)'
);
select throws_ok(
  $$update public.information_agent_unrouted_messages set status = 'handled', handled_at = now()$$,
  '42501', null, 'an administrator cannot update the table directly either'
);
reset role;
set local "request.jwt.claims" = '';

-- La purge ---------------------------------------------------------------------------------------------------------

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.purge_information_agent_unrouted_messages(timestamptz)'::regprocedure
  ),
  'the purge is security definer, with an empty search_path, and reserved to service_role'
);

select ok(
  app_private.information_agent_unrouted_known_retention() = interval '12 months'
  and app_private.information_agent_unrouted_unknown_retention() = interval '21 days',
  'the durations are 12 months (known sender) and 21 days (unknown sender), each in its own function'
);

select ok(
  (
    select bool_and(position(purge in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0)
    from unnest(array[
      'purge_information_agent_unrouted_messages',
      'purge_expired_operational_data', 'purge_information_agent_data', 'purge_offer_opening_notifications',
      'purge_sale_unlocks', 'purge_account_product_events', 'purge_followed_sale_snapshots',
      'purge_sale_reminder_dispatches', 'purge_sale_signal_feedback', 'purge_weekly_digest_dispatches',
      'purge_sale_result_dispatches', 'purge_market_estimate_snapshots', 'purge_licitor_captures',
      'purge_trial_extension_notes', 'purge_manual_grant_notes', 'purge_llm_analysis_cache', 'purge_errors'
    ]) as purge
  ),
  'run_data_retention runs the new purge and keeps its fifteen others and purge_errors'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.run_data_retention(timestamptz)'::regprocedure
  ),
  'run_data_retention stays security definer, search_path empty and service-only'
);

select is(
  (app_private.purge_information_agent_unrouted_messages('2026-11-09T00:00:00Z'::timestamptz)
    ->> 'information_agent_unrouted_messages')::integer,
  1,
  'at an earlier instant only the handled unknown message past 21 days is purged'
);

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)
    ->> 'information_agent_unrouted_messages')::integer,
  2,
  'the retention report counts the known message past 12 months and the unknown one past 21 days'
);

select is(
  (select array_agg(provider_email_id order by provider_email_id)
   from public.information_agent_unrouted_messages where provider_email_id like '865-%'),
  array['865-known-edge', '865-known-recent', '865-unknown-edge', '865-unknown-recent'],
  'the exact boundaries and the recent messages are kept, handled or not'
);

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ? 'purge_errors'),
  false,
  'a healthy run reports no purge error'
);

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)
    ->> 'information_agent_unrouted_messages')::integer,
  0,
  'a second run finds nothing more to purge (idempotent)'
);

select * from finish();
rollback;
