-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai. Procedure complete : supabase/repairs/README.md.
--
-- Point 6 (2026-10-20, chantier W1) : echeances des ventes « past » et « quarantined ».
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus),
-- APRES l'application de la migration 20261029100200_retention_past_quarantined_sales.sql :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : aucune ecriture, la transaction est annulee (rollback).
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql
--       -> mode APPLICATION : ecrit, dans une seule transaction.
--
-- Idempotente : une seconde execution ne trouve plus aucune ligne a recalculer.
--
-- Constat : les ventes « quarantined » (220 le 20/10/2026, dont 28 echues) et « past » (179) n'avaient pas
-- d'echeance (retention_deadline, catalogue_expiry_deadline) et n'etaient jamais purgees. La migration
-- 20261029100200 corrige les fonctions de calcul (conflit de date et fenetre de vente en ligne illisible ne
-- bloquent plus ces deux statuts), mais les declencheurs ne recalculent une echeance qu'a l'ecriture de la
-- ligne : les lignes existantes gardent leur echeance nulle jusqu'a cette reparation.
--
-- Ce que la reparation fait : pour chaque vente de statut past ou quarantined dont l'une des deux echeances
-- differe du resultat des fonctions corrigees, elle ecrit retention_deadline et catalogue_expiry_deadline.
-- Les declencheurs utilisateur en mode ordinaire sont suspendus le temps de l'ecriture (comme le rattrapage de
-- 20261027100100) : ni journal des ventes, ni relecture IA, ni controle de source ne se declenche pour un
-- simple recalcul. ALTER TABLE ... DISABLE TRIGGER prend un verrou SHARE ROW EXCLUSIVE : les ecritures de
-- la collecte attendent la fin de la transaction (quelques secondes) ; a lancer hors collecte.
--
-- Registre des pieces (lot R2a, 2026-11-11) : ce fichier faisait « disable trigger user » puis « enable trigger
-- user ». Le second ordre remet TOUS les declencheurs de la table en mode ordinaire : les trois declencheurs
-- « aaab_ » du registre des pieces, poses en mode « always », ne joueraient plus en
-- session_replication_role = replica, sans aucune erreur. Il ne suspend donc plus que les declencheurs qu'il veut
-- taire, nommes un a un : ceux qui sont en mode ordinaire (tgenabled = 'O') et dont le nom ne commence pas par
-- « aaab_ », notes dans une table temporaire, puis retablit exactement ceux-la. Un declencheur « always » n'est
-- jamais touche. Derniere instruction avant le commit : app_private.assert_fact_registry_triggers(), qui fait
-- echouer la transaction (rien n'est ecrit) si un declencheur du registre n'est pas en mode « always ».
-- Prerequis : la migration 20261117100100_fact_registry_guards.sql.
-- Une echeance deja echue ne declenche aucune suppression ici : c'est la purge planifiee (sale-retention,
-- lots de 25) qui supprime ensuite, vente par vente, avec son pont d'archive statistique.
-- Les valeurs d'origine sont copiees dans app_private.retention_deadline_repair_backup_20261029.
--
-- Ce qui n'est PAS repare : une vente sans date d'audience (sale_date nulle) reste sans echeance ; le
-- comptage ci-dessous la chiffre (sans_date). Rien ne permet d'en deduire une.
--
-- A verifier avant et apres (lecture seule) :
--   select status,
--          count(*) filter (where retention_deadline is null) as sans_garde,
--          count(*) filter (where catalogue_expiry_deadline is null) as sans_echeance_catalogue,
--          count(*) filter (where sale_date is null) as sans_date
--     from public.auction_sales
--    where status in ('past', 'quarantined')
--    group by status;
--
-- Retour arriere : voir la fin du fichier.

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply off
\endif

\if :apply
  \echo === MODE APPLICATION : les echeances des ventes past et quarantined seront recalculees ===
\else
  \echo === MODE COMPTAGE SEULEMENT : aucune ecriture. Relancer avec -v apply=1 pour appliquer. ===
\endif

begin;
set local lock_timeout = '5s';

-- Plan : calcule dans les deux modes, avec les fonctions de la migration 20261029100200.
create temporary table deadline_repair_rows on commit drop as
select
  planned.id,
  planned.status,
  planned.sale_date,
  planned.old_retention_deadline,
  planned.old_catalogue_expiry_deadline,
  planned.new_retention_deadline,
  planned.new_catalogue_expiry_deadline
