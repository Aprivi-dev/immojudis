-- Rétention des ventes « past » et « quarantined » (20261029100200) : ces statuts reçoivent une échéance
-- après l'audience même avec un conflit de sources sur la date ou une fenêtre de vente en ligne illisible,
-- sans changer la règle des ventes à venir ni celle des ventes reportées ; la purge les supprime ; le
-- journal des rappels est purgé par run_data_retention, comme partie isolée.
begin;

select plan(23);

-- Fonction de garde (retention_deadline) -------------------------------------------------------------------
select is(
  app_private.sale_retention_deadline(
    '2000-01-01 12:00Z', 'past', '{}', '{"source_conflicts":[{"field":"sale_date"}]}'
  ),
  '2000-01-02 12:00Z'::timestamptz,
  'a past sale with a date conflict gets its hearing date + 24 h'
);
select is(
  app_private.sale_retention_deadline(
    '2000-01-01 12:00Z', 'quarantined', '{}', '{"source_conflicts":[{"field":"sale_date"}]}'
  ),
  '2000-01-02 12:00Z'::timestamptz,
  'a quarantined sale with a date conflict gets its hearing date + 24 h'
);
select is(
  app_private.sale_retention_deadline(
    '2000-01-01 12:00Z', 'upcoming', '{}', '{"source_conflicts":[{"field":"sale_date"}]}'
  ),
  null::timestamptz,
  'an upcoming sale with a date conflict is still retained for investigation'
);
select is(
  app_private.sale_retention_deadline(
    '2000-01-01 12:00Z', 'quarantined', '{"sale_window":{"opens_at":"bad","closes_at":"bad"}}', '{}'
  ),
  '2000-01-02 12:00Z'::timestamptz,
  'a quarantined sale with an unreadable online window falls back to its hearing date'
);
select is(
  app_private.sale_retention_deadline(
    '2000-01-01 12:00Z', 'past',
    '{"sale_window":{"opens_at":"2000-01-05T12:00:00Z","closes_at":"2000-01-01T12:00:00Z"}}', '{}'
  ),
  '2000-01-02 12:00Z'::timestamptz,
  'and so does a past sale whose window closes before it opens'
);
select is(
  app_private.sale_retention_deadline(
    '2000-01-01 12:00Z', 'upcoming', '{"sale_window":{"opens_at":"bad","closes_at":"bad"}}', '{}'
  ),
  null::timestamptz,
  'an upcoming sale with an unreadable window is still retained'
);
select is(
  app_private.sale_retention_deadline(
    '2000-01-01 12:00Z', 'past',
    '{"sale_window":{"opens_at":"2000-01-01T12:00:00Z","closes_at":"2000-01-05T12:00:00Z"}}', '{}'
  ),
  '2000-01-06 12:00Z'::timestamptz,
  'a readable online window still takes precedence (closing date + 24 h)'
);
select is(
  app_private.sale_retention_deadline('2000-01-01', 'past', '{}', '{"status":"Vente reportée"}'),
  null::timestamptz,
  'a source postponement is still retained, whatever the status'
);
select is(
  app_private.sale_retention_deadline(null, 'quarantined', '{}', '{}'),
  null::timestamptz,
  'without a hearing date nothing can be derived'
);

-- Date limite exacte du catalogue (catalogue_expiry_deadline) -----------------------------------------------
select is(
  app_private.sale_catalogue_retention_deadline(
    '2000-01-01 12:00Z', 'quarantined', '{}', '{"source_conflicts":[{"field":"sale_date"}]}'
  ),
  '2000-01-01 12:00Z'::timestamptz,
  'a quarantined sale with a date conflict expires at its exact catalogue cutoff'
);
select is(
  app_private.sale_catalogue_retention_deadline(
    '2000-01-01 12:00Z', 'upcoming', '{}', '{"source_conflicts":[{"field":"sale_date"}]}'
  ),
  null::timestamptz,
  'an upcoming sale with a date conflict is still retained'
);
select is(
  app_private.sale_catalogue_retention_deadline(
    '2000-01-01 12:00Z', 'past', '{"sale_window":{"opens_at":"bad","closes_at":"bad"}}', '{}'
  ),
  '2000-01-01 12:00Z'::timestamptz,
  'a past sale with an unreadable online window falls back to its hearing date'
);
select is(
  app_private.sale_catalogue_retention_deadline(
    '2000-01-01 12:00Z', 'upcoming', '{"sale_window":{"opens_at":"bad","closes_at":"bad"}}', '{}'
  ),
  null::timestamptz,
  'an upcoming sale with an unreadable window is still retained'
);
select is(
  app_private.sale_catalogue_retention_deadline('2000-01-01', 'quarantined', '{}', '{"status":"reportée"}'),
  null::timestamptz,
  'a postponed sale keeps its dedicated purge fallback, no deadline here'
);

