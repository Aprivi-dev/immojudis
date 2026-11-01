-- 20261110210000 à 20261110210200 : journal central des emails envoyés et journal des consultations.
--   * public.email_send_log : table réservée à service_role (RLS activée, aucun droit ni politique pour anon ni
--     authenticated), contraintes, effacement avec le compte ;
--   * public.record_email_send : idempotent sur l'identifiant Resend, ne fait jamais reculer le statut ;
--   * public.record_email_delivery_event : statut monotone (complained > bounced > delivered > failed > delayed >
--     sent), évènement arrivé AVANT l'écriture de l'envoi, évènements ignorés (ouverture, clic) ;
--   * durée de conservation dans UNE fonction (90 jours) et purge isolée, dix-septième partie de
--     public.run_data_retention, qui garde ses seize autres purges ;
--   * public.admin_email_access_log : consultations (6 mois), dix-huitième partie de run_data_retention.
-- Les durées sont celles des migrations, validées par juridique-rgpd (90 jours) ou à confirmer (6 mois).
begin;

select plan(42);

-- Structure et droits -------------------------------------------------------------------------------------------

select has_table('public', 'email_send_log', 'the email send log exists');
select has_table('public', 'admin_email_access_log', 'the consultation log exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.email_send_log'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.admin_email_access_log'::regclass),
  'both tables have RLS enabled'
);

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('email_send_log', 'admin_email_access_log')),
  0::bigint,
  'no policy opens either table to the browser roles'
);

