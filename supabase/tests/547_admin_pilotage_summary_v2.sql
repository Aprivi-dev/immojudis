-- Page admin « Pilotage », version 2 (migration 20261029120200) : comptes distincts à côté des
-- occurrences, semaine courante contre semaine précédente (fenêtres disjointes), inscriptions
-- confirmées, comptes actifs nouveaux et revenus, administrateurs exclus, plafond quotidien d'un compte
-- distingué de celui d'une adresse, dossiers, rappels, offre de lancement. Les chiffres sont comparés
-- à un relevé pris avant les données de test (écarts), pour ne pas dépendre de ce que la base contient.
--
-- « Maintenant » vaut le 2026-11-10 12:00 UTC : la fenêtre courante de 7 jours est
-- (2026-11-03 12:00, 2026-11-10 12:00], la précédente (2026-10-27 12:00, 2026-11-03 12:00], celle de 30
-- jours commence le 2026-10-11 12:00.
begin;

select plan(31);

-- Structure et droits ------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE'),
  'the summary is still for the server (service role) only'
);
select ok(
  not has_function_privilege('anon', 'app_private.admin_pilotage_period(timestamptz,timestamptz,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.admin_pilotage_period(timestamptz,timestamptz,timestamptz)', 'EXECUTE'),
  'the period reading is closed to the browser roles'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_pilotage_summary(timestamptz)'::regprocedure),
  true,
  'the summary is stable, security definer and has an empty search_path'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p
    where p.oid = 'app_private.admin_pilotage_period(timestamptz,timestamptz,timestamptz)'::regprocedure),
  true,
  'the period reading is stable, security definer and has an empty search_path'
);

set local role anon;
select throws_ok(
  $$select public.admin_pilotage_summary()$$, '42501', null, 'anon cannot read the summary'
);
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c5470000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.admin_pilotage_summary()$$, '42501', null, 'a signed-in account cannot read the summary'
);
reset role;
set local "request.jwt.claims" = '';

-- Relevé avant les données de test ---------------------------------------------------------------------
update app_private.account_product_events_measure set started_at = '2026-10-20T00:00:00Z';
update app_private.launch_offer set active = true;

create temporary table pgtap_547_summary (
  case_name text primary key,
  summary jsonb
) on commit drop;

insert into pgtap_547_summary
select 'before', public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz);

-- Données de test --------------------------------------------------------------------------------------
--   1 créé le 09/11, confirmé, connecté le 09/11     : inscription et compte actif nouveau (semaine courante)
--   2 créé le 08/11, adresse non confirmée           : inscription non confirmée
--   3 créé le 01/09, confirmé, connecté le 07/11     : compte actif revenu
--   4 créé le 30/10, confirmé, connecté le 31/10     : inscription et compte actif (semaine précédente)
--   5 administrateur, créé et connecté le 09/11      : compté nulle part
--   6 abonné Analyse, connecté le 05/09              : compte, mais pas « sous l'offre de lancement »
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5470000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot2-one@example.test', '', '2026-11-09T10:00:00Z',
   '2026-11-09T10:00:00Z', now(), '2026-11-09T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5470000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot2-two@example.test', '', null,
   '2026-11-08T10:00:00Z', now(), null, '{}'::jsonb, '{}'::jsonb),
  ('c5470000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot2-three@example.test', '', '2026-09-01T10:00:00Z',
   '2026-09-01T10:00:00Z', now(), '2026-11-07T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5470000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot2-four@example.test', '', '2026-10-30T10:00:00Z',
   '2026-10-30T10:00:00Z', now(), '2026-10-31T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5470000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot2-admin@example.test', '', '2026-11-09T10:00:00Z',
   '2026-11-09T10:00:00Z', now(), '2026-11-09T10:00:00Z', '{}'::jsonb, '{}'::jsonb),
  ('c5470000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot2-paid@example.test', '', '2026-09-01T10:00:00Z',
   '2026-09-01T10:00:00Z', now(), '2026-09-05T10:00:00Z', '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c5470000-0000-4000-8000-000000000005';

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c5470000-0000-4000-8000-000000000006', 'analyse', 'active', now() + interval '30 days');

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c5470000-1000-4000-8000-000000000001', 'pilotage2-test',
   'https://example.test/pilotage2/1', 'Pilotage 2 sale one', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c5470000-1000-4000-8000-000000000002', 'pilotage2-test',
   'https://example.test/pilotage2/2', 'Pilotage 2 sale two', 'upcoming', '2099-01-02 12:00:00Z');

