-- Purge des ventes bloquée par la mesure (point 1 de la session du 20/10/2026, chantier W1).
--
-- Défaut : l'index unique account_product_events_once_per_day_idx (20261028180000) porte sur
-- (compte, type, détail, coalesce(vente, 0…0), jour UTC) et la clé étrangère sale_id est « on delete set
-- null ». Deux événements du même compte, du même type et du même jour sur deux ventes A et B : la
-- suppression de A met le premier à null, la suppression de B met le second à null avec la MÊME clé
-- (…, 0…0, jour) : violation d'unicité, la suppression de B échoue, et purge_expired_auction_sales (lot de
-- 25, sans exception par vente) échoue en entier. La mesure bloquait la rétention du catalogue.
--
-- Choix : on garde « on delete set null » (la ligne de mesure est gardée, détachée de la vente) et on
-- supprime la cause de la collision : un événement détaché ne participe plus à aucune unicité.
--   * account_product_events_once_per_day_sale_idx : un événement par compte, type, détail, vente et jour
--     UTC, seulement quand sale_id n'est pas null. Quand la vente disparaît, la ligne sort de l'index :
--     la mise à null ne peut plus entrer en collision, quel que soit le nombre de ventes supprimées.
--   * account_product_events_once_per_day_quota_idx : un quota atteint par compte, détail et jour UTC.
--     Un quota n'a jamais de vente (contrainte account_product_events_quota_without_sale_check), donc ses
--     lignes ne sont jamais touchées par la mise à null.
-- Les autres événements (déblocage, plafond, export agenda, clic d'email) désignent toujours une vente :
-- record_account_product_event refuse désormais qu'ils n'en aient pas (sinon ils échapperaient à toute
-- unicité). Un CHECK ne convient pas : la mise à null faite par la clé étrangère le violerait.
--
-- Pourquoi pas « on delete cascade » : admin_pilotage_summary compte les événements des 30 derniers jours
-- sans regarder la vente. Avec cascade, chaque vente purgée à l'heure de son audience emporterait ses
-- événements, et les compteurs de la page « Pilotage » baisseraient à chaque purge (mesure biaisée à la
-- baisse, d'autant plus que les ventes sont courtes). Avec set null, les compteurs restent exacts.
--
-- Les deux nouveaux index sont plus étroits que l'ancien : toute table qui respectait l'ancien les
-- respecte, la création ne peut pas échouer sur des données existantes. L'ancien est supprimé après.
-- record_account_product_event garde « on conflict do nothing » sans cible : il arbitre sur n'importe
-- lequel des deux index (et sur la clé primaire).
--
-- Dans la même série : la capture d'instantané d'une vente suivie (déclencheur avant suppression) ne
-- peut plus bloquer la purge, et ne copie plus le code postal (inutile à l'affichage).
begin;

set local lock_timeout = '5s';

-- 1. Arbitres de l'unicité quotidienne ----------------------------------------------------------------
create unique index if not exists account_product_events_once_per_day_sale_idx
  on public.account_product_events (
    user_id,
    event_type,
    (coalesce(detail, '')),
    sale_id,
    ((occurred_at at time zone 'UTC')::date)
  )
  where sale_id is not null;

create unique index if not exists account_product_events_once_per_day_quota_idx
  on public.account_product_events (
    user_id,
    detail,
    ((occurred_at at time zone 'UTC')::date)
  )
  where sale_id is null and event_type = 'quota_reached';

drop index if exists public.account_product_events_once_per_day_idx;

-- 2. Enregistrement ------------------------------------------------------------------------------------
-- Même corps que 20261028180000, plus le refus d'un événement de vente sans vente : il ne serait
-- arbitré par aucun index, et un rechargement le compterait deux fois.
create or replace function public.record_account_product_event(
  p_user_id uuid,
  p_event_type text,
  p_detail text default null,
  p_sale_id uuid default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserted integer;
begin
  if p_user_id is null then
    raise exception using errcode = '22004', message = 'Account is required.';
  end if;
  if p_sale_id is null and p_event_type is distinct from 'quota_reached' then
    raise exception using errcode = '23514', message = 'This event needs a sale.';
  end if;

  insert into public.account_product_events (user_id, event_type, detail, sale_id)
  values (p_user_id, p_event_type, p_detail, p_sale_id)
  on conflict do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;

revoke all on function public.record_account_product_event(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_account_product_event(uuid, text, text, uuid)
  to service_role;

comment on function public.record_account_product_event(uuid, text, text, uuid) is
  'Enregistre un événement produit pour un compte (service_role seul). Un seul par compte, type, détail, vente et jour UTC ; une vente est requise sauf pour un quota atteint.';

-- 3. Capture d'instantané qui ne bloque jamais la purge ----------------------------------------------
-- Même corps que 20261028190100, avec deux changements : l'insertion de capture est isolée dans un
-- sous-bloc (une capture ratée est journalisée et la vente est supprimée quand même), et le code postal
-- n'est plus copié (la colonne reste, nulle : l'affichage n'en a pas besoin).
create or replace function app_private.snapshot_followed_sale_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_price numeric := case when old.adjudication_price_eur > 0 then old.adjudication_price_eur end;
  v_licitor boolean;
  v_tribunal_name text;
begin
  -- Audience passée seulement, vente maintenue, jamais une fusion de doublons.
  if old.sale_date is null
    or old.sale_date > pg_catalog.now()
    or coalesce(old.status, '') in ('postponed', 'cancelled', 'withdrawn', 'quarantined')
    or coalesce(old.catalogue_quarantined, false)
    or exists (
      select 1 from app_private.auction_sale_merges merged where merged.old_sale_id = old.id
    )
    or not exists (select 1 from public.user_favorites followed where followed.sale_id = old.id)
  then
    return old;
  end if;

  -- Sous-bloc : l'instantané est un service rendu au compte, jamais une condition de la rétention. Une
  -- erreur ici (contrainte, droit, donnée inattendue) annule seulement la capture. Le message d'erreur
  -- n'est pas journalisé : il peut citer la ligne copiée (compte, titre).
  begin
    v_licitor := pg_catalog.lower(coalesce(old.source_name, '')) like '%licitor%'
      or pg_catalog.lower(coalesce(old.source_url, '')) like '%licitor%'
      or pg_catalog.lower(coalesce(old.source_urls::text, '')) like '%licitor%'
      or pg_catalog.lower(coalesce(old.observations::text, '')) like '%licitor%';

    v_tribunal_name := coalesce(
      (
        select nullif(pg_catalog.btrim(tribunal.canonical_name), '')
        from public.tribunals tribunal
        where tribunal.code = old.tribunal_code
      ),
      old.tribunal
    );

    insert into public.user_followed_sale_snapshots (
      user_id, sale_id, captured_at, expires_at,
      title, city, department, property_type, tribunal_name,
      sale_venue_type, sale_legal_framework, starting_price_eur, sale_date, lawyer_name, source_name,
      result_status, adjudication_price_eur, adjudication_price_source, adjudication_price_withheld,
      personal_status, bid_ceiling_eur
    )
    select
      followed.user_id, old.id, pg_catalog.now(),
      pg_catalog.now() + app_private.followed_sale_snapshot_retention(),
      old.title, old.city, old.department, old.property_type, v_tribunal_name,
      old.sale_venue_type, old.sale_legal_framework, old.starting_price_eur, old.sale_date,
      old.lawyer_name, old.source_name,
      case when old.status = 'adjudicated' or v_price is not null then 'adjudicated' else 'unknown' end,
      case when v_price is not null and not v_licitor and access.granted then v_price end,
      case when v_price is not null and not v_licitor and access.granted then old.source_name end,
      (v_price is not null and not v_licitor and not access.granted),
      followed.personal_status, followed.bid_ceiling_eur
    from public.user_favorites followed
    cross join lateral (
      select app_private.has_active_analysis_access(followed.user_id) as granted
    ) access
    where followed.sale_id = old.id
    on conflict (user_id, sale_id) do nothing;
  exception when others then
    raise warning 'snapshot_followed_sale_before_delete: capture skipped for sale % (SQLSTATE %)',
      old.id, sqlstate;
  end;

  return old;
end;
$$;

revoke all on function app_private.snapshot_followed_sale_before_delete()
  from public, anon, authenticated;

comment on function app_private.snapshot_followed_sale_before_delete() is
  'Avant la suppression d''une vente dont l''audience est passée : garde un instantané par compte qui la suivait (données clés sans code postal, résultat publié, statut et plafond personnels). Jamais pour une fusion, une vente reportée, annulée, retirée ou en quarantaine ; jamais de prix issu de Licitor. Une capture qui échoue est journalisée et ne bloque pas la suppression.';

notify pgrst, 'reload schema';

commit;
