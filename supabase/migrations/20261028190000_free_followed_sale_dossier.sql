begin;

set local lock_timeout = '5s';

-- « Mon dossier » gratuit (point 68 de la session du 18/10/2026, validé le 19/10/2026).
--
-- Un compte, même Découverte, enregistre sur une vente qu'il suit (un favori) :
--   - son statut personnel, parmi les statuts déjà utilisés par l'espace de travail
--     (public.sale_workspaces.tracking_status : watching, reviewing, bidding, won, lost, archived) ;
--   - son enchère plafond, c'est-à-dire le résultat du calculateur existant (CeilingPlanner) au moment
--     où il l'enregistre, et la date de cet enregistrement.
--
-- Pourquoi user_favorites et pas sale_workspaces : l'espace de travail est un outil Analyse (politique
-- restrictive « analysis_access_required », collaboration, pièces) ; le favori est gratuit depuis
-- 20260909121649 (10 favoris, 20261028120100). Le stockage du statut et du plafond est gratuit ; les
-- outils d'analyse avancés (calculateur complet, scénarios, rapports, espace de travail) restent
-- Analyse ou ouverts par le déblocage d'une vente, comme avant. Aucun nouveau droit n'est donné aux
-- données de la vente : ce sont des valeurs que la personne écrit sur sa propre ligne.
--
-- Sécurité (RLS stricte) : les politiques de lecture et de suppression de user_favorites restent celles
-- de 20260614162839 (propriétaire seul). Une politique de mise à jour « propriétaire seul » s'ajoute, et
-- la mise à jour n'est accordée que COLONNE PAR COLONNE : un compte ne peut modifier ni user_id ni
-- sale_id (déplacer un favori), seulement personal_status et bid_ceiling_eur. Les dates d'enregistrement
-- ne sont pas écrites par le client : un déclencheur les pose.
--
-- Fusion de doublons : les lignes de user_favorites suivent déjà la fiche conservée
-- (20261028110000, UPDATE de sale_id : statut et plafond voyagent avec la ligne). Reste le cas où le
-- compte suivait AUSSI la fiche conservée : sa ligne en double disparaît avec la fiche supprimée. Un
-- déclencheur reporte alors son statut et son plafond sur la ligne conservée, quand celle-ci n'en a pas.

-- 1. Colonnes ----------------------------------------------------------------------------------------
alter table public.user_favorites
  add column if not exists personal_status text,
  add column if not exists personal_status_updated_at timestamptz,
  add column if not exists bid_ceiling_eur numeric,
  add column if not exists bid_ceiling_saved_at timestamptz;

comment on column public.user_favorites.personal_status is
  'Statut personnel du compte pour cette vente (mêmes valeurs que sale_workspaces.tracking_status). Null : aucun statut choisi. Gratuit, écrit par le propriétaire de la ligne.';
comment on column public.user_favorites.bid_ceiling_eur is
  'Enchère plafond calculée par le calculateur du site et enregistrée par le compte (euros, jamais déduite par le serveur). Null : aucun plafond enregistré.';
comment on column public.user_favorites.bid_ceiling_saved_at is
  'Date de l''enregistrement de bid_ceiling_eur ; posée par le déclencheur app_private.touch_favorite_dossier, jamais par le client.';
comment on column public.user_favorites.personal_status_updated_at is
  'Date du dernier changement de personal_status ; posée par le déclencheur app_private.touch_favorite_dossier.';

alter table public.user_favorites
  drop constraint if exists user_favorites_personal_status_check;
alter table public.user_favorites
  add constraint user_favorites_personal_status_check check (
    personal_status is null
    or personal_status in ('watching', 'reviewing', 'bidding', 'won', 'lost', 'archived')
  );

-- Même borne que les simulateurs (MAX_SIMULATOR_AMOUNT_EUR, src/lib/simulator-limits.ts).
alter table public.user_favorites
  drop constraint if exists user_favorites_bid_ceiling_check;
alter table public.user_favorites
  add constraint user_favorites_bid_ceiling_check check (
    bid_ceiling_eur is null
    or (bid_ceiling_eur >= 0 and bid_ceiling_eur <= 10000000000)
  );

