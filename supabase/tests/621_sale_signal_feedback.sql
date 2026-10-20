-- Retours « Utile » / « Pas pertinent » sur la bande d'écart au marché et sur les points à vérifier
-- (20261030110100) : table fermée aux rôles du navigateur, écriture par service_role seulement, listes
-- fermées (signal, valeur, motif), un retour par compte, vente, signal et jour (le motif corrige la ligne du
-- jour), plafond de 100 retours par compte et par jour, vente publique requise, disparition avec le compte, et
-- — point 20/10/2026 — la suppression d'une vente ne bloque pas, même quand deux retours du même compte et du
-- même jour sont détachés.
begin;

select plan(42);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c6210000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feedback-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c6210000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feedback-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c6210000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feedback-three@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- Ventes 1 et 2 : à venir (publiques). Vente 3 : passée (hors du catalogue public). Ventes 4 à 103 : à
-- venir, pour le plafond du jour.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c6210000-1000-4000-8000-000000000001', 'feedback-test',
   'https://example.test/feedback/1', 'Feedback sale one', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c6210000-1000-4000-8000-000000000002', 'feedback-test',
   'https://example.test/feedback/2', 'Feedback sale two', 'upcoming', '2099-01-02 12:00:00Z'),
  ('c6210000-1000-4000-8000-000000000003', 'feedback-test',
   'https://example.test/feedback/3', 'Feedback sale three', 'past', '2000-01-01 12:00:00Z');
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c6210000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'feedback-test', 'https://example.test/feedback/' || g, 'Feedback sale ' || g, 'upcoming',
  '2099-02-01 12:00:00Z'::timestamptz + g * interval '1 hour'
from generate_series(4, 103) as g;

-- Structure et droits ----------------------------------------------------------------------------
select has_table('public', 'sale_signal_feedback', 'the feedback table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sale_signal_feedback'::regclass),
  'row level security is enabled'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'sale_signal_feedback'),
  0::bigint,
  'there is no policy at all: nothing is readable through row level security'
);
select ok(
  not has_table_privilege('anon', 'public.sale_signal_feedback', 'SELECT')
  and not has_table_privilege('anon', 'public.sale_signal_feedback', 'INSERT')
  and not has_table_privilege('authenticated', 'public.sale_signal_feedback', 'SELECT')
  and not has_table_privilege('authenticated', 'public.sale_signal_feedback', 'INSERT')
  and not has_table_privilege('authenticated', 'public.sale_signal_feedback', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.sale_signal_feedback', 'DELETE'),
  'neither a visitor nor an account has any privilege on the table'
);
select ok(
  has_table_privilege('service_role', 'public.sale_signal_feedback', 'SELECT')
  and has_table_privilege('service_role', 'public.sale_signal_feedback', 'INSERT')
  and has_table_privilege('service_role', 'public.sale_signal_feedback', 'UPDATE')
  and has_table_privilege('service_role', 'public.sale_signal_feedback', 'DELETE'),
  'service_role reads, writes, corrects the day''s feedback and purges'
);
select is(
  (select array_agg(column_name::text order by ordinal_position)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'sale_signal_feedback'),
  array['id', 'user_id', 'sale_id', 'signal', 'value', 'reason', 'feedback_day', 'created_at'],
  'the table holds the account, the sale, the signal, the value, a closed reason and the day: no free column'
);
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.sale_signal_feedback'::regclass and contype = 'f'
      and confrelid = 'public.auction_sales'::regclass),
  'n',
  'the sale foreign key is on delete set null: the purge of sales is never blocked by it'
);
select is(
  (select confdeltype::text from pg_constraint
    where conrelid = 'public.sale_signal_feedback'::regclass and contype = 'f'
      and confrelid = 'auth.users'::regclass),
  'c',
  'the account foreign key cascades'
);
select ok(
  (select pg_get_indexdef(indexrelid) ~ 'UNIQUE' and pg_get_indexdef(indexrelid) ~ 'WHERE \(sale_id IS NOT NULL\)'
     from pg_index
    where indexrelid = 'public.sale_signal_feedback_once_per_day_idx'::regclass),
  'the once-a-day rule is a partial unique index on sale_id is not null (a detached row leaves it)'
);
select ok(
  not has_function_privilege('anon', 'public.record_sale_signal_feedback(uuid,uuid,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_sale_signal_feedback(uuid,uuid,text,text,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.record_sale_signal_feedback(uuid,uuid,text,text,text)', 'EXECUTE'),
  'the recording function is for the server (service role) only'
);
select is(
  (select not p.prosecdef and p.proconfig = array['search_path=""']
     from pg_proc p
    where p.oid = 'public.record_sale_signal_feedback(uuid,uuid,text,text,text)'::regprocedure),
  true,
  'the recording function is security invoker with an empty search_path'
);

