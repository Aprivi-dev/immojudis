begin;

set local lock_timeout = '5s';

-- Retrait de la source Licitor du catalogue, tant qu'il n'existe pas de licence écrite
-- (droit sui generis des bases de données, CPI L. 341-1 et L. 342-1). Décision du propriétaire.
--
-- UN SEUL INTERRUPTEUR : public.auction_source_state.catalogue_withdrawn, posé et levé par
--   select public.set_catalogue_source_withdrawal('licitor', true,  'raison');   -- retirer
--   select public.set_catalogue_source_withdrawal('licitor', false);             -- lever
-- (service_role seulement, une seule transaction). Il commande à la fois :
--   - la collecte : une source retirée est aussi « enabled = false » (contrainte ci-dessous), donc le
--     planificateur ne la lance plus, la file d'enrichissement ne rouvre plus ses fiches détail et
--     l'observateur ferme l'alerte pipeline.source.<source>.missed au lieu de la rouvrir en boucle ;
--   - le catalogue : une vente dont TOUTES les sources sont retirées reçoit le marqueur de
--     quarantaine existant raw_payload->>'publication_quarantine' = 'source_withdrawn'. Toutes les
--     vues et fonctions du catalogue (public, connecté, recherche, carte, comptages, sitemap, fiche
--     publique, alertes) le respectent déjà : aucune vue ni fonction de lecture n'est réécrite.
-- Aucune ligne n'est supprimée : lever l'interrupteur retire le marqueur et remet la vente à l'affichage.
-- Une vente fusionnée avec une autre source (observations) reste visible ; son contenu propre à la
-- source retirée (liens, photos, pièces) est masqué par le site (src/lib/withdrawn-sources.ts).

-- 1. L'interrupteur.
alter table public.auction_source_state
  add column if not exists catalogue_withdrawn boolean not null default false,
  add column if not exists withdrawn_reason text,
  add column if not exists withdrawn_at timestamptz;

comment on column public.auction_source_state.catalogue_withdrawn is
  'Interrupteur de retrait : true = plus de collecte et ventes de cette seule source masquées du catalogue. Se pose et se lève avec public.set_catalogue_source_withdrawal.';

-- Une source retirée ne peut pas être réactivée à la main (écran d'administration, update direct) :
-- il faut lever le retrait d'abord.
alter table public.auction_source_state
  drop constraint if exists auction_source_state_withdrawn_not_enabled;
alter table public.auction_source_state
  add constraint auction_source_state_withdrawn_not_enabled
  check (not (catalogue_withdrawn and enabled));

-- 2. Lecture de l'interrupteur.
create or replace function app_private.catalogue_withdrawn_sources()
returns text[]
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    array_agg(pg_catalog.lower(state.source_name) order by state.source_name),
    '{}'::text[]
  )
  from public.auction_source_state state
  where state.catalogue_withdrawn;
$function$;

revoke all on function app_private.catalogue_withdrawn_sources()
  from public, anon, authenticated;
grant execute on function app_private.catalogue_withdrawn_sources()
  to anon, authenticated, service_role;

create or replace function public.get_withdrawn_catalogue_sources()
returns text[]
language sql
stable
set search_path = ''
as $function$
  select app_private.catalogue_withdrawn_sources();
$function$;

revoke all on function public.get_withdrawn_catalogue_sources() from public;
grant execute on function public.get_withdrawn_catalogue_sources()
  to anon, authenticated, service_role;

comment on function public.get_withdrawn_catalogue_sources() is
  'Sources retirées du catalogue (interrupteur auction_source_state.catalogue_withdrawn). Lu par le site pour masquer le contenu d''une source retirée dans une vente fusionnée.';

-- 3. Une vente est « entièrement retirée » quand sa source principale et toutes ses observations
--    viennent de sources retirées. Une ligne sans observation compte pour une seule source (elle est
--    masquée : c'est le sens sûr en cas de doute).
create or replace function app_private.sale_is_fully_withdrawn(
  p_source_name text,
  p_observations jsonb,
  p_withdrawn text[]
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select coalesce(cardinality(p_withdrawn), 0) > 0
    and coalesce(pg_catalog.lower(pg_catalog.btrim(p_source_name)) = any (p_withdrawn), false)
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(p_observations) = 'array' then p_observations
          else '[]'::jsonb
        end
      ) as observation(value)
      where coalesce(
        nullif(pg_catalog.lower(pg_catalog.btrim(observation.value ->> 'source_name')), ''),
        pg_catalog.lower(pg_catalog.btrim(p_source_name))
      ) <> all (p_withdrawn)
    );
$function$;

revoke all on function app_private.sale_is_fully_withdrawn(text, jsonb, text[])
  from public, anon, authenticated;
grant execute on function app_private.sale_is_fully_withdrawn(text, jsonb, text[])
  to service_role;