-- Colonnes matérialisées et purge ------------------------------------------------------------------------------
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, raw_payload, sale_procedure
) values
  ('c5320000-1000-4000-8000-000000000001', 'retention-532', 'https://example.test/r532/1',
   'Quarantined with conflict', 'quarantined', '2000-01-02 12:00:00Z',
   '{"source_conflicts":[{"field":"sale_date"}]}', '{}'),
  ('c5320000-1000-4000-8000-000000000002', 'retention-532', 'https://example.test/r532/2',
   'Past with unreadable window', 'past', '2000-01-02 12:00:00Z', '{}',
   '{"sale_window":{"opens_at":"bad","closes_at":"bad"}}'),
  ('c5320000-1000-4000-8000-000000000003', 'retention-532', 'https://example.test/r532/3',
   'Upcoming with conflict', 'upcoming', '2000-01-02 12:00:00Z',
   '{"source_conflicts":[{"field":"sale_date"}]}', '{}');

select is(
  (select array_agg(retention_deadline is not null and catalogue_expiry_deadline is not null order by id)
     from public.auction_sales where source_name = 'retention-532'),
  array[true, true, false],
  'the write triggers give a deadline to the quarantined and past sales, not to the upcoming one with a conflict'
);

select count(*) from public.bridge_auction_sales_to_outcome_graph();
set local role service_role;
select lives_ok(
  $sql$do $loop$
    begin
      for i in 1..4 loop
        perform public.purge_expired_auction_sales('2000-01-02 12:00Z', 25);
      end loop;
    end
  $loop$$sql$,
  'the catalogue retention runs'
);
reset role;
select is(
  (select array_agg(id order by id) from public.auction_sales where source_name = 'retention-532'),
  array['c5320000-1000-4000-8000-000000000003']::uuid[],
  'the quarantined sale and the past sale are purged, the upcoming one with a conflict is kept'
);

-- Journal des rappels : partie isolée de run_data_retention -----------------------------------------------------------
select ok(
  position('purge_sale_reminder_dispatches' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_followed_sale_snapshots' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_account_product_events' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_sale_unlocks' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_errors' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0,
  'run_data_retention runs the reminder log purge next to the six others and keeps purge_errors'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  'c5320000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'retention-532@example.test', '', now(), now(), now(),
  '{}'::jsonb, '{}'::jsonb
);
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values ('c5320000-1000-4000-8000-000000000009', 'retention-532', 'https://example.test/r532/9',
        'Future sale', 'upcoming', '2099-01-01 12:00:00Z');
insert into public.sale_reminder_dispatches (
  user_id, sale_id, reminder_kind, dedupe_key, mode, status, created_at
) values
  ('c5320000-0000-4000-8000-000000000001', 'c5320000-1000-4000-8000-000000000009',
   'status_changed', 'old-532', 'on', 'sent', now() - interval '200 days'),
  ('c5320000-0000-4000-8000-000000000001', 'c5320000-1000-4000-8000-000000000009',
   'status_changed', 'recent-532', 'on', 'sent', now() - interval '2 days');

set local role service_role;
select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'sale_reminder_dispatches')::integer,
  1,
  'the retention report names the reminder log purge and counts the row older than 180 days'
);
reset role;
select is(
  (select array_agg(dedupe_key order by dedupe_key) from public.sale_reminder_dispatches
    where user_id = 'c5320000-0000-4000-8000-000000000001'),
  array['recent-532'],
  'the retention run purged the reminder rows older than 180 days and kept the recent one'
);
select is(
  (select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ? 'purge_errors'),
  false,
  'a healthy run reports no purge error'
);

-- Une partie qui échoue n'arrête pas les autres.
create or replace function public.purge_sale_reminder_dispatches(
  p_older_than interval default interval '180 days'
)
returns integer
language plpgsql
as $$
begin
  raise exception 'forced failure of the reminder log purge' using errcode = 'P0001';
end;
$$;
select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'purge_errors',
  '{"purge_sale_reminder_dispatches": "P0001"}'::jsonb,
  'a failing reminder log purge is reported under purge_errors with its SQLSTATE'
);
select ok(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'account_product_events'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'user_followed_sale_snapshots',
  'and the other purges still ran and reported'
);

select * from finish();
rollback;