-- Alertes : une dans chaque semaine, une d'un administrateur.
insert into public.user_alerts (id, user_id, name, alert_frequency, created_at)
values
  ('c5470000-2000-4000-8000-000000000001', 'c5470000-0000-4000-8000-000000000001',
   'Pilot 2 alert one', 'weekly', '2026-11-08T10:00:00Z'),
  ('c5470000-2000-4000-8000-000000000002', 'c5470000-0000-4000-8000-000000000004',
   'Pilot 2 alert two', 'weekly', '2026-10-30T10:00:00Z'),
  ('c5470000-2000-4000-8000-000000000003', 'c5470000-0000-4000-8000-000000000005',
   'Pilot 2 alert admin', 'weekly', '2026-11-08T10:00:00Z');

-- Liste d'attente : un compte et l'administrateur.
insert into public.offer_opening_notifications (
  user_id, consent_text_version, consented_at, notify_enabled, revoked_at
) values
  ('c5470000-0000-4000-8000-000000000001', 'v-test', '2026-11-09T10:00:00Z', true, null),
  ('c5470000-0000-4000-8000-000000000005', 'v-test', '2026-11-09T10:00:00Z', true, null);

-- Dossiers : le déclencheur pose les dates à maintenant ; on le coupe pour fixer les dates de test.
alter table public.user_favorites disable trigger touch_favorite_dossier;
insert into public.user_favorites (
  user_id, sale_id, personal_status, personal_status_updated_at, bid_ceiling_eur, bid_ceiling_saved_at
) values
  ('c5470000-0000-4000-8000-000000000001', 'c5470000-1000-4000-8000-000000000001',
   'watching', '2026-11-09T10:00:00Z', null, null),
  ('c5470000-0000-4000-8000-000000000001', 'c5470000-1000-4000-8000-000000000002',
   null, null, 150000, '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'c5470000-1000-4000-8000-000000000001',
   'bidding', '2026-11-08T10:00:00Z', null, null),
  ('c5470000-0000-4000-8000-000000000004', 'c5470000-1000-4000-8000-000000000001',
   'reviewing', '2026-10-30T10:00:00Z', null, null),
  ('c5470000-0000-4000-8000-000000000005', 'c5470000-1000-4000-8000-000000000001',
   'won', '2026-11-09T10:00:00Z', null, null),
  -- Un favori sans statut ni plafond n'est pas un dossier.
  ('c5470000-0000-4000-8000-000000000002', 'c5470000-1000-4000-8000-000000000001',
   null, null, null, null);
alter table public.user_favorites enable trigger touch_favorite_dossier;

-- Rappels : consentements actifs et rappels envoyés (un échec ne compte pas).
insert into public.user_notification_preferences (
  user_id, sale_reminders_enabled, sale_reminders_consented_at
) values
  ('c5470000-0000-4000-8000-000000000001', true, '2026-11-01T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', true, '2026-11-01T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000005', true, '2026-11-01T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000002', false, null);

insert into public.sale_reminder_dispatches (
  user_id, sale_id, reminder_kind, dedupe_key, mode, status, sent_at
) values
  ('c5470000-0000-4000-8000-000000000001', 'c5470000-1000-4000-8000-000000000001',
   'audience_j7', '2099-01-01', 'on', 'sent', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'c5470000-1000-4000-8000-000000000001',
   'audience_j1', '2099-01-01', 'on', 'sent', '2026-11-09T11:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'c5470000-1000-4000-8000-000000000001',
   'audience_j7', '2099-01-01', 'on', 'sent', '2026-11-08T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000004', 'c5470000-1000-4000-8000-000000000001',
   'audience_j7', '2099-01-01', 'on', 'sent', '2026-10-30T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'c5470000-1000-4000-8000-000000000002',
   'audience_j7', '2099-01-02', 'on', 'failed', null),
  ('c5470000-0000-4000-8000-000000000005', 'c5470000-1000-4000-8000-000000000001',
   'date_changed', 'fingerprint-admin', 'internal', 'sent', '2026-11-09T10:00:00Z');

