begin;

set local lock_timeout = '5s';

-- Point 13 de la session du 18/10/2026 : aligner catalogue_quarantined sur les trois clés de quarantaine.
--
-- Côté pipeline (services/data-pipeline/src/admission.py, _QUARANTINE_PAYLOAD_KEYS), une vente est en
-- quarantaine si l'une de ces trois clés de raw_payload est « vraie » : publication_quarantine,
-- publication_identity_conflict (posée par hold_identity, publication_identity.py) et
-- source_identity_mismatch. La colonne catalogue_quarantined, qui décide de la visibilité publique depuis
-- 20261027100200, ne lisait que la première. Une vente dont seule publication_identity_conflict ou
-- source_identity_mismatch est posée n'était masquée que par son statut, quand il est 'quarantined'.
--
-- Cette migration (suppose 20261027100000 à 20261027100200) :
--   1. pose app_private.catalogue_quarantine_from_payload(raw_payload), la règle unique : même « vérité »
--      que Python (absent, null, '', false, 0, [] et {} ne comptent pas) ;
--   2. redéfinit les deux fonctions de projection qui posent la colonne (app_private.sync_auction_sale_catalogue_projection,
--      20261009180000, et app_private.sync_auction_sale_catalogue_visibility, 20261027100100) pour qu'elles
--      l'utilisent, en gardant leurs réglages (security invoker, search_path vide, droits d'exécution) : la
--      migration échoue, sans effet, si l'un d'eux change ;
--   3. pose app_private.repair_catalogue_quarantine_drift(), qui recalcule la colonne des seules lignes en
--      dérive sans déclencher le journal des ventes ni la relecture IA (même méthode que le rattrapage de
--      20261027100100), puis l'exécute une fois ici.
--
-- EFFET SUR LA VISIBILITÉ. Les lignes qui portent publication_identity_conflict ou source_identity_mismatch
-- sans publication_quarantine, et dont le statut n'est pas 'quarantined', quittent le catalogue public à
-- l'application. Les compter AVANT (requête dans docs/runbooks/catalogue-visibility-projection.md). Le
-- rattrapage désactive les déclencheurs utilisateur : une bascule qu'il provoque ne passe pas par eux (le
-- cache public se renouvelle alors à son échéance).
--
-- À APPLIQUER HORS COLLECTE : verrou SHARE ROW EXCLUSIVE sur auction_sales pendant le rattrapage (lecture de
-- raw_payload de toutes les lignes, de l'ordre de 2 s). lock_timeout (5 s) la fait échouer sans effet si le
-- verrou n'est pas obtenu : relancer hors collecte. Rejouable.

-- 1. La règle ------------------------------------------------------------------------------------------
create or replace function app_private.catalogue_quarantine_from_payload(p_raw jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  -- Les trois clés de _QUARANTINE_PAYLOAD_KEYS (src/admission.py). Un test (test_catalogue_quarantine_keys)
  -- vérifie que cette liste et celle de Python restent égales. « Vrai » comme en Python : une chaîne non
  -- vide, true, un nombre non nul, un tableau ou un objet non vide.
  select exists (
    select 1
    from unnest(array[
      'publication_quarantine',
      'publication_identity_conflict',
      'source_identity_mismatch'
    ]) as quarantine_key(name)
    where case pg_catalog.jsonb_typeof(p_raw -> quarantine_key.name)
      when 'string' then (p_raw ->> quarantine_key.name) <> ''
      when 'boolean' then (p_raw -> quarantine_key.name) = 'true'::jsonb
      when 'number' then (p_raw -> quarantine_key.name) <> '0'::jsonb
      when 'array' then (p_raw -> quarantine_key.name) <> '[]'::jsonb
      when 'object' then (p_raw -> quarantine_key.name) <> '{}'::jsonb
      else false
    end
  );
$function$;

comment on function app_private.catalogue_quarantine_from_payload(jsonb) is
  'Vrai si une des clés publication_quarantine, publication_identity_conflict ou source_identity_mismatch de raw_payload est vraie (même règle que _QUARANTINE_PAYLOAD_KEYS côté pipeline). Source de catalogue_quarantined.';

revoke all on function app_private.catalogue_quarantine_from_payload(jsonb)
  from public, anon, authenticated;
grant execute on function app_private.catalogue_quarantine_from_payload(jsonb) to service_role;

-- 2. Les deux déclencheurs de projection ------------------------------------------------------------
-- sync_auction_sale_catalogue_projection (20261009180000, colonne + vignette) puis
-- sync_auction_sale_catalogue_visibility (20261027100100, qui s'exécute après et a le dernier mot) posent
-- tous deux catalogue_quarantined : les deux lisent la règle unique. Les réglages de chaque fonction sont
-- relevés avant et vérifiés après ; la migration échoue, sans effet, si l'un d'eux change.
create temporary table catalogue_quarantine_functions_before on commit drop as
select
  procedure_row.oid::regprocedure::text as signature,
  procedure_row.prosecdef,
  procedure_row.proconfig,
  procedure_row.proacl::text as proacl
from pg_catalog.pg_proc procedure_row
where procedure_row.oid in (
  'app_private.sync_auction_sale_catalogue_projection()'::regprocedure,
  'app_private.sync_auction_sale_catalogue_visibility()'::regprocedure
);

create or replace function app_private.sync_auction_sale_catalogue_projection()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.catalogue_quarantined :=
    app_private.catalogue_quarantine_from_payload(new.raw_payload);
  new.catalogue_thumbnail_url :=
    case
      when new.raw_payload ->> 'raw_image_url' ~* '^https?://'
        and length(new.raw_payload ->> 'raw_image_url') <= 2048
        then new.raw_payload ->> 'raw_image_url'
    end;
  return new;
end;
$function$;

create or replace function app_private.sync_auction_sale_catalogue_visibility()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_projection record;
begin
  new.catalogue_quarantined :=
    app_private.catalogue_quarantine_from_payload(new.raw_payload);

  select projection.*
    into v_projection
    from app_private.catalogue_visibility_projection(
      new.catalogue_expiry_materialized,
      new.catalogue_expiry_deadline,
      new.sale_date,
      new.raw_payload,
      new.sale_procedure
    ) projection;
  new.catalogue_expiry_fallback := v_projection.expiry;
  new.catalogue_state_observed_at := v_projection.state_observed_at;
  new.catalogue_state_end_estimate := v_projection.state_end_estimate;
  return new;
end;
$function$;

do $guard$
declare
  v_before record;
  v_after record;
begin
  for v_before in select * from catalogue_quarantine_functions_before loop
    select
      procedure_row.prosecdef,
      procedure_row.proconfig,
      procedure_row.proacl::text as proacl
      into v_after
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = v_before.signature::regprocedure;

    if v_before.prosecdef or v_after.prosecdef then
      raise exception '% must stay SECURITY INVOKER.', v_before.signature;
    end if;
    if v_after.proconfig is distinct from v_before.proconfig
       or v_after.proconfig is distinct from array['search_path=""']::text[] then
      raise exception '% lost its empty search_path (before: %, after: %).',
        v_before.signature, v_before.proconfig, v_after.proconfig;
    end if;
    if v_after.proacl is distinct from v_before.proacl then
      raise exception '% changed its execution rights (before: %, after: %).',
        v_before.signature, v_before.proacl, v_after.proacl;
    end if;
  end loop;

  if (
    select count(*)
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass
      and trigger_row.tgfoid in (
        'app_private.sync_auction_sale_catalogue_projection()'::regprocedure,
        'app_private.sync_auction_sale_catalogue_visibility()'::regprocedure
      )
      and not trigger_row.tgisinternal
  ) <> 4 then
    raise exception 'The catalogue projection and visibility triggers (insert, update each) must still be attached.';
  end if;
end;
$guard$;

-- 3. Recalcul des lignes en dérive ------------------------------------------------------------------
-- Rejouable à tout moment (runbook catalogue-visibility-projection) : renvoie le nombre de lignes corrigées.
-- Prend un verrou SHARE ROW EXCLUSIVE sur auction_sales et lit raw_payload de toutes les lignes : hors pointe.
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
  alter table public.auction_sales disable trigger user;

  update public.auction_sales sale
  set catalogue_quarantined = app_private.catalogue_quarantine_from_payload(sale.raw_payload)
  where sale.id = any (v_ids);
  get diagnostics v_updated = row_count;

  alter table public.auction_sales enable trigger user;

  raise notice 'catalogue_quarantined recalculé : % lignes (% masquées, % de nouveau publiques).',
    v_updated, v_to_hidden, v_to_visible;
  return v_updated;
end;
$function$;

comment on function app_private.repair_catalogue_quarantine_drift() is
  'Recalcule catalogue_quarantined des lignes dont la valeur diffère de app_private.catalogue_quarantine_from_payload(raw_payload), sans déclencher les triggers utilisateur. Hors pointe (verrou SHARE ROW EXCLUSIVE).';

revoke all on function app_private.repair_catalogue_quarantine_drift()
  from public, anon, authenticated, service_role;

select app_private.repair_catalogue_quarantine_drift();

commit;