from (
  select
    s.id,
    s.status,
    s.sale_date,
    s.retention_deadline as old_retention_deadline,
    s.catalogue_expiry_deadline as old_catalogue_expiry_deadline,
    app_private.sale_retention_deadline(s.sale_date, s.status, s.sale_procedure, s.raw_payload)
      as new_retention_deadline,
    app_private.sale_catalogue_retention_deadline(s.sale_date, s.status, s.sale_procedure, s.raw_payload)
      as new_catalogue_expiry_deadline
  from public.auction_sales s
  where s.status in ('past', 'quarantined')
) planned
where planned.old_retention_deadline is distinct from planned.new_retention_deadline
   or planned.old_catalogue_expiry_deadline is distinct from planned.new_catalogue_expiry_deadline;

-- Mode comptage : le plan est calcule, la transaction devient en lecture seule (rien ne s'ecrit
-- dans les tables) puis se termine par un rollback.
\if :apply
\else
  set transaction read only;
\endif

-- Comptage (les deux modes) : ce que l'application modifierait.
select
  r.status,
  count(*) as lignes_a_recalculer,
  count(*) filter (where r.new_catalogue_expiry_deadline <= now()) as echues,
  count(*) filter (where r.new_catalogue_expiry_deadline <= now() - interval '1 day') as echues_depuis_1_jour,
  count(*) filter (where r.new_catalogue_expiry_deadline <= now() - interval '30 days') as echues_depuis_30_jours,
  count(*) filter (where r.new_catalogue_expiry_deadline is null) as restent_sans_echeance
from deadline_repair_rows r
group by r.status
order by r.status;

-- Ce qui reste sans date d'audience, donc sans echeance possible (non repare).
select s.status, count(*) as sans_date
  from public.auction_sales s
 where s.status in ('past', 'quarantined') and s.sale_date is null
 group by s.status
 order by s.status;

\if :apply
  create table if not exists app_private.retention_deadline_repair_backup_20261029 (
    id uuid primary key,
    retention_deadline timestamptz,
    catalogue_expiry_deadline timestamptz,
    backed_up_at timestamptz not null default now()
  );
  revoke all on app_private.retention_deadline_repair_backup_20261029 from public, anon, authenticated;

  insert into app_private.retention_deadline_repair_backup_20261029
    (id, retention_deadline, catalogue_expiry_deadline)
  select r.id, r.old_retention_deadline, r.old_catalogue_expiry_deadline
    from deadline_repair_rows r
  on conflict (id) do nothing;

  -- Declencheurs suspendus : ceux qui sont en mode ordinaire, jamais ceux du registre des pieces.
  create temporary table deadline_repair_suspended_triggers (
    trigger_name name primary key
  ) on commit drop;

  do $suspend$
  declare
    v_trigger name;
  begin
    for v_trigger in
      select trigger_row.tgname
        from pg_catalog.pg_trigger trigger_row
       where trigger_row.tgrelid = 'public.auction_sales'::regclass
         and not trigger_row.tgisinternal
         and trigger_row.tgenabled = 'O'
         and trigger_row.tgname not like 'aaab\_%'
       order by trigger_row.tgname
    loop
      insert into deadline_repair_suspended_triggers (trigger_name) values (v_trigger);
      execute pg_catalog.format('alter table public.auction_sales disable trigger %I', v_trigger);
    end loop;
  end;
  $suspend$;

  update public.auction_sales s
     set retention_deadline = r.new_retention_deadline,
         retention_deadline_materialized = true,
         catalogue_expiry_deadline = r.new_catalogue_expiry_deadline,
         catalogue_expiry_materialized = true
    from deadline_repair_rows r
   where s.id = r.id;

  -- Retablit exactement les declencheurs suspendus ci-dessus, dans leur mode d'origine (ordinaire).
  do $resume$
  declare
    v_trigger name;
  begin
    for v_trigger in
      select suspended.trigger_name
        from deadline_repair_suspended_triggers suspended
       order by suspended.trigger_name
    loop
      execute pg_catalog.format('alter table public.auction_sales enable trigger %I', v_trigger);
    end loop;
  end;
  $resume$;

  -- Echec ferme : rien n'est valide si un declencheur du registre des pieces n'est pas en mode « always ».
  select app_private.assert_fact_registry_triggers();

  \echo === Application terminee : relancer la requete de controle de l en-tete. ===
\endif

\if :apply
  commit;
\else
  rollback;
\endif

-- Retour arriere (a executer a la main, hors de ce fichier) : reprendre les deux blocs « suspend » et « resume »
-- ci-dessus autour de la mise a jour inverse, et terminer par app_private.assert_fact_registry_triggers().
-- NE PAS utiliser « disable trigger user » puis « enable trigger user » : le second ordre sortirait les
-- declencheurs du registre des pieces du mode « always » (remise en etat :
-- supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql).
--   update public.auction_sales s
--      set retention_deadline = b.retention_deadline,
--          catalogue_expiry_deadline = b.catalogue_expiry_deadline
--     from app_private.retention_deadline_repair_backup_20261029 b
--    where s.id = b.id;
