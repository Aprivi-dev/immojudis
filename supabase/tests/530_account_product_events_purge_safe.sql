-- Purge des ventes et mesure (20261029100000) : deux événements du même compte, du même type et du même
-- jour sur deux ventes ne bloquent plus la purge du catalogue (la mise à null de la clé étrangère ne
-- collisionne plus), la mesure garde ses lignes détachées, record_account_product_event reste arbitré
-- par la base, et la capture d'instantané ne bloque jamais la purge ni ne copie le code postal.
begin;

select plan(23);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'purge-safe-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- Deux ventes dont l'audience est passée (purgées à l'instant de l'audience : 2000-01-02 12:00 UTC).
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c5300000-1000-4000-8000-000000000001', 'purge-safe-test',
   'https://example.test/purge-safe/a', 'Purge sale A', 'unknown', '2000-01-02 12:00:00Z'),
  ('c5300000-1000-4000-8000-000000000002', 'purge-safe-test',
   'https://example.test/purge-safe/b', 'Purge sale B', 'unknown', '2000-01-02 12:00:00Z');

-- Arbitres -----------------------------------------------------------------------------------------
select ok(
  to_regclass('public.account_product_events_once_per_day_idx') is null,
  'the old unique index (with the coalesce on the sale) is gone'
);
select ok(
  (select indisunique and indpred is not null
     from pg_index where indexrelid = 'public.account_product_events_once_per_day_sale_idx'::regclass)
  and (select indisunique and indpred is not null
     from pg_index where indexrelid = 'public.account_product_events_once_per_day_quota_idx'::regclass),
  'two partial unique indexes arbitrate the daily uniqueness'
);
select is(
  (select confdeltype from pg_constraint
    where conrelid = 'public.account_product_events'::regclass
      and contype = 'f'
      and confrelid = 'public.auction_sales'::regclass),
  'n'::"char",
  'a deleted sale still detaches its events (on delete set null): the measure keeps its rows'
);

-- Enregistrement ------------------------------------------------------------------------------------
set local role service_role;
select is(
  public.record_account_product_event(
    'c5300000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5300000-1000-4000-8000-000000000001'
  ),
  true,
  'an unlock on sale A is recorded'
);
select is(
  public.record_account_product_event(
    'c5300000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5300000-1000-4000-8000-000000000002'
  ),
  true,
  'the same type the same day on sale B is another event'
);
select is(
  public.record_account_product_event(
    'c5300000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5300000-1000-4000-8000-000000000001'
  ),
  false,
  'the same event on the same sale the same day is still recorded once'
);
select is(
  public.record_account_product_event('c5300000-0000-4000-8000-000000000001', 'quota_reached', 'daily'),
  true,
  'a quota reached is recorded without a sale'
);
select is(
  public.record_account_product_event('c5300000-0000-4000-8000-000000000001', 'quota_reached', 'daily'),
  false,
  'a quota reached counts once a day per account and quota'
);
select throws_ok(
  $$select public.record_account_product_event('c5300000-0000-4000-8000-000000000001', 'sale_unlocked')$$,
  '23514', null, 'a sale event without a sale is refused: no index would arbitrate it'
);
select throws_ok(
  $$select public.record_account_product_event('c5300000-0000-4000-8000-000000000001', 'email_clicked', 'alert')$$,
  '23514', null, 'an email click without a sale is refused too'
);
reset role;

-- Purge : deux événements du même jour sur deux ventes, suppression des deux ventes ----------------------
select count(*) from public.bridge_auction_sales_to_outcome_graph();
set local role service_role;
select lives_ok(
  $sql$do $loop$
    begin
      for i in 1..3 loop
        perform public.purge_expired_auction_sales('2000-01-02 12:00Z', 25);
      end loop;
    end
  $loop$$sql$,
  'the catalogue retention deletes both sales without being blocked by the measure'
);
reset role;
select is(
  (select count(*) from public.auction_sales
    where id in ('c5300000-1000-4000-8000-000000000001', 'c5300000-1000-4000-8000-000000000002')),
  0::bigint,
  'both sales are gone from the catalogue'
);
select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5300000-0000-4000-8000-000000000001'
      and event_type = 'sale_unlocked' and sale_id is null),
  2::bigint,
  'the two events are kept, detached from their sales'
);
select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5300000-0000-4000-8000-000000000001' and event_type = 'quota_reached'),
  1::bigint,
  'the quota event is untouched'
);

