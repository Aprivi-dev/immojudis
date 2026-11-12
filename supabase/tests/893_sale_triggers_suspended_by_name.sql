-- 20261119100000 (registre des pièces, lot R2c, contre-vérification 3 du lot R2b : constats N1 et N3).
--   * les fonctions qui réécrivent des ventes sans journal ne coupent plus tous les déclencheurs de auction_sales :
--     après un retrait de source et après le recalcul de catalogue_quarantined, les déclencheurs du registre sont
--     toujours en mode « always », et les déclencheurs ordinaires sont rétablis ;
--   * pendant la réécriture, les déclencheurs ordinaires ne jouent pas (comme avant) ;
--   * les deux fonctions de suspension ne touchent jamais un déclencheur « aaab_ » ni un déclencheur déjà coupé,
--     et ne sont exécutables par aucun rôle de l'API ;
--   * aucune fonction du dépôt ne contient « trigger user » ni « trigger all » ;
--   * aucune table du registre n'a de table fille ni de table mère (pg_inherits) ;
--   * aucune tâche pg_cron ne nomme une fonction de décision ni le jeton de la requête.
begin;

select plan(15);

-- Un déclencheur ordinaire témoin, posé pour le fichier : il note chaque ligne de auction_sales mise à jour.
create temporary table probe_log (sale_id uuid) on commit drop;
create function pg_temp.probe_sale_update() returns trigger
language plpgsql as $function$
begin
  insert into probe_log values (new.id);
  return new;
end;
$function$;
create trigger pgtap_893_probe before update on public.auction_sales
  for each row execute function pg_temp.probe_sale_update();

-- État de départ : les déclencheurs de auction_sales, avec leur mode.
create temporary table triggers_before on commit drop as
  select trigger_row.tgname, trigger_row.tgenabled
  from pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.auction_sales'::regclass and not trigger_row.tgisinternal;

select is(
  app_private.fact_registry_triggers_not_always(), array[]::text[],
  'before: every trigger of the fact registry is enabled always'
);

-- Retrait d'une source (le geste entier, comme le fait le rôle de service) -------------------------------------------
insert into public.auction_sales (source_name, source_url, observations, raw_payload)
values ('licitor', 'https://www.licitor.com/pgtap-893-seul', '[{"source_name":"licitor"}]', '{}');
set local role service_role;
select lives_ok(
  $$select public.set_catalogue_source_withdrawal('licitor', true, 'pgTAP 893')$$,
  'the server role withdraws a source'
);
reset role;

select is(
  app_private.fact_registry_triggers_not_always(), array[]::text[],
  'after the withdrawal of a source, the triggers of the fact registry are still enabled always: decisions stay possible'
);
select is_empty(
  $$select before.tgname, before.tgenabled, after.tgenabled
      from triggers_before before
      left join pg_trigger after
        on after.tgrelid = 'public.auction_sales'::regclass and after.tgname = before.tgname
      where after.tgenabled is distinct from before.tgenabled$$,
  'and every trigger of auction_sales is back in the mode it had'
);
select ok(
  (select sale.catalogue_quarantined and sale.raw_payload ->> 'publication_quarantine' = 'source_withdrawn'
     from public.auction_sales sale where sale.source_url = 'https://www.licitor.com/pgtap-893-seul')
  and (select count(*) from probe_log) = 0,
  'the sale of the withdrawn source is hidden, and no ordinary trigger ran during the rewrite: they were suspended, as before'
);
update public.auction_sales set city = 'Alphaville' where source_url = 'https://www.licitor.com/pgtap-893-seul';
select is(
  (select count(*)::integer from probe_log), 1,
  'once the rewrite is done, the ordinary triggers run again'
);

-- Recalcul de catalogue_quarantined (lancé par le propriétaire) --------------------------------------------------------
-- Une dérive ne peut venir que d'une écriture faite déclencheurs suspendus.
create temporary table drift_suspended on commit drop as
  select app_private.suspend_ordinary_sale_triggers() as names;
update public.auction_sales set catalogue_quarantined = false
 where source_url = 'https://www.licitor.com/pgtap-893-seul';
select app_private.resume_ordinary_sale_triggers((select names from drift_suspended));

select is(
  app_private.repair_catalogue_quarantine_drift() >= 1, true,
  'the drift repair recomputes the rows in drift'
);
select is(
  app_private.fact_registry_triggers_not_always(), array[]::text[],
  'after the drift repair too, the triggers of the fact registry are still enabled always'
);
select is_empty(
  $$select before.tgname, before.tgenabled, after.tgenabled
      from triggers_before before
      left join pg_trigger after
        on after.tgrelid = 'public.auction_sales'::regclass and after.tgname = before.tgname
      where after.tgenabled is distinct from before.tgenabled$$,
  'and every trigger of auction_sales is back in the mode it had'
);

