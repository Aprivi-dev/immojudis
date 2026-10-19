begin;

set local lock_timeout = '5s';

-- Boîte d'envoi de l'invalidation du cache public après un retrait (point 4 du compte-rendu du
-- 18/10/2026). Quand une vente visible cesse de l'être (statut, quarantaine, date limite) ou qu'une
-- ligne visible est supprimée (fusion de doublons, purge), le déclencheur ci-dessous écrit son identifiant
-- ici, dans la même transaction que la modification : l'identifiant n'existe qu'après le COMMIT, et
-- aucun chemin d'écriture (collecte, rattrapage, fusion, réparation manuelle) ne peut l'oublier.
-- Le pipeline (python -m src.cache_invalidation --flush) lit cette table, appelle
-- POST /api/pipeline/revalidate-sale puis supprime les lignes dont l'appel a réussi.
--
-- À APPLIQUER HORS COLLECTE : CREATE TRIGGER prend un verrou SHARE ROW EXCLUSIVE sur auction_sales
-- jusqu'au COMMIT (les lectures continuent, les écritures attendent quelques millisecondes).
-- lock_timeout (5 s) fait échouer la migration sans effet si le verrou n'est pas obtenu : relancer.

create table if not exists app_private.catalogue_invalidations (
  id bigint generated always as identity primary key,
  sale_id uuid not null,
  at timestamptz not null default now()
);

comment on table app_private.catalogue_invalidations is
  'Boîte d''envoi : ventes qui ont quitté le catalogue public (ou lignes visibles supprimées), à purger du cache par src.cache_invalidation. Pas de clé étrangère : la ligne peut avoir été supprimée.';
comment on column app_private.catalogue_invalidations.sale_id is
  'Identifiant de la vente (auction_sales.id), éventuellement supprimée depuis.';
comment on column app_private.catalogue_invalidations.at is
  'Instant de la bascule de visibilité (début de la transaction).';

create index if not exists catalogue_invalidations_at_idx
  on app_private.catalogue_invalidations (at, id);

alter table app_private.catalogue_invalidations enable row level security;
revoke all on table app_private.catalogue_invalidations
  from public, anon, authenticated, service_role;
-- Le pipeline lit (for update skip locked) puis supprime ce qui a été transmis.
grant select, delete on table app_private.catalogue_invalidations to service_role;
drop policy if exists catalogue_invalidations_service_role_read on app_private.catalogue_invalidations;
create policy catalogue_invalidations_service_role_read
  on app_private.catalogue_invalidations
  for select to service_role
  using (true);
drop policy if exists catalogue_invalidations_service_role_delete on app_private.catalogue_invalidations;
create policy catalogue_invalidations_service_role_delete
  on app_private.catalogue_invalidations
  for delete to service_role
  using (true);

-- Visibilité publique d'une ligne, en colonnes seules : mêmes conditions que les vues et les fonctions
-- publiques depuis 20261027100200 (statut à venir, inconnu ou reporté ; hors quarantaine ; date limite
-- ou repli encore dans le futur).
create or replace function app_private.auction_sale_columns_are_catalogue_visible(
  p_status text,
  p_quarantined boolean,
  p_materialized boolean,
  p_deadline timestamptz,
  p_sale_date timestamptz,
  p_fallback_expiry timestamptz,
  p_state_observed_at timestamptz,
  p_state_end_estimate date
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(p_status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and not coalesce(p_quarantined, false)
    and app_private.sale_catalogue_projection_is_live(
      p_materialized, p_deadline, p_sale_date, p_fallback_expiry, p_state_observed_at,
      p_state_end_estimate
    );
$function$;

comment on function app_private.auction_sale_columns_are_catalogue_visible(text, boolean, boolean, timestamptz, timestamptz, timestamptz, timestamptz, date) is
  'Vrai quand une ligne de auction_sales est dans le catalogue public, lu sur des colonnes seules. Utilisé par le déclencheur de app_private.catalogue_invalidations.';

revoke all on function app_private.auction_sale_columns_are_catalogue_visible(
  text, boolean, boolean, timestamptz, timestamptz, timestamptz, timestamptz, date
) from public, anon, authenticated;
grant execute on function app_private.auction_sale_columns_are_catalogue_visible(
  text, boolean, boolean, timestamptz, timestamptz, timestamptz, timestamptz, date
) to service_role;

-- SECURITY DEFINER par nécessité : l'écriture dans auction_sales peut venir de n'importe quel rôle
-- (pipeline, fonctions du site), qui n'a aucun droit sur app_private.catalogue_invalidations. La
-- fonction n'accepte aucun argument, n'écrit qu'un identifiant et ne renvoie aucune donnée.
create or replace function app_private.queue_catalogue_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_was_visible boolean;
  v_is_visible boolean;
begin
  v_was_visible := app_private.auction_sale_columns_are_catalogue_visible(
    old.status, old.catalogue_quarantined, old.catalogue_expiry_materialized,
    old.catalogue_expiry_deadline, old.sale_date, old.catalogue_expiry_fallback,
    old.catalogue_state_observed_at, old.catalogue_state_end_estimate
  );
  if not v_was_visible then
    return null;
  end if;

  if tg_op = 'DELETE' then
    v_is_visible := false;
  else
    v_is_visible := app_private.auction_sale_columns_are_catalogue_visible(
      new.status, new.catalogue_quarantined, new.catalogue_expiry_materialized,
      new.catalogue_expiry_deadline, new.sale_date, new.catalogue_expiry_fallback,
      new.catalogue_state_observed_at, new.catalogue_state_end_estimate
    );
  end if;

  if not v_is_visible then
    insert into app_private.catalogue_invalidations (sale_id) values (old.id);
  end if;
  return null;
end;
$function$;

comment on function app_private.queue_catalogue_invalidation() is
  'Déclencheur AFTER UPDATE/DELETE de auction_sales : note dans app_private.catalogue_invalidations la vente qui quitte le catalogue public.';

revoke all on function app_private.queue_catalogue_invalidation()
  from public, anon, authenticated;
grant execute on function app_private.queue_catalogue_invalidation() to service_role;

-- Seules les colonnes qui décident de la visibilité réveillent le déclencheur : les autres écritures
-- (la grande majorité) ne coûtent rien. Il s'exécute après les déclencheurs BEFORE qui recalculent la
-- quarantaine et les colonnes de repli : NEW est la ligne définitive.
drop trigger if exists zzzzzz_auction_sales_catalogue_invalidation_update on public.auction_sales;
create trigger zzzzzz_auction_sales_catalogue_invalidation_update
  after update on public.auction_sales
  for each row
  when (
    old.status is distinct from new.status
    or old.catalogue_quarantined is distinct from new.catalogue_quarantined
    or old.catalogue_expiry_materialized is distinct from new.catalogue_expiry_materialized
    or old.catalogue_expiry_deadline is distinct from new.catalogue_expiry_deadline
    or old.sale_date is distinct from new.sale_date
    or old.catalogue_expiry_fallback is distinct from new.catalogue_expiry_fallback
    or old.catalogue_state_observed_at is distinct from new.catalogue_state_observed_at
    or old.catalogue_state_end_estimate is distinct from new.catalogue_state_end_estimate
  )
  execute function app_private.queue_catalogue_invalidation();

drop trigger if exists zzzzzz_auction_sales_catalogue_invalidation_delete on public.auction_sales;
create trigger zzzzzz_auction_sales_catalogue_invalidation_delete
  after delete on public.auction_sales
  for each row
  execute function app_private.queue_catalogue_invalidation();

commit;
