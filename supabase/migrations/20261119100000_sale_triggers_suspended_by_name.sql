begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2c, étape C0 (contre-vérification 3 du lot R2b, constat N3).
--
-- Deux fonctions antérieures au registre réécrivent des ventes en coupant TOUS les déclencheurs de auction_sales
-- (« disable trigger user » puis « enable trigger user ») :
--   * app_private.reproject_source_withdrawal(text) (20261021110000), appelée par le geste de retrait d'une source
--     (public.set_catalogue_source_withdrawal, service_role) ;
--   * app_private.repair_catalogue_quarantine_drift() (20261028110200), lancée à la main par le propriétaire.
-- Le second ordre remet tous les déclencheurs en mode ordinaire : les quatre déclencheurs « aaab_ » du registre,
-- posés en mode « always », quittent ce mode sans aucune erreur. Le contrôle des déclencheurs
-- (app_private.assert_fact_registry_triggers) refuse alors toute décision (55000 registry_unavailable) jusqu'au
-- fichier de maintenance supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql. Fermé, mais
-- un retrait de source rendait le registre indisponible.
--
-- Les deux fonctions ne suspendent plus que ce qu'elles veulent taire, par son nom, comme le rattrapage de
-- référence (supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql) : les déclencheurs de
-- auction_sales en mode ordinaire (tgenabled = 'O') dont le nom ne commence pas par « aaab_ ». Un déclencheur en
-- mode « always » n'est jamais touché. La règle est écrite une seule fois :
--   * app_private.suspend_ordinary_sale_triggers() coupe ces déclencheurs et rend leurs noms ;
--   * app_private.resume_ordinary_sale_triggers(noms) rétablit, parmi les noms reçus, ceux qui sont coupés et
--     hors registre, dans leur mode d'origine (ordinaire). Un nom « aaab_ » reçu est ignoré.
-- Ce sont les deux seules fonctions d'une migration à lancer du SQL assemblé depuis le lot R2b : leur corps est
-- épinglé par une empreinte dans scripts/check-security-invariants-fact-registry.mjs.
-- Le reste des deux fonctions réécrites est repris à l'identique (plan de mise à jour, verrou, droits).
--
-- Aucun contrôle des déclencheurs du registre n'est ajouté à ces fonctions : le retrait d'une source ne doit pas
-- dépendre de l'état du registre.
--
-- Verrous : remplacement et création de fonctions. Aucun verrou sur auction_sales à l'application. À l'exécution,
-- rien ne change : ALTER TABLE … DISABLE TRIGGER prenait déjà un verrou SHARE ROW EXCLUSIVE sur auction_sales
-- jusqu'à la fin de la transaction.
--
-- Retour arrière, par une nouvelle migration : rétablir les deux fonctions de 20261021110000 et de 20261028110200,
-- puis supprimer app_private.suspend_ordinary_sale_triggers() et
-- app_private.resume_ordinary_sale_triggers(name[]). À ne pas faire tant que le registre est en service.

-- 1. La règle, une seule fois --------------------------------------------------------------------------------------
create or replace function app_private.suspend_ordinary_sale_triggers()
returns name[]
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_trigger name;
  v_suspended name[] := array[]::name[];
begin
  for v_trigger in
    select trigger_row.tgname
      from pg_catalog.pg_trigger trigger_row
     where trigger_row.tgrelid = 'public.auction_sales'::pg_catalog.regclass
       and not trigger_row.tgisinternal
       and trigger_row.tgenabled = 'O'
       and trigger_row.tgname not like 'aaab\_%'
     order by trigger_row.tgname
  loop
    execute pg_catalog.format('alter table public.auction_sales disable trigger %I', v_trigger);
    v_suspended := v_suspended || v_trigger;
  end loop;
  return v_suspended;
end;
$$;

comment on function app_private.suspend_ordinary_sale_triggers() is
  'Coupe, par leur nom, les déclencheurs de auction_sales en mode ordinaire hors registre des pièces (jamais un déclencheur « aaab_ » ni un déclencheur en mode always) et rend leurs noms. À rétablir dans la même transaction par app_private.resume_ordinary_sale_triggers. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.suspend_ordinary_sale_triggers()
  from public, anon, authenticated, service_role;

