-- 20261029170200 (W9, point 51) : la politique de lecture des comptes connectés sur auction_sales appelle
-- is_admin() et has_analysis_access() en sous-select scalaire (InitPlan : une évaluation par requête). La
-- réécriture est strictement équivalente : ce test prouve que les droits n'ont pas changé pour un visiteur
-- anonyme, un compte gratuit, un compte Analyse et un administrateur, en comparant chaque lecture à
-- l'ANCIEN prédicat (20261027100200) évalué sur une copie des mêmes lignes, sous le même rôle.
begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(24);

-- Structure de la politique ---------------------------------------------------------------------------

select ok(
  (
    select policy.polcmd = 'r'
      and policy.polpermissive
      and policy.polroles = array['authenticated'::regrole]::oid[]
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.auction_sales'::regclass
      and policy.polname = 'auction_sales_authenticated_read'
  ),
  'la politique reste une politique de lecture permissive du seul rôle authenticated'
);

select ok(
  (
    select pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) ~ 'SELECT (public\.)?is_admin\(\)'
      and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) ~ 'SELECT (public\.)?has_analysis_access\(\)'
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.auction_sales'::regclass
      and policy.polname = 'auction_sales_authenticated_read'
  ),
  'is_admin() et has_analysis_access() sont encapsulés en sous-select (InitPlan)'
);

select is(
  (
    select array_length(
      regexp_split_to_array(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid),
        'is_admin\(\)'
      ),
      1
    ) - 1
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.auction_sales'::regclass
      and policy.polname = 'auction_sales_authenticated_read'
  ),
  1,
  'is_admin() n''est appelée qu''une fois dans la politique'
);

select ok(
  (
    select pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%catalogue_readiness_allows_premium%'
      and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%quarantined%'
      and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%catalogue_quarantined%'
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.auction_sales'::regclass
      and policy.polname = 'auction_sales_authenticated_read'
  ),
  'les contrôles de préparation Premium et de quarantaine sont conservés'
);

select ok(
  (
    select procedure_row.provolatile = 's'
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = 'public.is_admin()'::regprocedure
  )
  and (
    select procedure_row.provolatile = 's'
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = 'public.has_analysis_access()'::regprocedure
  ),
  'is_admin() et has_analysis_access() sont STABLE : une évaluation par requête donne le même résultat'
);

-- Droits de la table, inchangés ----------------------------------------------------------------------

select ok(
  not has_table_privilege('authenticated', 'public.auction_sales', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'source_name', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'catalogue_quarantined', 'select')
  and has_column_privilege('anon', 'public.auction_sales', 'id', 'select')
  and not has_column_privilege('anon', 'public.auction_sales', 'raw_payload', 'select'),
  'les droits de colonnes de authenticated et de anon sont ceux d''avant'
);

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'public.auction_sales'::regclass
  ),
  'la sécurité par ligne reste active sur auction_sales'
);

-- Fixtures -------------------------------------------------------------------------------------------
-- La préparation Premium n'est contrôlée que lorsque le réglage est activé : on l'active (annulé).
update public.catalogue_readiness_policy set enforcement_enabled = true where singleton;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, sale_procedure, raw_payload,
  premium_readiness_score, premium_readiness_status,
  premium_readiness_policy_version, premium_readiness_factors,
  starting_price_eur, latitude, longitude
) values
  -- 1. À venir, prête pour l'offre Premium : lisible par Analyse et par l'administrateur.
  ('f5980000-0000-4000-8000-000000000001', 'pgtap-598',
   'https://example.test/pgtap/598/ready', 'upcoming', '2099-01-01T10:00:00Z', '{}'::jsonb, '{}'::jsonb,
   78, 'premium_ready', 'premium_readiness_v1', '{}'::jsonb, 81000, 48.8566, 2.3522),
  -- 2. À venir mais incomplète : l'administrateur seul la lit (préparation exigée pour Analyse).
  ('f5980000-0000-4000-8000-000000000002', 'pgtap-598',
   'https://example.test/pgtap/598/incomplete', 'upcoming', '2099-01-01T10:00:00Z', '{}'::jsonb, '{}'::jsonb,
   62, 'needs_enrichment', 'premium_readiness_v1', '{}'::jsonb, 82000, 48.8566, 2.3522),
  -- 3. Statut « quarantined » : lisible par l'administrateur seul.
  ('f5980000-0000-4000-8000-000000000003', 'pgtap-598',
   'https://example.test/pgtap/598/status-quarantine', 'quarantined', '2099-01-01T10:00:00Z',
   '{}'::jsonb, '{}'::jsonb,
   78, 'premium_ready', 'premium_readiness_v1', '{}'::jsonb, 83000, 48.8566, 2.3522),
  -- 4. Quarantaine de publication portée par la fiche : lisible par l'administrateur seul.
  ('f5980000-0000-4000-8000-000000000004', 'pgtap-598',
   'https://example.test/pgtap/598/payload-quarantine', 'upcoming', '2099-01-01T10:00:00Z',
   '{}'::jsonb, jsonb_build_object('publication_quarantine', 'operator_hold'),
   78, 'premium_ready', 'premium_readiness_v1', '{}'::jsonb, 84000, 48.8566, 2.3522);

