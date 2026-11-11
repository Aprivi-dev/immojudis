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
--      Chaque déclencheur est contrôlé par son nom, son mode ET sa fonction (tgfoid) : un déclencheur recréé sur
--      une autre fonction est signalé comme manquant. La liste compte douze déclencheurs : les onze du lot R1 et
--      aaab_auction_sales_held_fields_marker_guard, créé par 20261117100200. Entre cette migration et la
--      suivante, assert_fact_registry_triggers() lève donc 55000 (échec fermé) : rien ne l'appelle avant
--      20261117100500, et le workflow applique les deux à la suite.
--   3. Évènement « echo_suppressed » dans public.auction_sale_field_hold_events : la retenue (20261117100200) le
--      journalise quand elle écarte le retour d'une ancienne valeur tenue. La contrainte de la colonne event est
--      recréée avec cette valeur. Son nom réel, lu dans le catalogue rejoué, est celui attribué d'office à la
--      contrainte de colonne de 20261116100000 : auction_sale_field_hold_events_event_check.
--   4. ORIGINE PROFESSIONNELLE FORGEABLE. La garde d'origine de public.auction_fact_claims ne se déclenchait que
--      pour trois natures (professional_email, professional_form, admin_entry). Or le classement
--      app_private.fact_claim_source_kind range aussi en « lawyer_email » une observation manual_review,
--      email_attachment ou portal_upload d'extracteur information_agent qui porte information_agent_fact_id : un
--      rôle de l'API pouvait l'insérer, et une acceptation l'aurait attribuée à l'avocat poursuivant. La clause
--      WHEN du déclencheur est étendue à l'extracteur information_agent et à la clé information_agent_fact_id.
--      Le pont existant (app_private.bridge_accepted_information_agent_fact_claim, SECURITY DEFINER) s'exécute
--      en propriétaire : il passe. La collecte écrit l'extracteur immojudis.pipeline.fact_claims, sans cette clé :
--      la clause est fausse pour elle, aucun appel PL/pgSQL.
--   5. GARDE DU MARQUEUR : app_private.refuse_sale_field_projection_marker(), SECURITY INVOKER. Le marqueur de
--      transaction app.sale_field_projection fait foi pour la retenue (SECURITY DEFINER, qui ne voit pas le rôle
--      appelant) : tout rôle capable de le poser réécrivait les colonnes tenues d'une vente sans toucher
--      held_fields. La fonction lève 42501 quand le marqueur désigne la vente écrite et que le rôle n'est pas le
--      propriétaire de la projection. Le déclencheur aaab_auction_sales_held_fields_marker_guard est créé par
--      20261117100200 (un seul verrou sur auction_sales pour tout le lot).
--   6. lot_ref (public.auction_fact_claim_decisions) : ce que dit la pièce (« lot 2 », « Lot n° 3 »), texte libre
--      de 40 caractères dans un journal non effaçable. Borné par un format : une lettre ou un chiffre, puis au
--      plus 39 lettres, chiffres, espaces ou signes de ponctuation simple (. , / ( ) ' - ° º & + #). Ni arobase,
--      ni deux-points, ni saut de ligne. Écrite en une seule expression rationnelle, sans BETWEEN (la forme
--      « between … and … » suivie d'un autre terme par AND ne s'imprime pas de la même façon en production et
--      sur la base d'ombre du contrôle de dérive).
--
-- Verrous : remplacement de fonctions ; ACCESS EXCLUSIVE bref sur public.auction_sale_field_hold_events et sur
-- public.auction_fact_claim_decisions (tables vides en production : le contrôle des contraintes est immédiat).
-- Chaque contrainte n'est recréée que si elle n'a pas déjà la forme voulue : une seconde application ne reprend
-- pas ces verrous. SHARE ROW EXCLUSIVE sur public.auction_fact_claims (CREATE OR REPLACE TRIGGER et ENABLE ALWAYS
-- TRIGGER), à la première comme à la seconde application, jamais ACCESS EXCLUSIVE : les lectures passent, une
-- écriture d'observation attend quelques millisecondes. lock_timeout est ramené à 1 s juste avant (le verrou est
-- libre, ou pris par un lot de la collecte : attendre plus ne ferait que bloquer les autres écrivains). Aucun
-- verrou sur auction_sales. À APPLIQUER ENTRE DEUX LOTS DE PUBLICATION, comme 20261117100200.
--
-- Retour arrière :
--   begin; set local lock_timeout = '5s';
--   -- rétablir les deux gardes de 20261116100100 et 20261116100500 (liste d'exclusion seule) et le déclencheur
--   -- auction_fact_claims_registry_origin_guard de 20261116100100 (clause WHEN à trois natures), puis :
--   drop function if exists app_private.assert_fact_registry_triggers();
--   drop function if exists app_private.fact_registry_triggers_not_always();
--   drop function if exists app_private.refuse_sale_field_projection_marker();  -- après son déclencheur
--   -- seulement si aucun évènement echo_suppressed n'a été écrit :
--   alter table public.auction_sale_field_hold_events drop constraint auction_sale_field_hold_events_event_check;
--   alter table public.auction_sale_field_hold_events add constraint auction_sale_field_hold_events_event_check
--     check (event in ('listing_changed_kept', 'listing_changed_released', 'projection_held',
--       'projection_released', 'projection_blocked', 'conflicted'));
--   alter table public.auction_fact_claim_decisions drop constraint auction_fact_claim_decisions_lot_ref_check;
--   alter table public.auction_fact_claim_decisions add constraint auction_fact_claim_decisions_lot_ref_check
--     check (lot_ref is null or char_length(btrim(lot_ref)) between 1 and 40);
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

-- Garde du marqueur (point 5 de l'en-tête). SECURITY INVOKER, comme les deux gardes ci-dessus : elle lit le rôle
-- qui écrit. Elle ne s'exécute que pour une vente du registre, ou pour une écriture qui apporte le libellé réservé
-- (clause WHEN de son déclencheur, 20261117100200). Sans marqueur, ou avec le marqueur d'une autre vente, elle
-- laisse passer : la retenue s'applique alors à l'écriture.
create or replace function app_private.refuse_sale_field_projection_marker()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.current_setting('app.sale_field_projection', true), '') = new.id::text
    and (
      current_user in ('anon', 'authenticated', 'service_role', 'authenticator')
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
    )
  then
    raise exception using errcode = '42501',
      message = 'The sale field projection marker is reserved to app_private.project_sale_fields.';
  end if;
  return new;
end;
$$;

comment on function app_private.refuse_sale_field_projection_marker() is
  'Registre des pièces : refuse (42501) l''écriture d''une colonne surveillée d''une vente du registre quand le marqueur de transaction de la projection désigne cette vente et que le rôle n''est pas le propriétaire de la projection.';

revoke all on function app_private.refuse_sale_field_projection_marker()
  from public, anon, authenticated, service_role;

-- 2. Mode des déclencheurs du registre ---------------------------------------------------------------------------
-- Les onze déclencheurs posés par 20261116100000, 20261116100100 et 20261116100500, et la garde du marqueur de
-- 20261117100200, nommés un à un avec leur fonction : un déclencheur supprimé, ou recréé sur une autre fonction,
-- est signalé comme un déclencheur passé en mode ordinaire.
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
      ('auction_sales', 'aaab_auction_sales_held_fields_insert_guard', 'refuse_inserted_held_fields'),
      ('auction_sales', 'aaab_auction_sales_held_fields_marker_guard', 'refuse_sale_field_projection_marker'),
      ('auction_sales', 'aaab_auction_sales_held_fields_role_guard', 'refuse_api_role_held_fields_write'),
      ('auction_sales', 'aaab_auction_sales_hold_projected_fields', 'hold_projected_sale_fields'),
      ('auction_fact_claim_decisions', 'auction_fact_claim_decisions_append_only', 'fact_registry_append_only'),
      ('auction_fact_claim_decisions', 'auction_fact_claim_decisions_no_truncate', 'fact_registry_append_only'),
      ('auction_fact_claim_decisions', 'auction_fact_claim_decisions_validate',
        'validate_auction_fact_claim_decision'),
      ('auction_fact_claims', 'auction_fact_claims_no_truncate', 'refuse_auction_fact_claims_truncate'),
      ('auction_fact_claims', 'auction_fact_claims_registry_origin_guard', 'refuse_api_role_registry_origin'),
      ('auction_sale_field_hold_events', 'auction_sale_field_hold_events_append_only',
        'fact_registry_append_only'),
      ('auction_sale_field_hold_events', 'auction_sale_field_hold_events_no_truncate',
        'fact_registry_append_only'),
      ('auction_sale_field_hold_events', 'auction_sale_field_hold_events_stamp', 'stamp_fact_registry_event')
  ) as expected (table_name, trigger_name, function_name)
  where not exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_catalog.pg_proc routine on routine.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace routine_namespace on routine_namespace.oid = routine.pronamespace
    where namespace.nspname = 'public'
      and relation.relname = expected.table_name
      and trigger_row.tgname = expected.trigger_name
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'A'
      and routine_namespace.nspname = 'app_private'
      and routine.proname = expected.function_name
  );
