-- Favoris du compte gratuit : 10 (et non plus 3), quota en base (app_private.free_favorite_limit()).
-- L'offre de lancement lève le quota (accès Analyse) ; la couper le rétablit sans toucher aux favoris.
begin;

select plan(11);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c4810000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'quota10-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4810000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'quota10-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c4810000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c4810000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

insert into public.auction_sales (id, source_name, source_url, title, status)
select
  ('c4810000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'free-favorite-quota-test',
  'https://example.test/free-favorite-quota/' || i,
  'Protected title ' || i,
  'upcoming'
from generate_series(1, 13) i;

-- Ce test vérifie le quota du compte gratuit : l'offre de lancement (active par défaut) est coupée.
update app_private.launch_offer set active = false where singleton;

select is(app_private.free_favorite_limit(), 10, 'the database quota of a free account is ten favourites');
select ok(
  not has_function_privilege('anon', 'app_private.free_favorite_limit()', 'EXECUTE'),
  'the quota helper is closed to anon'
);

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4810000-0000-4000-8000-000000000001","role":"authenticated"}';

select lives_ok(
  $$insert into public.user_favorites(user_id, sale_id)
    select 'c4810000-0000-4000-8000-000000000001',
           ('c4810000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
    from generate_series(1, 10) i$$,
  'a free account saves ten favourites'
);
select throws_ok(
  $$insert into public.user_favorites(user_id, sale_id) values
    ('c4810000-0000-4000-8000-000000000001', 'c4810000-1000-4000-8000-000000000011')$$,
  'P0001',
  'Quota de 10 favoris gratuits atteint. Retirez un favori pour en ajouter un autre.',
  'the eleventh favourite is refused'
);
select is(
  (select count(*) from public.user_favorites where user_id = 'c4810000-0000-4000-8000-000000000001'),
  10::bigint,
  'the refused insert left the ten favourites in place'
);
select lives_ok(
  $$delete from public.user_favorites where sale_id = 'c4810000-1000-4000-8000-000000000001'$$,
  'a favourite can be removed at the quota'
);
select lives_ok(
  $$insert into public.user_favorites(user_id, sale_id) values
    ('c4810000-0000-4000-8000-000000000001', 'c4810000-1000-4000-8000-000000000011')$$,
  'the freed slot can be reused'
);

-- Offre de lancement : le quota gratuit ne s'applique plus.
reset role;
update app_private.launch_offer set active = true where singleton;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4810000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok(
  $$insert into public.user_favorites(user_id, sale_id) values
    ('c4810000-0000-4000-8000-000000000001', 'c4810000-1000-4000-8000-000000000012')$$,
  'launch offer: an eleventh favourite is accepted (Analyse access)'
);

-- Offre coupée : les favoris restent, plus aucun ajout au-delà du quota.
reset role;
update app_private.launch_offer set active = false where singleton;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c4810000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$insert into public.user_favorites(user_id, sale_id) values
    ('c4810000-0000-4000-8000-000000000001', 'c4810000-1000-4000-8000-000000000013')$$,
  'P0001',
  'Quota de 10 favoris gratuits atteint. Retirez un favori pour en ajouter un autre.',
  'cut offer: the free quota applies again'
);
select is(
  (select count(*) from public.user_favorites where user_id = 'c4810000-0000-4000-8000-000000000001'),
  11::bigint,
  'cut offer: the favourites saved during the offer are kept, nothing to clean up'
);

set local "request.jwt.claims" = '{"sub":"c4810000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok(
  $$insert into public.user_favorites(user_id, sale_id)
    select 'c4810000-0000-4000-8000-000000000002',
           ('c4810000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
    from generate_series(1, 13) i$$,
  'an Analyse subscriber keeps unlimited favourites'
);

reset role;
select * from finish();
rollback;