select is(
  (select catalogue_quarantined from public.auction_sales where id = 'f5980000-0000-4000-8000-000000000004'),
  true,
  'la quarantaine portée par la fiche est matérialisée dans catalogue_quarantined'
);

-- Copie des lignes (colonnes lues par la politique) : l'ancien prédicat y est évalué sans sécurité par
-- ligne, sous le rôle testé.
create table public.pgtap_598_rows as
select
  sale.id,
  sale.status,
  sale.premium_readiness_status,
  sale.premium_readiness_override,
  sale.premium_readiness_override_expires_at,
  sale.catalogue_quarantined
from public.auction_sales sale
where sale.source_name = 'pgtap-598';
grant select on public.pgtap_598_rows to anon, authenticated;

select is(
  (select count(*) from public.pgtap_598_rows),
  4::bigint,
  'les quatre ventes de départ sont copiées'
);

-- Comptes : Analyse, gratuit (Découverte), administrateur (créés par le propriétaire de la base :
-- auth.users n'est pas inscriptible par les rôles applicatifs).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('f5980000-0000-4000-8000-000000000010', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pgtap-598-analyse@example.test', '',
   now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('f5980000-0000-4000-8000-000000000011', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pgtap-598-gratuit@example.test', '',
   now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('f5980000-0000-4000-8000-000000000012', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pgtap-598-admin@example.test', '',
   now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('f5980000-0000-4000-8000-000000000010', 'analyse', 'active', now() + interval '30 days'),
  ('f5980000-0000-4000-8000-000000000011', 'decouverte', 'active', null);
update public.user_profiles
set user_role = 'admin'
where user_id = 'f5980000-0000-4000-8000-000000000012';

-- Visiteur anonyme : la politique des comptes connectés ne le concerne pas. Sa lecture (colonnes
-- accordées : id) reste celle de la politique publique, quarantaines masquées.
set local role anon;
select is(
  (select count(*) from public.auction_sales where id = 'f5980000-0000-4000-8000-000000000001'),
  1::bigint,
  'anon lit toujours une vente à venir publique'
);
select is(
  (
    select count(*)
    from public.auction_sales
    where id in (
      'f5980000-0000-4000-8000-000000000003',
      'f5980000-0000-4000-8000-000000000004'
    )
  ),
  0::bigint,
  'anon ne lit toujours aucune vente en quarantaine (statut ou fiche)'
);
reset role;

-- Compte gratuit (Découverte) -------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'f5980000-0000-4000-8000-000000000011';

select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-598'),
  0::bigint,
  'un compte gratuit ne lit toujours aucune ligne protégée de auction_sales'
);
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-598'),
  (
    select count(*)
    from public.pgtap_598_rows copy
    where public.is_admin()
      or (
        public.has_analysis_access()
        and public.catalogue_readiness_allows_premium(
          copy.premium_readiness_status,
          copy.premium_readiness_override,
          copy.premium_readiness_override_expires_at
        )
        and coalesce(copy.status, 'unknown') <> 'quarantined'
        and not copy.catalogue_quarantined
      )
  ),
  'compte gratuit : la lecture est celle de l''ancien prédicat'
);

-- Compte Analyse --------------------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'f5980000-0000-4000-8000-000000000010';

select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-598'),
  1::bigint,
  'un compte Analyse ne lit que la vente prête, ni l''incomplète ni les quarantaines'
);
select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'f5980000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'le compte Analyse lit la vente prête'
);
select is(
  (
    select count(*)
    from public.auction_sales
    where id in (
      'f5980000-0000-4000-8000-000000000002',
      'f5980000-0000-4000-8000-000000000003',
      'f5980000-0000-4000-8000-000000000004'
    )
  ),
  0::bigint,
  'le compte Analyse ne lit ni la vente incomplète ni les ventes en quarantaine'
);
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-598'),
  (
    select count(*)
    from public.pgtap_598_rows
    where public.is_admin()
      or (
        public.has_analysis_access()
        and public.catalogue_readiness_allows_premium(
          premium_readiness_status, premium_readiness_override, premium_readiness_override_expires_at
        )
        and coalesce(status, 'unknown') <> 'quarantined'
        and not catalogue_quarantined
      )
  ),
  'compte Analyse : la lecture est celle de l''ancien prédicat'
);
select is(
  (
    select coalesce(string_agg(sale.id::text, ',' order by sale.id), '')
    from public.auction_sales sale
    where sale.source_name = 'pgtap-598'
  ),
  (
    select coalesce(string_agg(copy.id::text, ',' order by copy.id), '')
    from public.pgtap_598_rows copy
    where public.is_admin()
      or (
        public.has_analysis_access()
        and public.catalogue_readiness_allows_premium(
          copy.premium_readiness_status,
          copy.premium_readiness_override,
          copy.premium_readiness_override_expires_at
        )
        and coalesce(copy.status, 'unknown') <> 'quarantined'
        and not copy.catalogue_quarantined
      )
  ),
  'compte Analyse : les mêmes identifiants que l''ancien prédicat'
);