$$;

comment on function app_private.fact_registry_triggers_not_always() is
  'Registre des pièces : déclencheurs du registre absents, hors du mode « always » ou liés à une autre fonction que la leur (tableau vide si tout est en place). Lecture du catalogue seulement.';

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

-- 6. Format de lot_ref (point 6 de l'en-tête) --------------------------------------------------------------------
-- Même méthode que ci-dessus : la contrainte de colonne de 20261116100000 (nom attribué d'office :
-- auction_fact_claim_decisions_lot_ref_check) n'est recréée que si elle n'a pas déjà le format. Le motif tient en
-- une expression : premier caractère lettre ou chiffre (donc ni vide, ni blanc), 40 caractères au plus. En
-- expression rationnelle avancée de PostgreSQL, « $ » ne concorde qu'à la fin de la chaîne : un saut de ligne
-- final est refusé.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_fact_claim_decisions'::regclass
      and constraint_row.conname = 'auction_fact_claim_decisions_lot_ref_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like '%lot_ref ~ %'
  ) then
    alter table public.auction_fact_claim_decisions
      drop constraint if exists auction_fact_claim_decisions_lot_ref_check;
    alter table public.auction_fact_claim_decisions
      add constraint auction_fact_claim_decisions_lot_ref_check check (
        lot_ref is null
        or lot_ref ~ '^[0-9A-Za-zÀ-ÖØ-öø-ÿ][0-9A-Za-zÀ-ÖØ-öø-ÿ .,/()''°º&+#-]{0,39}$'
      );
  end if;
