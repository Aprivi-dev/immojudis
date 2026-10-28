-- Offre de lancement : une seule offre par adresse email canonique (20261029110000).
-- a+1@x et a+2@x (même boîte) ne sont pas deux comptes éligibles : seul le plus ancien compte confirmé
-- l'est ; les points Gmail et les googlemail.com sont ignorés ; un domaine jetable n'est pas éligible ;
-- un abonné ou un compte premium garde son accès quelle que soit son adresse ; la table dérivée suit
-- les changements d'adresse et ne bloque jamais une inscription (adresse nulle comprise).
begin;

select plan(48);

-- Fixtures -------------------------------------------------------------------------------------
-- 01 a+1 (confirmé il y a 3 jours) ; 02 a+2 (2 jours) ; 13 a+3 (premium, non confirmé)
-- 03 John.Doe@gmail.com (3 jours) ; 04 johndoe+promo@gmail.com ; 05 j.o.h.n.d.o.e@googlemail.com
-- 06 first.last@ et 07 firstlast@ (boîtes distinctes hors Gmail)
-- 08 adresse jetable ; 09 c+1 (non confirmé, créé le premier) ; 10 c+2 (confirmé)
-- 11 d+1 (confirmé il y a 2 jours) ; 12 d+2 (confirmé il y a 1 jour, abonné Analyse)
-- 14 sans adresse
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'a+1@canon.example.test', '', now() - interval '3 days',
   now() - interval '4 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'a+2@canon.example.test', '', now() - interval '2 days',
   now() - interval '3 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'John.Doe@gmail.com', '', now() - interval '3 days',
   now() - interval '4 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'johndoe+promo@gmail.com', '', now() - interval '2 days',
   now() - interval '3 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'j.o.h.n.d.o.e@googlemail.com', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'first.last@canon.example.test', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'firstlast@canon.example.test', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bot@mailinator.com', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000009', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c+1@canon.example.test', '', null,
   now() - interval '5 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c+2@canon.example.test', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'd+1@canon.example.test', '', now() - interval '2 days',
   now() - interval '3 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'd+2@canon.example.test', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000013', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'a+3@canon.example.test', '', null,
   now() - interval '1 day', now(), '{}'::jsonb, '{}'::jsonb),
  ('c5400000-0000-4000-8000-000000000014', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', null, '', null,
   now() - interval '1 day', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c5400000-0000-4000-8000-000000000012', 'analyse', 'active', now() + interval '30 days');
update public.user_profiles
set account_tier = 'premium'
where user_id = 'c5400000-0000-4000-8000-000000000013';

-- L'offre est active (état par défaut après 20261028120000), posée explicitement pour ce test.
update app_private.launch_offer set active = true where singleton;

-- Adresse canonique ------------------------------------------------------------------------------
select is(app_private.canonical_email('A+Tag@Example.COM'), 'a@example.com', 'the +tag is dropped and the case folded');
select is(app_private.canonical_email('John.Doe@gmail.com'), 'johndoe@gmail.com', 'Gmail dots are ignored');
select is(
  app_private.canonical_email('j.o.h.n+x@googlemail.com'),
  'john@gmail.com',
  'googlemail.com is gmail.com: dots and +tag dropped'
);
select is(
  app_private.canonical_email('first.last@example.com'),
  'first.last@example.com',
  'dots count outside Gmail'
);
select is(app_private.canonical_email('  Spaces@Example.com '), 'spaces@example.com', 'surrounding spaces are trimmed');
select is(app_private.canonical_email('+only@example.com'), '+only@example.com', 'an empty local part before the +tag is kept as is');
select is(app_private.canonical_email('not-an-email'), 'not-an-email', 'a value without @ is only lower-cased');
select is(app_private.canonical_email(null), null::text, 'no address, no canonical form');

select is(app_private.is_disposable_email_domain('x@MAILINATOR.com'), true, 'a listed disposable domain is recognised (case ignored)');
select is(app_private.is_disposable_email_domain('x@example.com'), false, 'an ordinary domain is not disposable');
select is(app_private.is_disposable_email_domain(null), false, 'no address is not flagged');

-- Structure et droits ----------------------------------------------------------------------------
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'app_private.launch_offer_account_eligible(uuid)'::regprocedure),
  true,
  'launch_offer_account_eligible stays stable, security definer, with an empty search_path'
);
select is(
  (select p.provolatile = 'i' and p.proconfig = array['search_path=""']
   from pg_proc p where p.oid = 'app_private.canonical_email(text)'::regprocedure),
  true,
  'canonical_email is immutable with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.canonical_email(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.canonical_email(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.is_disposable_email_domain(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.is_disposable_email_domain(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.launch_offer_account_eligible(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.launch_offer_account_eligible(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.launch_offer_account_eligible(uuid)', 'EXECUTE'),
  'the helpers are closed to the browser roles'
);
select ok(
  not has_function_privilege('anon', 'public.get_launch_offer_account_eligibility(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_launch_offer_account_eligibility(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_launch_offer_account_eligibility(uuid)', 'EXECUTE'),
  'the server-side read is executable by the service role only'
);
select is(
  (select relrowsecurity from pg_class where oid = 'app_private.account_email_identity'::regclass),
  true,
  'account_email_identity has row level security enabled'
);
select ok(
  not has_table_privilege('anon', 'app_private.account_email_identity', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.account_email_identity', 'SELECT'),
  'account_email_identity is closed to the browser roles'
);
select is(
  (select c.confdeltype
   from pg_constraint c
   where c.conrelid = 'app_private.account_email_identity'::regclass and c.contype = 'f'),
  'c'::"char",
  'the identity row is deleted with the account'
);
select is(
  (select count(*) from pg_trigger
   where tgrelid = 'auth.users'::regclass
     and tgname = 'immojudis_sync_account_email_identity'
     and not tgisinternal),
  1::bigint,
  'the sync trigger exists on auth.users, once'
);

-- Le déclencheur tient la table à jour, et ne bloque rien -----------------------------------------
select is(
  (select canonical_email from app_private.account_email_identity
   where user_id = 'c5400000-0000-4000-8000-000000000001'),
  'a@canon.example.test',
  'the sign-up trigger stored the canonical address of a+1@'
);
select is(
  (select canonical_email from app_private.account_email_identity
   where user_id = 'c5400000-0000-4000-8000-000000000003'),
  'johndoe@gmail.com',
  'and the Gmail canonical address'
);
select is(
  (select count(*) from app_private.account_email_identity
   where user_id = 'c5400000-0000-4000-8000-000000000014'),
  0::bigint,
  'an account without address is inserted (no error) and has no identity row'
);

-- Un seul compte éligible par adresse canonique ----------------------------------------------------
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000001'),
  true,
  'a+1 (the oldest confirmed account of a@canon) is eligible'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000002'),
  false,
  'a+2, confirmed later on the same mailbox, is not'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000003'),
  true,
  'John.Doe@gmail.com is eligible'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000004'),
  false,
  'johndoe+promo@gmail.com is the same mailbox: not eligible'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000005'),
  false,
  'j.o.h.n.d.o.e@googlemail.com is the same mailbox: not eligible'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000006')
  and app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000007'),
  true,
  'first.last@ and firstlast@ are two mailboxes outside Gmail: both eligible'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000008'),
  false,
  'a disposable address is not eligible'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000009'),
  false,
  'an unconfirmed account is not eligible, even if it was created first'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000010'),
  true,
  'c+2 is the oldest CONFIRMED account of its mailbox: eligible'
);
select is(
  public.get_launch_offer_account_eligibility('c5400000-0000-4000-8000-000000000001'),
  true,
  'the server-side read answers like the helper'
);
select is(
  public.get_launch_offer_account_eligibility('c5400000-0000-4000-8000-000000000002'),
  false,
  'including for the twin account'
);