-- Rôles du navigateur : ni lecture ni écriture -------------------------------------------------------
set local role anon;
select throws_ok(
  $$select count(*) from public.sale_signal_feedback$$,
  '42501', null, 'anon cannot read the feedback'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001', 'market_gap_band', 'useful')$$,
  '42501', null, 'anon cannot call the recording function'
);
reset role;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c6210000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select count(*) from public.sale_signal_feedback$$,
  '42501', null, 'an account cannot read the feedback, not even its own'
);
select throws_ok(
  $$insert into public.sale_signal_feedback (user_id, sale_id, signal, value) values ('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001', 'market_gap_band', 'useful')$$,
  '42501', null, 'an account cannot write feedback directly'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001', 'market_gap_band', 'useful')$$,
  '42501', null, 'an account cannot call the recording function (the server does, after checking the session)'
);
reset role;

-- Enregistrement : le serveur, les listes fermées, un retour par jour -------------------------------------
set local role service_role;

select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001',
    'market_gap_band', 'useful'
  ),
  true,
  'the server records a « useful » on the market gap band of a public sale'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001',
    'market_gap_band', 'not_relevant', 'estimate_too_high'
  ),
  true,
  'the same day, a second send (the reason) corrects the day''s feedback'
);
select is(
  (select array[value, reason] from public.sale_signal_feedback
    where user_id = 'c6210000-0000-4000-8000-000000000001'
      and sale_id = 'c6210000-1000-4000-8000-000000000001' and signal = 'market_gap_band'),
  array['not_relevant', 'estimate_too_high'],
  'the row now says « not_relevant » with its reason'
);
select is(
  (select count(*) from public.sale_signal_feedback
    where user_id = 'c6210000-0000-4000-8000-000000000001'
      and sale_id = 'c6210000-1000-4000-8000-000000000001' and signal = 'market_gap_band'),
  1::bigint,
  'one feedback at most per account, sale, signal and day'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001',
    'points_to_verify', 'useful'
  ),
  true,
  'another signal on the same sale is another feedback'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000002',
    'points_to_verify', 'not_relevant', 'point_missing'
  ),
  true,
  'another sale is another feedback'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000002', 'c6210000-1000-4000-8000-000000000001',
    'market_gap_band', 'useful'
  ),
  true,
  'another account is another feedback'
);
select is(
  (select count(*) from public.sale_signal_feedback
    where user_id = 'c6210000-0000-4000-8000-000000000001'),
  3::bigint,
  'the first account holds exactly its three distinct feedbacks'
);