alter table public.user_favorites
  drop constraint if exists user_favorites_bid_ceiling_date_check;
alter table public.user_favorites
  add constraint user_favorites_bid_ceiling_date_check check (
    (bid_ceiling_eur is null) = (bid_ceiling_saved_at is null)
  );

-- 2. Dates posées par la base ----------------------------------------------------------------------
create or replace function app_private.touch_favorite_dossier()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.personal_status_updated_at := case
      when new.personal_status is null then null else pg_catalog.now() end;
    new.bid_ceiling_saved_at := case
      when new.bid_ceiling_eur is null then null else pg_catalog.now() end;
    return new;
  end if;

  if new.personal_status is distinct from old.personal_status then
    new.personal_status_updated_at := case
      when new.personal_status is null then null else pg_catalog.now() end;
  else
    new.personal_status_updated_at := old.personal_status_updated_at;
  end if;

  if new.bid_ceiling_eur is distinct from old.bid_ceiling_eur then
    new.bid_ceiling_saved_at := case
      when new.bid_ceiling_eur is null then null else pg_catalog.now() end;
  else
    new.bid_ceiling_saved_at := old.bid_ceiling_saved_at;
  end if;
  return new;
end;
$$;

revoke all on function app_private.touch_favorite_dossier() from public, anon, authenticated;

drop trigger if exists touch_favorite_dossier on public.user_favorites;
create trigger touch_favorite_dossier
before insert or update on public.user_favorites
for each row execute function app_private.touch_favorite_dossier();

-- 3. Droits et RLS ----------------------------------------------------------------------------------
-- select, insert, delete restent accordés (20260527193000). La mise à jour est limitée à deux colonnes.
grant update (personal_status, bid_ceiling_eur) on table public.user_favorites to authenticated;

drop policy if exists favorites_update_own on public.user_favorites;
create policy favorites_update_own on public.user_favorites
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 4. Fusion de doublons -----------------------------------------------------------------------------
-- Avant la suppression d'une fiche fusionnée : si le compte suivait aussi la fiche conservée, son statut
-- et son plafond passent sur cette ligne quand elle n'a pas les siens. Rien n'est écrasé. Le transfert
-- des lignes sans doublon est fait par app_private.carry_sale_user_data_to_merged_sale (UPDATE de
-- sale_id) ; les deux déclencheurs ne se gênent pas.
create or replace function app_private.carry_favorite_dossier_to_merged_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  select merged.id
    into v_target
  from public.auction_sales merged
  where merged.id <> old.id
    and jsonb_typeof(merged.source_urls) = 'array'
    and merged.source_urls ? old.source_url
  order by merged.updated_at desc nulls last, merged.id
  limit 1;

  if v_target is null then
    return old;
  end if;

  update public.user_favorites kept
     set personal_status = coalesce(kept.personal_status, duplicate.personal_status),
         bid_ceiling_eur = coalesce(kept.bid_ceiling_eur, duplicate.bid_ceiling_eur)
    from public.user_favorites duplicate
   where duplicate.sale_id = old.id
     and kept.sale_id = v_target
     and kept.user_id = duplicate.user_id
     and (
       (kept.personal_status is null and duplicate.personal_status is not null)
       or (kept.bid_ceiling_eur is null and duplicate.bid_ceiling_eur is not null)
     );

  return old;
end;
$$;

revoke all on function app_private.carry_favorite_dossier_to_merged_sale()
  from public, anon, authenticated;

drop trigger if exists auction_sales_carry_favorite_dossier on public.auction_sales;
create trigger auction_sales_carry_favorite_dossier
before delete on public.auction_sales
for each row execute function app_private.carry_favorite_dossier_to_merged_sale();

comment on function app_private.carry_favorite_dossier_to_merged_sale() is
  'Avant la suppression d''une fiche fusionnée : reporte le statut et le plafond d''un favori en double sur le favori de la fiche conservée, s''il n''en a pas.';

notify pgrst, 'reload schema';

commit;