select ok(
  not has_table_privilege('anon', 'public.email_send_log', 'SELECT')
  and not has_table_privilege('anon', 'public.email_send_log', 'INSERT')
  and not has_table_privilege('authenticated', 'public.email_send_log', 'SELECT')
  and not has_table_privilege('authenticated', 'public.email_send_log', 'INSERT')
  and not has_table_privilege('authenticated', 'public.email_send_log', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.email_send_log', 'DELETE')
  and not has_table_privilege('anon', 'public.admin_email_access_log', 'SELECT')
  and not has_table_privilege('authenticated', 'public.admin_email_access_log', 'SELECT')
  and not has_table_privilege('authenticated', 'public.admin_email_access_log', 'INSERT'),
  'anon and signed-in accounts have no privilege on either table'
);

select ok(
  has_table_privilege('service_role', 'public.email_send_log', 'SELECT')
  and has_table_privilege('service_role', 'public.email_send_log', 'INSERT')
  and has_table_privilege('service_role', 'public.email_send_log', 'UPDATE')
  and has_table_privilege('service_role', 'public.email_send_log', 'DELETE')
  and has_table_privilege('service_role', 'public.admin_email_access_log', 'SELECT')
  and has_table_privilege('service_role', 'public.admin_email_access_log', 'INSERT'),
  'service_role reads and writes the tables'
);

select ok(
  (
    select bool_and(
      procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    )
    from pg_proc procedure_row
    where procedure_row.oid in (
      'public.record_email_send(text, text, text, text, text, text, text, uuid, uuid)'::regprocedure,
      'public.record_email_delivery_event(text, text, timestamptz, text, text, text, text, text)'::regprocedure,
      'app_private.purge_email_send_log(timestamptz)'::regprocedure,
      'app_private.purge_admin_email_access_log(timestamptz)'::regprocedure
    )
  ),
  'the two RPCs and the two purges are security definer, with an empty search_path, and reserved to service_role'
);

-- Contraintes ---------------------------------------------------------------------------------------------------

select throws_ok(
  $$insert into public.email_send_log (resend_email_id, status) values ('866-bad-status', 'opened')$$,
  '23514', null, 'an unknown status is refused'
);
select throws_ok(
  $$insert into public.email_send_log (resend_email_id, mode) values ('866-bad-mode', 'broadcast')$$,
  '23514', null, 'an unknown mode is refused'
);
select throws_ok(
  $$insert into public.email_send_log (resend_email_id, subject) values ('866-long', repeat('a', 301))$$,
  '23514', null, 'a subject over 300 characters is refused'
);
select throws_ok(
  $$insert into public.email_send_log (resend_email_id, to_address) values ('866-case', 'Majuscules@example.test')$$,
  '23514', null, 'an address that is not lowercase is refused'
);
select throws_ok(
  $$insert into public.admin_email_access_log (admin_user_id, scope) values (gen_random_uuid(), 'admin.email.edit')$$,
  '23514', null, 'an unknown consultation scope is refused'
);

-- Envoi : écriture idempotente --------------------------------------------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8660000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'send-log-user@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

select isnt(
  public.record_email_send(
    '866-first', 'alert', 'alert', 'on',
    'Immojudis <alertes@example.test>', ' Send-Log-User@Example.test ', 'Vos alertes',
    'c8660000-0000-4000-8000-000000000001'
  ),
  null,
  'record_email_send writes a row'
);

select is(
  (select to_address || '|' || status || '|' || template_key || '|' || category || '|' || mode
   from public.email_send_log where resend_email_id = '866-first'),
  'send-log-user@example.test|sent|alert|alert|on',
  'the address is lowercased and trimmed, the status starts at sent'
);

select is(
  public.record_email_delivery_event('866-first', 'email.delivered', '2026-12-01T10:00:00Z'),
  'delivered',
  'a delivered event advances the status'
);

select is(
  public.record_email_send(
    '866-first', 'alert', 'alert', 'on',
    'Immojudis <alertes@example.test>', 'send-log-user@example.test', 'Vos alertes',
    'c8660000-0000-4000-8000-000000000001'
  ) = (select id from public.email_send_log where resend_email_id = '866-first'),
  true,
  'a replayed send keeps the same row'
);

select is(
  (select count(*) from public.email_send_log where resend_email_id = '866-first'),
  1::bigint,
  'a replayed send creates no second row'
);

select is(
  (select status from public.email_send_log where resend_email_id = '866-first'),
  'delivered',
  'a replayed send never moves the status back'
);

-- Évènements : statut monotone ------------------------------------------------------------------------------------

select is(
  public.record_email_delivery_event('866-first', 'email.delivery_delayed', '2026-12-01T09:00:00Z'),
  'delivered',
  'a late delayed event does not move a delivered email back'
);

select is(
  public.record_email_delivery_event('866-first', 'email.bounced', '2026-12-01T11:00:00Z', null, null, null, 'Permanent'),
  'bounced',
  'a bounce moves a delivered email forward'
);

select is(
  public.record_email_delivery_event('866-first', 'email.delivered', '2026-12-01T12:00:00Z'),
  'bounced',
  'a later delivered event does not undo a bounce'
);

select is(
  public.record_email_delivery_event('866-first', 'email.complained', '2026-12-01T13:00:00Z'),
  'complained',
  'a complaint is the last word'
);

select is(
  (select bounce_type || '|' || last_event_at::text from public.email_send_log where resend_email_id = '866-first'),
  'permanent|2026-12-01 13:00:00+00',
  'the bounce type is kept and the last event instant is the latest one'
);

select is(
  public.record_email_delivery_event('866-first', 'email.opened', '2026-12-01T14:00:00Z'),
  null,
  'an opening event is ignored'
);
select is(
  public.record_email_delivery_event('866-first', 'email.clicked', '2026-12-01T14:00:00Z'),
  null,
  'a click event is ignored'
);

-- Évènement arrivé avant l'écriture de l'envoi ------------------------------------------------------------------------

select is(
  public.record_email_delivery_event(
    '866-early', 'email.delivered', '2026-12-01T10:00:00Z',
    'Immojudis <alertes@example.test>', 'Early@Example.test', 'Objet reçu du webhook'
  ),
  'delivered',
  'an event for an unknown email creates its row'
);

select is(
  (select template_key || '|' || to_address from public.email_send_log where resend_email_id = '866-early'),
  'unknown|early@example.test',
  'the row created by the event has an unknown template and a lowercased address'
);

select is(
  public.record_email_send(
    '866-early', 'weekly_digest', 'weekly', 'internal',
    'Immojudis <alertes@example.test>', 'early@example.test', 'Objet de l''envoi'
  ) is not null,
  true,
  'the send completes the row written by the event'
);

select is(
  (select template_key || '|' || mode || '|' || status || '|' || subject
   from public.email_send_log where resend_email_id = '866-early'),
  'weekly_digest|internal|delivered|Objet de l''envoi',
  'the send fills the template and keeps the status the event reached'
);

-- Effacement avec le compte ---------------------------------------------------------------------------------------------

delete from auth.users where id = 'c8660000-0000-4000-8000-000000000001';

select is(
  (select count(*) from public.email_send_log where resend_email_id = '866-first'),
  0::bigint,
  'the rows of an account leave with the account'
);

-- Conservation et purge --------------------------------------------------------------------------------------------------

select ok(
  app_private.email_send_log_retention() = interval '90 days'
  and app_private.email_send_log_retention('billing') = interval '90 days'
  and app_private.email_send_log_retention('acceptance') = interval '90 days'
  and app_private.admin_email_access_log_retention() = interval '6 months',
  'the durations are 90 days (every category) and 6 months, each in its own function'
);

-- Instant de la purge : 2026-12-01. 90 jours avant : 2026-09-02. La borne exacte est conservée.
insert into public.email_send_log (resend_email_id, category, created_at)
values
  ('866-old', 'alert', '2026-09-01T23:59:59Z'),
  ('866-old-billing', 'billing', '2026-09-01T23:59:59Z'),
  ('866-edge', 'alert', '2026-09-02T00:00:00Z'),
  ('866-recent', 'alert', '2026-11-25T00:00:00Z');

insert into public.admin_email_access_log (admin_user_id, occurred_at, scope, target_id)
values
  (gen_random_uuid(), '2026-05-31T23:59:59Z', 'admin.email.view', 'old'),
  (gen_random_uuid(), '2026-06-01T00:00:00Z', 'admin.email.view', 'edge'),
  (gen_random_uuid(), '2026-11-25T00:00:00Z', 'admin.email.list', null);

select ok(
  (
    select bool_and(position(purge in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0)
    from unnest(array[
      'purge_email_send_log', 'purge_admin_email_access_log',
      'purge_expired_operational_data', 'purge_information_agent_data', 'purge_offer_opening_notifications',
      'purge_sale_unlocks', 'purge_account_product_events', 'purge_followed_sale_snapshots',
      'purge_sale_reminder_dispatches', 'purge_sale_signal_feedback', 'purge_weekly_digest_dispatches',
      'purge_sale_result_dispatches', 'purge_market_estimate_snapshots', 'purge_licitor_captures',
      'purge_trial_extension_notes', 'purge_manual_grant_notes', 'purge_llm_analysis_cache',
      'purge_information_agent_unrouted_messages', 'purge_errors'
    ]) as purge
  ),
  'run_data_retention runs the two new purges and still calls the sixteen earlier ones and purge_errors'
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
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'email_send_log')::integer,
  2,
  'the retention report counts the rows past 90 days, whatever their category'
);

select is(
  (select array_agg(resend_email_id order by resend_email_id)
   from public.email_send_log where resend_email_id like '866-%'),
  array['866-early', '866-edge', '866-recent'],
  'the exact boundary and the recent rows are kept'
);

select is(
  (select array_agg(target_id order by target_id nulls last) from public.admin_email_access_log),
  array['edge', null]::text[],
  'a consultation older than 6 months is purged, the boundary and the recent ones are kept'
);

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ? 'purge_errors'),
  false,
  'a healthy run reports no purge error'
);

