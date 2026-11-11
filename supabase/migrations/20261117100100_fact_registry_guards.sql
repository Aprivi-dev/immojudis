begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2a, étape A2 (plan du 11/11/2026, section 10 ; annexe 08, points 9 et 11). INERTE :
-- aucun champ n'est tenu, aucune observation ne porte une origine réservée, la file d'évènements est vide.
--
--   1. Gardes par rôle en LISTE BLANCHE. Au lot R1 les deux gardes refusaient les rôles de l'API par leur nom
--      (anon, authenticated, service_role, authenticator) : un rôle créé plus tard passait. Elles n'acceptent
--      plus qu'UN rôle, le propriétaire de la projection app_private.project_sale_fields (dans une fonction
--      SECURITY DEFINER du registre, current_user est ce propriétaire). La liste d'exclusion est gardée telle
--      quelle en première condition : elle reste vraie même si la projection changeait de propriétaire.
--        * app_private.refuse_api_role_held_fields_write : tout changement de auction_sales.held_fields ;
--        * app_private.refuse_api_role_registry_origin : toute observation d'origine réservée (professional_email,
--          professional_form, admin_entry).
--      Le propriétaire est lu dans pg_proc (lisible par tous les rôles), pas par un transtypage regprocedure, qui
--      exige un droit sur le schéma app_private. Sans projection, ou avec plusieurs propriétaires, tout est refusé.
--      LIMITE, à connaître : le chemin SQL direct de la collecte (SUPABASE_DB_URL) se connecte aujourd'hui avec le
--      rôle propriétaire des fonctions. Aucune garde par rôle ne le distingue de la projection : pour ce chemin,
--      la protection reste la retenue (marqueur de transaction) et l'invariant de code
--      held-fields-projection-only. Elle ne deviendra réelle qu'avec un rôle de connexion propre à la collecte
--      (chantier séparé).
--   2. app_private.fact_registry_triggers_not_always() et app_private.assert_fact_registry_triggers(). Un
--      « alter table … disable trigger user » suivi d'un « enable trigger user » (ce que faisait le rattrapage
--      supabase/repairs/20261029100200, réécrit dans ce lot) remet tous les déclencheurs en mode ordinaire : ceux du
--      registre cesseraient de jouer en session_replication_role = replica, sans aucune erreur. La première
--      fonction liste les déclencheurs du registre absents ou hors du mode « always » ; la seconde lève 55000
--      « registry_unavailable » s'il y en a un. Appelée par le contrôle quotidien (20261117100500), par les
--      fonctions de décision des lots R2b et R2c avant toute écriture (échec fermé), et en dernière instruction de
--      tout rattrapage qui écrit auction_sales. Remise en état : supabase/maintenance/
--      20261117100600_restore_fact_registry_trigger_modes.sql.
--   3. Évènement « echo_suppressed » dans public.auction_sale_field_hold_events : la retenue (20261117100200) le
--      journalise quand elle écarte le retour d'une ancienne valeur tenue. La contrainte de la colonne event est
--      recréée avec cette valeur. Son nom réel, lu dans le catalogue rejoué, est celui attribué d'office à la
--      contrainte de colonne de 20261116100000 : auction_sale_field_hold_events_event_check.
--
-- Verrous : remplacement de fonctions ; ACCESS EXCLUSIVE bref sur public.auction_sale_field_hold_events (table
-- vide en production : le contrôle de la contrainte est immédiat). Recréée seulement si elle n'a pas déjà la
-- valeur : une seconde application ne reprend pas ce verrou. Aucun verrou sur auction_sales ni sur
-- auction_fact_claims. Possible pendant un import.
--
-- Retour arrière :
--   begin; set local lock_timeout = '5s';
--   -- rétablir les deux gardes de 20261116100100 et 20261116100500 (liste d'exclusion seule), puis :
--   drop function if exists app_private.assert_fact_registry_triggers();
--   drop function if exists app_private.fact_registry_triggers_not_always();
--   -- seulement si aucun évènement echo_suppressed n'a été écrit :
--   alter table public.auction_sale_field_hold_events drop constraint auction_sale_field_hold_events_event_check;
--   alter table public.auction_sale_field_hold_events add constraint auction_sale_field_hold_events_event_check
--     check (event in ('listing_changed_kept', 'listing_changed_released', 'projection_held',
--       'projection_released', 'projection_blocked', 'conflicted'));
--   commit;

-- 1. Gardes par rôle --------------------------------------------------------------------------------------------
-- SECURITY INVOKER : la fonction lit le rôle qui écrit (dans la projection, SECURITY DEFINER, c'est son
-- propriétaire). Elle ne s'exécute que lorsque held_fields change (clause WHEN du déclencheur).
create or replace function app_private.refuse_api_role_held_fields_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator')
    or not exists (
      select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'app_private' and routine.proname = 'project_sale_fields'
    )
    or exists (
      select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'app_private' and routine.proname = 'project_sale_fields'
        and pg_catalog.pg_get_userbyid(routine.proowner) is distinct from current_user
    )
  then
    raise exception using errcode = '42501',
      message = 'auction_sales.held_fields cannot be written by an API role.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.refuse_api_role_held_fields_write()
  from public, anon, authenticated, service_role;

create or replace function app_private.refuse_api_role_registry_origin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role', 'authenticator')
    or not exists (
      select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'app_private' and routine.proname = 'project_sale_fields'
    )
    or exists (
      select 1
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = 'app_private' and routine.proname = 'project_sale_fields'
        and pg_catalog.pg_get_userbyid(routine.proowner) is distinct from current_user
    )
  then
    raise exception using errcode = '42501',
      message = 'A professional or administrator fact claim cannot be inserted by an API role.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.refuse_api_role_registry_origin()
  from public, anon, authenticated, service_role;

-- 2. Mode des déclencheurs du registre ---------------------------------------------------------------------------
-- Les onze déclencheurs posés par 20261116100000, 20261116100100 et 20261116100500, nommés un à un : un
-- déclencheur supprimé est signalé comme un déclencheur passé en mode ordinaire.
create or replace function app_private.fact_registry_triggers_not_always()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    pg_catalog.array_agg(expected.table_name || '.' || expected.trigger_name
      order by expected.table_name, expected.trigger_name),
    array[]::text[]
  )
  from (
    values
      ('auction_sales', 'aaab_auction_sales_held_fields_insert_guard'),
      ('auction_sales', 'aaab_auction_sales_held_fields_role_guard'),
      ('auction_sales', 'aaab_auction_sales_hold_projected_fields'),
      ('auction_fact_claim_decisions', 'auction_fact_claim_decisions_append_only'),
      ('auction_fact_claim_decisions', 'auction_fact_claim_decisions_no_truncate'),
      ('auction_fact_claim_decisions', 'auction_fact_claim_decisions_validate'),
      ('auction_fact_claims', 'auction_fact_claims_no_truncate'),
      ('auction_fact_claims', 'auction_fact_claims_registry_origin_guard'),
      ('auction_sale_field_hold_events', 'auction_sale_field_hold_events_append_only'),
      ('auction_sale_field_hold_events', 'auction_sale_field_hold_events_no_truncate'),
      ('auction_sale_field_hold_events', 'auction_sale_field_hold_events_stamp')
  ) as expected (table_name, trigger_name)
  where not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = expected.table_name
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'A'
  );