-- Les deux fonctions de suspension -------------------------------------------------------------------------------------
-- Un déclencheur déjà coupé avant la suspension n'est ni noté, ni rétabli ; un nom « aaab_ » reçu est ignoré.
alter table public.auction_sales disable trigger trg_record_auction_sale_timeline;
create temporary table suspended on commit drop as
  select app_private.suspend_ordinary_sale_triggers() as names;
select ok(
  (select not names && array[
            'aaab_auction_sales_hold_projected_fields', 'aaab_auction_sales_held_fields_insert_guard',
            'aaab_auction_sales_held_fields_role_guard', 'aaab_auction_sales_held_fields_marker_guard',
            'trg_record_auction_sale_timeline']::name[]
          and names @> array['trg_log_auction_sale_change']::name[]
     from suspended)
  and cardinality(app_private.fact_registry_triggers_not_always()) = 0
  and not exists (
    select 1 from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'),
  'the suspension switches off the ordinary-mode triggers by their name, never a trigger of the fact registry, and does not note a trigger that was already off'
);
select app_private.resume_ordinary_sale_triggers(
  (select names || array['aaab_auction_sales_hold_projected_fields', 'trg_record_auction_sale_timeline']::name[]
     from suspended)
);
select results_eq(
  $$select trigger_row.tgname::text collate "default", trigger_row.tgenabled::text collate "default"
      from pg_trigger trigger_row
      where trigger_row.tgrelid = 'public.auction_sales'::regclass and not trigger_row.tgisinternal
        and trigger_row.tgname in (
          'aaab_auction_sales_hold_projected_fields', 'trg_log_auction_sale_change',
          'trg_record_auction_sale_timeline')
      order by trigger_row.tgname::text collate "C"$$,
  $$values ('aaab_auction_sales_hold_projected_fields', 'A'), ('trg_log_auction_sale_change', 'O'),
           ('trg_record_auction_sale_timeline', 'O')$$,
  'the resumption puts back in ordinary mode the triggers named that are off, and leaves a trigger of the fact registry in its always mode even when it is named'
);
select is(
  (select count(*)::integer
     from unnest(array['public', 'anon', 'authenticated', 'service_role']) api_role(name)
     cross join unnest(array[
       'app_private.suspend_ordinary_sale_triggers()',
       'app_private.resume_ordinary_sale_triggers(name[])',
       'app_private.repair_catalogue_quarantine_drift()']) routine(signature)
     where has_function_privilege(api_role.name, routine.signature, 'EXECUTE')),
  0,
  'no API role executes the two suspension functions nor the drift repair'
);

-- Aucune fonction du dépôt ne coupe tous les déclencheurs d'une table ----------------------------------------------
-- (Double de l'invariant de texte, lu dans le catalogue ; portée : les schémas du dépôt, comme au test 887.)
select is_empty(
  $$select (namespace.nspname::text || '.' || routine.proname::text) collate "default"
      from pg_proc routine
      join pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname in ('public', 'app_private', 'licitor_ingestion')
        and routine.prokind in ('f', 'p')
        and routine.prosrc ~* 'trigger\s+(user|all)\M'
      order by (namespace.nspname::text || '.' || routine.proname::text) collate "C"$$,
  'no function of the repository schemas contains « trigger user » or « trigger all »: none can put the triggers of the fact registry out of their always mode'
);

-- Ni table fille, ni tâche planifiée ---------------------------------------------------------------------------------
select ok(
  not exists (
    select 1 from pg_inherits inheritance
    where inheritance.inhparent in (
            'public.auction_fact_fields'::regclass, 'public.auction_fact_source_precedence'::regclass,
            'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass,
            'public.auction_fact_claims'::regclass, 'app_private.fact_registry_switches'::regclass,
            'public.auction_sales'::regclass)
       or inheritance.inhrelid in (
            'public.auction_fact_fields'::regclass, 'public.auction_fact_source_precedence'::regclass,
            'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass,
            'public.auction_fact_claims'::regclass, 'app_private.fact_registry_switches'::regclass,
            'public.auction_sales'::regclass)),
  'no table of the fact registry, nor auction_sales, has a child or a parent table: no row enters them without their triggers'
);

-- pg_cron est absent de certaines bases locales : sans la table cron.job, il n'y a aucune tâche à lire. La table
-- n'est donc nommée que dans le texte d'une requête lancée si elle existe.
create function pg_temp.cron_jobs_deciding() returns integer
language plpgsql as $function$
declare
  v_jobs integer := 0;
begin
  if to_regclass('cron.job') is not null then
    execute $query$
      select count(*) from cron.job job
      where job.command ~* '(accept|reject|withdraw|oppose|decide)_auction_fact_claim|request\.jwt'
    $query$ into v_jobs;
  end if;
  return v_jobs;
end;
$function$;
select is(
  pg_temp.cron_jobs_deciding(), 0,
  'no pg_cron job names a decision function or the request token: a job runs as the owner of the database, without an administrator'
);

select * from finish();
rollback;