select ok(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'email_send_log')::integer = 0
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'admin_email_access_log')::integer = 0,
  'a second run finds nothing more to delete (idempotent)'
);

-- Liste des emails reçus (lot 4, 20261110210300) -----------------------------------------------------------------

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.admin_email_received_list(timestamptz, uuid, text, integer)'::regprocedure
  ),
  'the received-mail list is security definer, with an empty search_path, and reserved to service_role'
);

insert into public.information_agent_unrouted_messages (id, provider_email_id, sender_email, subject, received_at, reason, created_at)
values
  ('c8660000-0000-4000-8000-0000000000a1', '866-r1', 'maitre_a@cabinet.test', 'Un', '2026-11-01T10:00:00Z', 'no_token', '2026-11-01T10:00:00Z'),
  ('c8660000-0000-4000-8000-0000000000a2', '866-r2', 'maitreXa@cabinet.test', 'Deux', '2026-11-01T11:00:00Z', 'no_token', '2026-11-01T11:00:00Z'),
  ('c8660000-0000-4000-8000-0000000000a3', '866-r3', 'autre@cabinet.test', 'Trois', '2026-11-01T12:00:00Z', 'no_token', '2026-11-01T12:00:00Z');

select is(
  (select array_agg(subject order by created_at desc, id desc) from public.admin_email_received_list(null, null, null, 50)
   where subject in ('Un', 'Deux', 'Trois')),
  array['Trois', 'Deux', 'Un'],
  'received mail comes newest first'
);

select is(
  (select array_agg(subject order by subject) from public.admin_email_received_list(null, null, 'Maitre_A', 50)),
  array['Un'],
  'the address search is a lowercase prefix search in which _ is an ordinary character'
);

select is(
  (select array_agg(subject order by created_at desc) from public.admin_email_received_list('2026-11-01T12:00:00Z', 'c8660000-0000-4000-8000-0000000000a3', null, 50)
   where subject in ('Un', 'Deux', 'Trois')),
  array['Deux', 'Un'],
  'the (created_at, id) cursor returns only older rows'
);

select * from finish();
rollback;