-- Confirmer plus tard ne prend pas la place du plus ancien -----------------------------------------
update auth.users set email_confirmed_at = now() where id = 'c5400000-0000-4000-8000-000000000009';
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000009'),
  false,
  'c+1 confirms afterwards: c+2 confirmed first and keeps the offer'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000010'),
  true,
  'c+2 keeps its eligibility'
);

-- Les fonctions d'accès (offre active) --------------------------------------------------------------
select is(
  app_private.has_active_analysis_access('c5400000-0000-4000-8000-000000000001'),
  true,
  'active offer: the oldest account has the Analyse access'
);
select is(
  app_private.has_active_analysis_access('c5400000-0000-4000-8000-000000000002'),
  false,
  'active offer: its twin a+2 has none'
);
select is(
  app_private.has_active_analysis_access('c5400000-0000-4000-8000-000000000012'),
  true,
  'an Analyse subscriber keeps its access although an older account (d+1) has the same mailbox'
);
select is(
  app_private.has_active_analysis_access('c5400000-0000-4000-8000-000000000013'),
  true,
  'a premium account keeps its access although its address is a twin of a+1 and unconfirmed'
);

-- Un changement d'adresse recalcule l'identité ------------------------------------------------------
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000012'),
  false,
  'before: d+2 is the twin of d+1 for the offer'
);
update auth.users set email = 'elsewhere@canon.example.test'
where id = 'c5400000-0000-4000-8000-000000000011';
select is(
  (select canonical_email from app_private.account_email_identity
   where user_id = 'c5400000-0000-4000-8000-000000000011'),
  'elsewhere@canon.example.test',
  'the identity row follows the new address'
);
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000012'),
  true,
  'after d+1 moved away, d+2 is the oldest confirmed account of d@canon'
);
update auth.users set email = 'a+9@canon.example.test'
where id = 'c5400000-0000-4000-8000-000000000012';
select is(
  app_private.launch_offer_account_eligible('c5400000-0000-4000-8000-000000000012'),
  false,
  'moving INTO an already claimed mailbox (a@canon) does not get a second offer'
);

-- Offre coupée ----------------------------------------------------------------------------------------
update app_private.launch_offer set active = false where singleton;
select is(
  app_private.has_active_analysis_access('c5400000-0000-4000-8000-000000000001'),
  true,
  'cut offer: an eligible account confirmed before the cut keeps its running trial (20261108130100)'
);
select is(
  app_private.has_active_analysis_access('c5400000-0000-4000-8000-000000000002'),
  false,
  'cut offer: an account that is not eligible is not upgraded either'
);
select is(
  app_private.has_active_analysis_access('c5400000-0000-4000-8000-000000000012'),
  true,
  'cut offer: the subscriber keeps the Analyse access'
);

-- Aucune écriture dans les comptes -----------------------------------------------------------------------
select is(
  (select account_tier from public.user_profiles where user_id = 'c5400000-0000-4000-8000-000000000002'),
  'free',
  'the twin account was never touched in user_profiles'
);
select is(
  (select count(*) from public.user_subscriptions where user_id = 'c5400000-0000-4000-8000-000000000002'),
  0::bigint,
  'no subscription was created for the twin account'
);

select * from finish();
rollback;
