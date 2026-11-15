-- Offre gratuite : une seule vente débloquée, plus d'essai (20261120100000).
--   * l'interrupteur de l'essai est coupé et sa date de coupure reculée : un compte confirmé il y a 2 jours
--     n'a pas l'accès Analyse ;
--   * une vente passée à « withdrawn » rend son déblocage, qui permet d'en débloquer une autre ;
--   * les clés héritées period_start / period_end restent dans la réponse.
-- Le test ne touche pas à l'interrupteur : il vérifie l'état laissé par la migration.
begin;

select plan(17);

-- 01 compte gratuit confirmé à l'instant ; 02 compte confirmé il y a 2 jours (son essai aurait couru)
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8860000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'single-unlock@free886.example.test', '', now(),
   now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('c8860000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'running-trial@free886.example.test', '', now() - interval '2 days',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c8860000-0000-4000-8000-000000000001', 'decouverte', 'active', null);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c8860000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'free-single-unlock-test',
  'https://example.test/free-single-unlock/' || i,
  'Single unlock title ' || i,
  'upcoming',
  '2099-01-01 12:00:00Z'::timestamptz
from generate_series(1, 2) i;

-- Fin de l'essai pour tous ----------------------------------------------------------------------------
select is(
  (select active from app_private.launch_offer where singleton),
  false,
  'the trial switch is cut by the migration'
);
select is(
  (select closed_at from app_private.launch_offer where singleton),
  '2026-01-01 00:00:00+00'::timestamptz,
  'its closing date is moved back before any running trial'
);
select ok(
  not app_private.launch_offer_confirmed_before_close('c8860000-0000-4000-8000-000000000002'),
  'an account confirmed 2 days ago is not flagged as confirmed before the cut'
);
select ok(
  not app_private.has_active_analysis_access('c8860000-0000-4000-8000-000000000002'),
  'an account confirmed 2 days ago has no Analyse access: running trials are closed too'
);
select is(
  (select gate_open from public.get_signup_trial('c8860000-0000-4000-8000-000000000002')),
  false,
  'the server reads the trial as closed for that account'
);

-- Structure -------------------------------------------------------------------------------------------
select hasnt_function(
  'app_private', 'monthly_sale_unlock_limit', array[]::text[],
  'the monthly limit is gone'
);
select is(app_private.free_sale_unlock_limit(), 1, 'a free account has one unlock in all');
select ok(
  has_function_privilege('authenticated', 'app_private.sale_is_withdrawn(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.sale_is_withdrawn(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.sale_is_withdrawn(uuid)', 'EXECUTE'),
  'the withdrawn helper is callable by an account and the server, not by anon'
);
select is(
  app_private.sale_is_withdrawn('c8860000-1000-4000-8000-0000000000ff'),
  false,
  'an unknown sale is not withdrawn'
);

-- Une vente retirée rend le déblocage ----------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c8860000-0000-4000-8000-000000000001';

select is(
  (public.unlock_sale('c8860000-1000-4000-8000-000000000001') ->> 'consumed')::boolean,
  true,
  'the free account uses its unlock'
);
select throws_ok(
  $$select public.unlock_sale('c8860000-1000-4000-8000-000000000002')$$,
  'P0001',
  'Vous avez déjà utilisé le déblocage de votre compte gratuit.',
  'a second sale is refused'
);
reset role;

update public.auction_sales set status = 'withdrawn'
where id = 'c8860000-1000-4000-8000-000000000001';
select is(
  app_private.sale_is_withdrawn('c8860000-1000-4000-8000-000000000001'),
  true,
  'the unlocked sale is withdrawn'
);

set local role authenticated;
select is(
  (public.get_sale_unlock_status() ->> 'used')::integer,
  0,
  'the unlock of a withdrawn sale no longer counts: it is given back automatically'
);
select is(
  (public.unlock_sale('c8860000-1000-4000-8000-000000000002') ->> 'consumed')::boolean,
  true,
  'the account can unlock another sale'
);
select is(
  (select count(*) from public.user_sale_unlocks),
  2::bigint,
  'the row of the withdrawn sale is kept: it just no longer counts'
);
select is(
  (public.get_sale_unlock_status() ->> 'remaining')::integer,
  0,
  'the new unlock is the single one'
);
select ok(
  public.get_sale_unlock_status() ?& array['period_start', 'period_end', 'limit', 'used', 'remaining'],
  'the legacy keys period_start / period_end are still answered'
);
reset role;

select * from finish();
rollback;