-- Les listes sont fermées : rien d'autre n'est accepté ---------------------------------------------------
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001', 'page_viewed', 'useful')$$,
  '23514', null, 'an unknown signal is refused'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001', 'market_gap_band', 'great')$$,
  '23514', null, 'a value outside the list is refused'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001', 'market_gap_band', 'not_relevant', 'point_wrong')$$,
  '23514', null, 'a reason of the other signal is refused'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000001', 'points_to_verify', 'not_relevant', 'because I said so')$$,
  '23514', null, 'a free-text reason is refused'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000002', 'points_to_verify', 'useful', 'point_wrong')$$,
  '23514', null, 'a reason is only for « not_relevant »'
);
select throws_ok(
  $$select public.record_sale_signal_feedback(null, 'c6210000-1000-4000-8000-000000000001', 'market_gap_band', 'useful')$$,
  '22004', null, 'no account, no feedback'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-000000000001', null, 'market_gap_band', 'useful')$$,
  '22004', null, 'no sale, no feedback'
);
select throws_ok(
  $$select public.record_sale_signal_feedback('c6210000-0000-4000-8000-0000000000ff', 'c6210000-1000-4000-8000-000000000001', 'market_gap_band', 'useful')$$,
  '23503', null, 'an unknown account is refused by the foreign key'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000003',
    'market_gap_band', 'useful'
  ),
  false,
  'a sale outside the public catalogue (past) takes no feedback'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000001', 'c6210000-1000-4000-8000-0000000000ff',
    'market_gap_band', 'useful'
  ),
  false,
  'an unknown sale takes no feedback'
);

-- Plafond du jour : 100 retours par compte ----------------------------------------------------------------
select lives_ok(
  $sql$do $loop$
    begin
      for i in 4..100 loop
        if not public.record_sale_signal_feedback(
          'c6210000-0000-4000-8000-000000000003',
          ('c6210000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
          'points_to_verify', 'useful'
        ) then
          raise exception 'feedback % was not recorded', i;
        end if;
      end loop;
    end
  $loop$$sql$,
  'an account records its first 97 feedbacks'
);
select lives_ok(
  $sql$do $loop$
    begin
      for i in 1..2 loop
        if not public.record_sale_signal_feedback(
          'c6210000-0000-4000-8000-000000000003',
          ('c6210000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
          'market_gap_band', 'useful'
        ) then
          raise exception 'feedback % was not recorded', i;
        end if;
      end loop;
    end
  $loop$$sql$,
  'and two more on other signals: 99 so far'
);

select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000003', 'c6210000-1000-4000-8000-000000000101',
    'points_to_verify', 'useful'
  ),
  true,
  'the 100th feedback of the day is recorded'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000003', 'c6210000-1000-4000-8000-000000000102',
    'points_to_verify', 'useful'
  ),
  false,
  'the 101st feedback of the day is not recorded'
);
select is(
  public.record_sale_signal_feedback(
    'c6210000-0000-4000-8000-000000000003', 'c6210000-1000-4000-8000-000000000101',
    'points_to_verify', 'not_relevant', 'point_wrong'
  ),
  true,
  'correcting a feedback of the day is never refused by the cap'
);
reset role;

-- La purge des ventes n'est pas bloquée -----------------------------------------------------------------------
-- Deux retours du même compte, du même signal et du même jour sur deux ventes : avec un index unique qui
-- contiendrait une colonne passée à null, la seconde suppression échouerait (20261029100000).
-- Une vente ne se supprime qu'avec son pont Outcome Graph complet (require_outcome_bridge_before_auction_sale_delete) :
-- le jeu de données le crée d'abord, comme dans 516.
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales
    where id in ('c6210000-1000-4000-8000-000000000001', 'c6210000-1000-4000-8000-000000000002')$$,
  'deleting two sales that both carry a feedback of the same account and day does not fail'
);
select is(
  (select count(*) from public.sale_signal_feedback
    where user_id = 'c6210000-0000-4000-8000-000000000001' and sale_id is null),
  3::bigint,
  'the feedbacks are kept, detached from the sale'
);

-- Disparition avec le compte ------------------------------------------------------------------------------
delete from auth.users where id = 'c6210000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.sale_signal_feedback
    where user_id = 'c6210000-0000-4000-8000-000000000001'),
  0::bigint,
  'the feedback disappears with the account'
);

select * from finish();
rollback;