-- Événements. Semaine courante : les comptes 1 et 3 ; semaine précédente : le compte 4 ; le compte 5
-- est administrateur. Le compte 1 déclenche aussi l'ancien détail « daily » (lignes d'avant la
-- distinction) et le détail « daily_account » ; le compte 3, « daily_account » et « daily_shared ».
insert into public.account_product_events (user_id, event_type, detail, sale_id, occurred_at)
values
  ('c5470000-0000-4000-8000-000000000001', 'sale_unlocked', null, 'c5470000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'sale_unlocked', null, 'c5470000-1000-4000-8000-000000000002', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'sale_unlocked', null, 'c5470000-1000-4000-8000-000000000001', '2026-11-08T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000004', 'sale_unlocked', null, 'c5470000-1000-4000-8000-000000000001', '2026-10-30T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000005', 'sale_unlocked', null, 'c5470000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'quota_reached', 'unlocks', null, '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'quota_reached', 'daily_account', null, '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'quota_reached', 'daily', null, '2026-11-07T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'quota_reached', 'daily_account', null, '2026-11-08T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'quota_reached', 'daily_shared', null, '2026-11-08T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000004', 'quota_reached', 'daily_shared', null, '2026-10-30T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000005', 'quota_reached', 'daily_account', null, '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c5470000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c5470000-1000-4000-8000-000000000002', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'bid_ceiling_calculated', null, 'c5470000-1000-4000-8000-000000000001', '2026-11-08T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'calendar_exported', null, 'c5470000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'email_clicked', 'alert', 'c5470000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000003', 'email_clicked', 'alert', 'c5470000-1000-4000-8000-000000000001', '2026-11-08T10:00:00Z'),
  ('c5470000-0000-4000-8000-000000000001', 'email_clicked', 'reminder', 'c5470000-1000-4000-8000-000000000001', '2026-11-09T10:00:00Z');

insert into pgtap_547_summary
select 'after', public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz);