-- Administrateur --------------------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'f5980000-0000-4000-8000-000000000012';

select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-598'),
  4::bigint,
  'un administrateur lit les quatre ventes, quarantaines et incomplètes comprises'
);
select is(
  (
    select coalesce(string_agg(sale.id::text, ',' order by sale.id), '')
    from public.auction_sales sale
    where sale.source_name = 'pgtap-598'
  ),
  (
    select coalesce(string_agg(copy.id::text, ',' order by copy.id), '')
    from public.pgtap_598_rows copy
    where public.is_admin()
      or (
        public.has_analysis_access()
        and public.catalogue_readiness_allows_premium(
          copy.premium_readiness_status,
          copy.premium_readiness_override,
          copy.premium_readiness_override_expires_at
        )
        and coalesce(copy.status, 'unknown') <> 'quarantined'
        and not copy.catalogue_quarantined
      )
  ),
  'administrateur : les mêmes identifiants que l''ancien prédicat'
);

-- Un compte Analyse dont l'abonnement a pris fin retombe aux droits d'un compte gratuit ---------------
reset role;
update public.user_subscriptions
set current_period_end = now() - interval '30 days'
where user_id = 'f5980000-0000-4000-8000-000000000010';
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'f5980000-0000-4000-8000-000000000010';

select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-598'),
  0::bigint,
  'un abonnement Analyse terminé ne lit plus aucune ligne protégée'
);

-- Une dérogation éditoriale « publier » admet une vente incomplète pour Analyse -------------------------
reset role;
update public.user_subscriptions
set current_period_end = now() + interval '30 days'
where user_id = 'f5980000-0000-4000-8000-000000000010';
-- La dérogation est posée par l'administrateur, par la fonction prévue (journal d'audit compris).
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'f5980000-0000-4000-8000-000000000012';
select public.set_auction_sale_readiness_override(
  'f5980000-0000-4000-8000-000000000002', 'publish', 'pgtap 598'
);
reset role;
-- La copie suit la ligne pour que l'ancien prédicat lise la même dérogation.
update public.pgtap_598_rows copy
set premium_readiness_override = sale.premium_readiness_override,
    premium_readiness_override_expires_at = sale.premium_readiness_override_expires_at
from public.auction_sales sale
where sale.id = copy.id;
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'f5980000-0000-4000-8000-000000000010';

select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'f5980000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'une dérogation « publier » admet la vente incomplète pour un compte Analyse'
);
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-598'),
  (
    select count(*)
    from public.pgtap_598_rows copy
    where public.is_admin()
      or (
        public.has_analysis_access()
        and public.catalogue_readiness_allows_premium(
          copy.premium_readiness_status,
          copy.premium_readiness_override,
          copy.premium_readiness_override_expires_at
        )
        and coalesce(copy.status, 'unknown') <> 'quarantined'
        and not copy.catalogue_quarantined
      )
  ),
  'avec la dérogation, la lecture reste celle de l''ancien prédicat'
);

reset role;

select ok(
  has_function_privilege('authenticated', 'public.is_admin()', 'execute')
  and has_function_privilege('authenticated', 'public.has_analysis_access()', 'execute')
  and not has_function_privilege('anon', 'public.is_admin()', 'execute')
  and not has_function_privilege('anon', 'public.has_analysis_access()', 'execute'),
  'les droits d''exécution des deux fonctions sont inchangés (authenticated oui, anon non)'
);

select * from finish();

rollback;