create or replace function app_private.resume_ordinary_sale_triggers(p_triggers name[])
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_trigger name;
begin
  for v_trigger in
    select trigger_row.tgname
      from pg_catalog.pg_trigger trigger_row
     where trigger_row.tgrelid = 'public.auction_sales'::pg_catalog.regclass
       and not trigger_row.tgisinternal
       and trigger_row.tgenabled = 'D'
       and trigger_row.tgname not like 'aaab\_%'
       and trigger_row.tgname = any (p_triggers)
     order by trigger_row.tgname
  loop
    execute pg_catalog.format('alter table public.auction_sales enable trigger %I', v_trigger);
  end loop;
end;
$$;

comment on function app_private.resume_ordinary_sale_triggers(name[]) is
  'Rétablit en mode ordinaire, parmi les noms reçus, les déclencheurs de auction_sales qui sont coupés et hors registre des pièces (un nom « aaab_ » est ignoré). Pendant de app_private.suspend_ordinary_sale_triggers. Exécutable par aucun rôle de l''API.';

revoke all on function app_private.resume_ordinary_sale_triggers(name[])
  from public, anon, authenticated, service_role;

-- 2. Retrait d'une source (définition de 20261021110000, hormis la suspension des déclencheurs) ----------------------
create or replace function app_private.reproject_source_withdrawal(p_source text)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_withdrawn text[] := app_private.catalogue_withdrawn_sources();
  v_suspended name[];
  v_rows integer;
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  v_suspended := app_private.suspend_ordinary_sale_triggers();

  with plan as (
    select
      sale.id,
      case
        when coalesce(sale.raw_payload ->> 'publication_quarantine', '')
             not in ('', 'source_withdrawn')
          then sale.raw_payload ->> 'publication_quarantine'
        when app_private.sale_is_fully_withdrawn(sale.source_name, sale.observations, v_withdrawn)
          then 'source_withdrawn'
        else ''
      end as next_marker,
      coalesce(sale.raw_payload ->> 'publication_quarantine', '') as marker
    from public.auction_sales sale
    where sale.catalogue_quarantined
       or pg_catalog.lower(pg_catalog.btrim(sale.source_name)) = pg_catalog.lower(p_source)
  )
  update public.auction_sales sale
  set raw_payload = case
        when plan.next_marker = '' then coalesce(sale.raw_payload, '{}'::jsonb) - 'publication_quarantine'
        else coalesce(sale.raw_payload, '{}'::jsonb)
             || jsonb_build_object('publication_quarantine', plan.next_marker)
      end,
      catalogue_quarantined = plan.next_marker <> ''
  from plan
  where sale.id = plan.id
    and plan.next_marker is distinct from plan.marker;
  get diagnostics v_rows = row_count;

  perform app_private.resume_ordinary_sale_triggers(v_suspended);
  return v_rows;
end;
$function$;

revoke all on function app_private.reproject_source_withdrawal(text)
  from public, anon, authenticated;
grant execute on function app_private.reproject_source_withdrawal(text) to service_role;

-- 3. Recalcul de catalogue_quarantined (définition de 20261028110200, hormis la suspension des déclencheurs) ---------
create or replace function app_private.repair_catalogue_quarantine_drift()
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_ids uuid[];
  v_to_hidden integer;
  v_to_visible integer;
  v_suspended name[];
  v_updated integer := 0;
begin
  lock table public.auction_sales in share row exclusive mode;

  select
    pg_catalog.array_agg(drift.id),
    pg_catalog.count(*) filter (where drift.expected),
    pg_catalog.count(*) filter (where not drift.expected)
    into v_ids, v_to_hidden, v_to_visible
  from (
    select sale.id, app_private.catalogue_quarantine_from_payload(sale.raw_payload) as expected
    from public.auction_sales sale
    where sale.catalogue_quarantined
            is distinct from app_private.catalogue_quarantine_from_payload(sale.raw_payload)
  ) drift;

  if v_ids is null then
    return 0;
  end if;

  -- Projection de données existantes, pas un changement de vente : ni journal, ni relecture IA.
  v_suspended := app_private.suspend_ordinary_sale_triggers();

  update public.auction_sales sale
  set catalogue_quarantined = app_private.catalogue_quarantine_from_payload(sale.raw_payload)
  where sale.id = any (v_ids);
  get diagnostics v_updated = row_count;

  perform app_private.resume_ordinary_sale_triggers(v_suspended);

  raise notice 'catalogue_quarantined recalculé : % lignes (% masquées, % de nouveau publiques).',
    v_updated, v_to_hidden, v_to_visible;
  return v_updated;
end;
$function$;

revoke all on function app_private.repair_catalogue_quarantine_drift()
  from public, anon, authenticated, service_role;

commit;