-- Écart entre le relevé après et avant les données de test, pour un chiffre d'un chemin.
create function pg_temp.delta(p_path text[]) returns integer
language sql stable as $$
  select ((select summary from pgtap_547_summary where case_name = 'after') #>> p_path)::integer
       - ((select summary from pgtap_547_summary where case_name = 'before') #>> p_path)::integer;
$$;

-- Comptes : semaine courante, semaine précédente, 30 jours ----------------------------------------------------
select is(
  array[
    pg_temp.delta('{windows,0,signups}'),
    pg_temp.delta('{windows,0,signups_confirmed}'),
    pg_temp.delta('{windows,0,active_accounts}'),
    pg_temp.delta('{windows,0,active_new}'),
    pg_temp.delta('{windows,0,active_returning}')
  ],
  array[2, 1, 2, 1, 1],
  'current week: two accounts created (one confirmed), two active (one new, one returning), the administrator apart'
);
select is(
  array[
    pg_temp.delta('{windows,0,previous,signups}'),
    pg_temp.delta('{windows,0,previous,signups_confirmed}'),
    pg_temp.delta('{windows,0,previous,active_accounts}'),
    pg_temp.delta('{windows,0,previous,active_new}'),
    pg_temp.delta('{windows,0,previous,active_returning}')
  ],
  array[1, 1, 1, 1, 0],
  'previous week: one account created and confirmed, one active and new'
);
select is(
  array[
    pg_temp.delta('{windows,1,signups}'),
    pg_temp.delta('{windows,1,signups_confirmed}'),
    pg_temp.delta('{windows,1,active_accounts}'),
    pg_temp.delta('{windows,1,active_new}'),
    pg_temp.delta('{windows,1,active_returning}')
  ],
  array[3, 2, 3, 2, 1],
  '30 days: both weeks together'
);
select is(
  (select summary #> '{windows,1,previous}' from pgtap_547_summary where case_name = 'after'),
  'null'::jsonb,
  'only the 7-day window carries a previous window'
);
select is(
  (select summary #>> '{windows,0,previous,until}' = summary #>> '{windows,0,since}'
     and summary #>> '{windows,0,previous,since}' <> summary #>> '{windows,0,since}'
     from pgtap_547_summary where case_name = 'after'),
  true,
  'the previous week ends where the current week starts: the windows do not overlap'
);

-- Alertes, liste d'attente, dossiers, rappels ------------------------------------------------------------------
select is(
  array[
    pg_temp.delta('{windows,0,alerts_created}'),
    pg_temp.delta('{windows,0,previous,alerts_created}'),
    pg_temp.delta('{windows,1,alerts_created}')
  ],
  array[1, 1, 2],
  'alerts: one per week, none from the administrator'
);
select is(
  array[
    pg_temp.delta('{windows,0,waitlist_requests}'),
    pg_temp.delta('{waitlist_active}')
  ],
  array[1, 1],
  'waiting list: the administrator is not counted'
);
select is(
  array[
    pg_temp.delta('{windows,0,dossiers}'),
    pg_temp.delta('{windows,0,dossier_accounts}'),
    pg_temp.delta('{windows,0,previous,dossiers}'),
    pg_temp.delta('{windows,0,previous,dossier_accounts}'),
    pg_temp.delta('{windows,1,dossiers}'),
    pg_temp.delta('{windows,1,dossier_accounts}')
  ],
  array[3, 2, 1, 1, 4, 3],
  'dossiers: a status or a ceiling saved in the window, and the distinct accounts behind them'
);
select is(
  array[
    pg_temp.delta('{windows,0,reminders_sent}'),
    pg_temp.delta('{windows,0,reminder_accounts}'),
    pg_temp.delta('{windows,0,previous,reminders_sent}'),
    pg_temp.delta('{windows,0,previous,reminder_accounts}')
  ],
  array[3, 2, 1, 1],
  'reminders sent: only the sent ones, and the distinct accounts reached'
);

-- Événements : occurrences et comptes distincts -------------------------------------------------------------------
select is(
  array[
    pg_temp.delta('{windows,0,events,unlocks}'),
    pg_temp.delta('{windows,0,events,accounts,unlocks}'),
    pg_temp.delta('{windows,0,events,bid_ceilings}'),
    pg_temp.delta('{windows,0,events,accounts,bid_ceilings}'),
    pg_temp.delta('{windows,0,events,calendar_exports}'),
    pg_temp.delta('{windows,0,events,accounts,calendar_exports}')
  ],
  array[3, 2, 3, 2, 1, 1],
  'current week: occurrences and distinct accounts side by side (three unlocks by two accounts)'
);
select is(
  array[
    pg_temp.delta('{windows,0,events,quota_reached,total}'),
    pg_temp.delta('{windows,0,events,accounts,quota_reached,total}'),
    pg_temp.delta('{windows,0,events,quota_reached,unlocks}'),
    pg_temp.delta('{windows,0,events,accounts,quota_reached,unlocks}'),
    pg_temp.delta('{windows,0,events,quota_reached,favorites}')
  ],
  array[5, 2, 1, 1, 0],
  'current week: five quotas reached by two accounts, one of them the unlock quota'
);
select is(
  array[
    pg_temp.delta('{windows,0,events,quota_reached,daily}'),
    pg_temp.delta('{windows,0,events,accounts,quota_reached,daily}'),
    pg_temp.delta('{windows,0,events,quota_reached,daily_account}'),
    pg_temp.delta('{windows,0,events,accounts,quota_reached,daily_account}'),
    pg_temp.delta('{windows,0,events,quota_reached,daily_shared}'),
    pg_temp.delta('{windows,0,events,accounts,quota_reached,daily_shared}')
  ],
  array[4, 2, 2, 2, 1, 1],
  'the daily cap is split: per account, per address or whole site, and the former undistinguished detail'
);
select is(
  array[
    pg_temp.delta('{windows,0,events,email_clicks,total}'),
    pg_temp.delta('{windows,0,events,accounts,email_clicks,total}'),
    pg_temp.delta('{windows,0,events,email_clicks,alert}'),
    pg_temp.delta('{windows,0,events,accounts,email_clicks,alert}'),
    pg_temp.delta('{windows,0,events,email_clicks,reminder}'),
    pg_temp.delta('{windows,0,events,accounts,email_clicks,reminder}')
  ],
  array[3, 2, 2, 2, 1, 1],
  'current week: three email clicks, two accounts, one reminder click'
);
select is(
  array[
    pg_temp.delta('{windows,0,previous,events,unlocks}'),
    pg_temp.delta('{windows,0,previous,events,accounts,unlocks}'),
    pg_temp.delta('{windows,0,previous,events,quota_reached,total}'),
    pg_temp.delta('{windows,0,previous,events,quota_reached,daily_shared}')
  ],
  array[1, 1, 1, 1],
  'previous week: its own events, none of the current week'
);
select is(
  array[
    pg_temp.delta('{windows,1,events,unlocks}'),
    pg_temp.delta('{windows,1,events,accounts,unlocks}')
  ],
  array[4, 3],
  '30 days: four unlocks by three accounts'
);
select is(
  (select array[
      summary #>> '{windows,0,events_complete}',
      summary #>> '{windows,0,previous,events_complete}',
      summary #>> '{windows,1,events_complete}'
    ] from pgtap_547_summary where case_name = 'after'),
  array['true', 'true', 'false'],
  'the measure starts on 20/10: both weeks are complete, the 30-day window is partial'
);

-- État à cet instant ----------------------------------------------------------------------------------------------
select is(
  array[
    pg_temp.delta('{snapshot,accounts_total}'),
    pg_temp.delta('{snapshot,accounts_confirmed}')
  ],
  array[5, 4],
  'accounts: five without the administrator, four of them confirmed'
);
select is(
  (select summary #>> '{snapshot,launch_offer_active}' from pgtap_547_summary where case_name = 'after')
  || ':' || pg_temp.delta('{snapshot,launch_offer_accounts}')::text,
  'true:3',
  'under the launch offer: confirmed accounts without paid access, not the unconfirmed one, the subscriber or the administrator'
);
select is(
  pg_temp.delta('{snapshot,reminder_consents_active}'),
  2,
  'active reminder consents, without the administrator'
);
select is(
  array[
    pg_temp.delta('{snapshot,dossiers_total}'),
    pg_temp.delta('{snapshot,dossier_accounts_total}')
  ],
  array[4, 3],
  'dossiers saved in all: a favorite with neither status nor ceiling is not one'
);

update app_private.launch_offer set active = false;
select is(
  (public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{snapshot,launch_offer_active}')
  || ':' || (public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{snapshot,launch_offer_accounts}'),
  'false:0',
  'with the offer cut, nobody is under it'
);

-- Forme : des nombres et des dates, aucune personne ---------------------------------------------------------------
select is(
  (select array_agg(key order by key) from jsonb_object_keys(
     (select summary from pgtap_547_summary where case_name = 'after')) as key),
  array['events_measured_since', 'generated_at', 'snapshot', 'waitlist_active', 'windows'],
  'the summary has its four former top-level fields and the snapshot'
);
select ok(
  (select summary::text !~* '(@|user_id|example\.test)' from pgtap_547_summary where case_name = 'after'),
  'the summary carries no address and no account identifier'
);
select is(
  (select jsonb_array_length(summary -> 'windows') from pgtap_547_summary where case_name = 'after'),
  2,
  'two windows are returned'
);

delete from app_private.account_product_events_measure;
select is(
  (select array[
      public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{windows,0,events}',
      public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{windows,0,previous,events}',
      public.admin_pilotage_summary('2026-11-10T12:00:00Z'::timestamptz) #>> '{windows,1,events}'
    ]),
  array[null, null, null]::text[],
  'without a start of measure, the events are null (non mesuré) in every window, never zero'
);

select * from finish();
rollback;