-- Une vente supprimée à la main avec des événements du même jour : même résultat --------------------------
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c5300000-1000-4000-8000-000000000003', 'purge-safe-test',
   'https://example.test/purge-safe/c', 'Purge sale C', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c5300000-1000-4000-8000-000000000004', 'purge-safe-test',
   'https://example.test/purge-safe/d', 'Purge sale D', 'upcoming', '2099-01-02 12:00:00Z');
set local role service_role;
select is(
  public.record_account_product_event(
    'c5300000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5300000-1000-4000-8000-000000000003'
  ),
  true,
  'a new unlock the same day on a new sale is recorded next to the detached ones'
);
select is(
  public.record_account_product_event(
    'c5300000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5300000-1000-4000-8000-000000000004'
  ),
  true,
  'and on a fourth sale'
);
reset role;
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales
     where id in ('c5300000-1000-4000-8000-000000000003', 'c5300000-1000-4000-8000-000000000004')$$,
  'deleting two more sales with same-day events succeeds'
);
select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5300000-0000-4000-8000-000000000001'
      and event_type = 'sale_unlocked' and sale_id is null),
  4::bigint,
  'four detached events share the same key and none was refused'
);

-- Capture d'instantané : jamais bloquante, sans code postal ---------------------------------------------
insert into public.auction_sales (
  id, source_name, source_url, title, city, postal_code, status, sale_date
) values
  ('c5300000-1000-4000-8000-000000000005', 'purge-safe-test',
   'https://example.test/purge-safe/e', 'Purge sale E', 'Bordeaux', '33000', 'unknown',
   '2000-01-02 12:00:00Z'),
  ('c5300000-1000-4000-8000-000000000006', 'purge-safe-test',
   'https://example.test/purge-safe/f', 'Purge sale F', 'Bordeaux', '33000', 'unknown',
   '2000-01-02 12:00:00Z');
insert into public.user_favorites (id, user_id, sale_id) values
  ('c5300000-2000-4000-8000-000000000005', 'c5300000-0000-4000-8000-000000000001',
   'c5300000-1000-4000-8000-000000000005'),
  ('c5300000-2000-4000-8000-000000000006', 'c5300000-0000-4000-8000-000000000001',
   'c5300000-1000-4000-8000-000000000006');
select count(*) from public.bridge_auction_sales_to_outcome_graph();

-- Une contrainte qui refuse toute capture simule une capture ratée.
alter table public.user_followed_sale_snapshots
  add constraint t530_force_capture_failure check (false) not valid;
select lives_ok(
  $$delete from public.auction_sales where id = 'c5300000-1000-4000-8000-000000000005'$$,
  'a failing snapshot capture does not block the deletion of the sale'
);
select is(
  (select count(*) from public.auction_sales where id = 'c5300000-1000-4000-8000-000000000005'),
  0::bigint,
  'the sale is deleted even though its capture failed'
);
select is(
  (select count(*) from public.user_followed_sale_snapshots
    where sale_id = 'c5300000-1000-4000-8000-000000000005'),
  0::bigint,
  'and no half-written snapshot remains'
);
alter table public.user_followed_sale_snapshots drop constraint t530_force_capture_failure;

delete from public.auction_sales where id = 'c5300000-1000-4000-8000-000000000006';
select is(
  (select count(*) from public.user_followed_sale_snapshots
    where sale_id = 'c5300000-1000-4000-8000-000000000006'
      and user_id = 'c5300000-0000-4000-8000-000000000001'),
  1::bigint,
  'a healthy capture still writes the snapshot'
);
select is(
  (select postal_code from public.user_followed_sale_snapshots
    where sale_id = 'c5300000-1000-4000-8000-000000000006'),
  null,
  'the postal code is no longer copied into the snapshot'
);

select * from finish();
rollback;