-- 4. Écriture : une vente entièrement retirée porte toujours le marqueur, même quand une collecte
--    ou une réparation réécrit raw_payload. Même schéma que les autres gardes (le marqueur n'est posé
--    que s'il est vide, et retiré seulement s'il est le sien). Le nom « zzz_ » le place avant la
--    projection du catalogue (« zzzz_ »), qui en déduit alors catalogue_quarantined.
create or replace function app_private.enforce_source_withdrawal_quarantine()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_marker text := coalesce(new.raw_payload ->> 'publication_quarantine', '');
  v_hidden boolean;
begin
  -- Une autre garde (relecture IA, fiche exclue…) possède ce marqueur : on n'y touche pas.
  if v_marker not in ('', 'source_withdrawn') then
    return new;
  end if;

  v_hidden := app_private.sale_is_fully_withdrawn(
    new.source_name,
    new.observations,
    app_private.catalogue_withdrawn_sources()
  );

  if v_hidden and v_marker = '' then
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb)
      || jsonb_build_object('publication_quarantine', 'source_withdrawn');
  elsif not v_hidden and v_marker = 'source_withdrawn' then
    new.raw_payload := new.raw_payload - 'publication_quarantine';
  end if;
  return new;
end;
$function$;

revoke all on function app_private.enforce_source_withdrawal_quarantine()
  from public, anon, authenticated;

drop trigger if exists zzz_auction_sales_source_withdrawal on public.auction_sales;
create trigger zzz_auction_sales_source_withdrawal
  before insert or update on public.auction_sales
  for each row execute function app_private.enforce_source_withdrawal_quarantine();

-- 5. Le geste : pose ou lève le retrait d'une source, puis recalcule les ventes concernées.
--    Même méthode que le remplissage de catalogue_quarantined (20261009180000) : projection de
--    données existantes, pas un changement de vente, donc sans déclencher le journal des ventes, la
--    relecture IA ni les contrôles de source (alter table ... disable trigger user, annulé en fin
--    de transaction). Un verrou occupé au-delà de 5 s fait échouer tout le geste, sans effet partiel.
create or replace function app_private.reproject_source_withdrawal(p_source text)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_withdrawn text[] := app_private.catalogue_withdrawn_sources();
  v_rows integer;
begin
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  alter table public.auction_sales disable trigger user;

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

  alter table public.auction_sales enable trigger user;
  return v_rows;
end;
$function$;

revoke all on function app_private.reproject_source_withdrawal(text)
  from public, anon, authenticated;
grant execute on function app_private.reproject_source_withdrawal(text) to service_role;

create or replace function public.set_catalogue_source_withdrawal(
  p_source text,
  p_withdrawn boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_rows integer;
begin
  if p_source is null or p_withdrawn is null then
    raise exception using errcode = '22023', message = 'source and withdrawn are required.';
  end if;

  update public.auction_source_state state
  set enabled = case
        when p_withdrawn then false
        when state.catalogue_withdrawn then true
        else state.enabled
      end,
      suspension_reason = case
        when p_withdrawn then coalesce(v_reason, state.withdrawn_reason, 'Source retirée du catalogue')
        when state.catalogue_withdrawn then null
        else state.suspension_reason
      end,
      suspended_until = case when state.catalogue_withdrawn and not p_withdrawn then null else state.suspended_until end,
      withdrawn_reason = case
        when p_withdrawn then coalesce(v_reason, state.withdrawn_reason, 'Source retirée du catalogue')
        else null
      end,
      withdrawn_at = case when p_withdrawn then coalesce(state.withdrawn_at, pg_catalog.now()) else null end,
      catalogue_withdrawn = p_withdrawn,
      updated_at = pg_catalog.now()
  where state.source_name = p_source;
  if not found then
    raise exception using errcode = 'P0002', message = format('Unknown source: %s', p_source);
  end if;

  v_rows := app_private.reproject_source_withdrawal(p_source);
  return jsonb_build_object('source', p_source, 'withdrawn', p_withdrawn, 'sales_reprojected', v_rows);
end;
$function$;

revoke all on function public.set_catalogue_source_withdrawal(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_catalogue_source_withdrawal(text, boolean, text)
  to service_role;

comment on function public.set_catalogue_source_withdrawal(text, boolean, text) is
  'Pose (true) ou lève (false) le retrait d''une source : arrête ou reprend sa collecte (enabled) et masque ou remet à l''affichage les ventes dont c''est la seule source. Aucune donnée supprimée.';

-- 6. État livré : Licitor est RETIRÉ (pas de licence écrite). Lever le retrait est un geste explicite :
--    select public.set_catalogue_source_withdrawal('licitor', false);
select public.set_catalogue_source_withdrawal(
  'licitor',
  true,
  'Pas de licence écrite : droit sui generis des bases de données (CPI L. 341-1 et L. 342-1)'
)
where exists (select 1 from public.auction_source_state where source_name = 'licitor');

notify pgrst, 'reload schema';

commit;