$$;

comment on function app_private.fact_registry_triggers_not_always() is
  'Registre des pièces : déclencheurs du registre absents ou hors du mode « always » (tableau vide si tout est en place). Lecture du catalogue seulement.';

revoke all on function app_private.fact_registry_triggers_not_always()
  from public, anon, authenticated, service_role;

create or replace function app_private.assert_fact_registry_triggers()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if pg_catalog.cardinality(app_private.fact_registry_triggers_not_always()) > 0 then
    -- Le message est le code attendu par les fonctions de décision ; le détail ne porte que des noms d'objets.
    raise exception using errcode = '55000', message = 'registry_unavailable',
      detail = 'Fact registry triggers missing or not enabled always: '
        || pg_catalog.array_to_string(app_private.fact_registry_triggers_not_always(), ', ');
  end if;
end;
$$;

comment on function app_private.assert_fact_registry_triggers() is
  'Registre des pièces : lève 55000 « registry_unavailable » si un déclencheur du registre manque ou n''est plus en mode « always » (échec fermé avant toute écriture du registre, et dernière instruction d''un rattrapage qui écrit auction_sales).';

revoke all on function app_private.assert_fact_registry_triggers()
  from public, anon, authenticated, service_role;

-- 3. Évènement echo_suppressed ------------------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_sale_field_hold_events'::regclass
      and constraint_row.conname = 'auction_sale_field_hold_events_event_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%echo_suppressed%'
  ) then
    alter table public.auction_sale_field_hold_events
      drop constraint if exists auction_sale_field_hold_events_event_check;
    alter table public.auction_sale_field_hold_events
      add constraint auction_sale_field_hold_events_event_check check (
        event in (
          'listing_changed_kept', 'listing_changed_released', 'projection_held', 'projection_released',
          'projection_blocked', 'conflicted', 'echo_suppressed'
        )
      );
  end if;
end;
$$;

comment on table public.auction_sale_field_hold_events is
  'Registre des pièces : file de relecture en ajout seul des champs tenus (l''annonce a changé sur un champ tenu, pièce posée, retirée ou refusée par la fiche, contradiction, retour écarté d''une ancienne valeur tenue). Valeurs de champs seulement (occupation : vacant, occupied ou rented) : ni extrait, ni email, ni nom.';

notify pgrst, 'reload schema';

commit;