end;
$$;

comment on column public.auction_fact_claim_decisions.lot_ref is
  'Registre des pièces : ce que dit la pièce du lot (« lot 2 », « Lot n° 3 »). Format borné : lettres, chiffres, espaces et ponctuation simple, 40 caractères au plus. Jamais un nom, une adresse ni un extrait.';

-- 4. Garde d'origine étendue (point 4 de l'en-tête) --------------------------------------------------------------
-- Placée en dernier : c'est la seule instruction de ce fichier qui attend un verrou sur une table écrite par la
-- collecte. CREATE OR REPLACE TRIGGER garde le déclencheur en place (jamais de fenêtre sans garde)
-- et ne prend que SHARE ROW EXCLUSIVE ; son mode est reposé ensuite, comme au lot R1.
set local lock_timeout = '1s';

create or replace trigger auction_fact_claims_registry_origin_guard
  before insert on public.auction_fact_claims
  for each row
  when (
    new.evidence_kind in ('professional_email', 'professional_form', 'admin_entry')
    or new.extractor_name = 'information_agent'
    or new.evidence_locator ? 'information_agent_fact_id'
  )
  execute function app_private.refuse_api_role_registry_origin();
alter table public.auction_fact_claims enable always trigger auction_fact_claims_registry_origin_guard;

notify pgrst, 'reload schema';

commit;
