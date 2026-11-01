begin;

set local lock_timeout = '5s';

-- Bilan après adjudication (n° 94 de la session du 31/10/2026, validé le 31/10/2026).
--
-- Un compte peut noter, à titre facultatif et pour lui seul, le prix final de l'adjudication d'une vente
-- qu'il a suivie, quand il l'a marquée « Remporté » (won) ou « Non remporté » (lost). Ce prix sert à son
-- bilan personnel (écart avec son enchère plafond) ; il n'est jamais envoyé par email et n'alimente ni
-- le catalogue, ni les statistiques de prix, ni aucune autre personne. C'est une donnée personnelle de
-- nature financière : voir docs/rgpd-processing-register.md et docs/data-retention-matrix.md.
--
-- Où : sur l'instantané de la vente suivie (public.user_followed_sale_snapshots, 20261028190100) et non
-- sur le favori. Une vente est supprimée du catalogue à l'heure de son audience, et le favori avec elle
-- (on delete cascade) ; le résultat n'est connu qu'après. Le favori n'existe donc plus quand la personne
-- a quelque chose à noter : l'instantané, conservé 6 mois au plus (followed_sale_snapshot_retention) puis
-- purgé avec son contenu, est le seul endroit où le bilan puisse vivre. L'effacement du compte l'emporte
-- (on delete cascade).
--
-- Sécurité (RLS stricte) : les politiques de lecture et de suppression ne changent pas (propriétaire
-- seul). L'instantané n'était modifiable par personne ; le propriétaire peut désormais modifier deux
-- colonnes, COLONNE PAR COLONNE, et rien d'autre (ni user_id, ni sale_id, ni le résultat publié, ni les
-- dates) :
--   - personal_status (mêmes valeurs que public.user_favorites, contrainte déjà en place) ;
--   - final_price_eur (nouvelle colonne).
-- Une politique de mise à jour « propriétaire seul » est ajoutée. Un déclencheur remet le prix final à
-- null dès que le statut n'est plus won ou lost : un prix ne survit pas à un statut qui ne le justifie
-- plus.

-- 1. Colonne -----------------------------------------------------------------------------------------
alter table public.user_followed_sale_snapshots
  add column if not exists final_price_eur numeric;

comment on column public.user_followed_sale_snapshots.final_price_eur is
  'Prix final de l''adjudication noté par le compte (euros), facultatif, seulement quand personal_status vaut won ou lost (remis à null sinon par app_private.clear_final_price_unless_result). Distinct de adjudication_price_eur (prix publié sur la fiche). Donnée personnelle du compte : jamais envoyée par email.';

-- Même borne que bid_ceiling_eur (MAX_SIMULATOR_AMOUNT_EUR, src/lib/simulator-limits.ts) ; au moins 1 €.
alter table public.user_followed_sale_snapshots
  drop constraint if exists user_followed_sale_snapshots_final_price_check;
alter table public.user_followed_sale_snapshots
  add constraint user_followed_sale_snapshots_final_price_check check (
    final_price_eur is null or (final_price_eur >= 1 and final_price_eur <= 10000000000)
  );

-- 2. Le prix final ne vit qu'avec un résultat -----------------------------------------------------------
create or replace function app_private.clear_final_price_unless_result()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.final_price_eur is not null
    and new.personal_status is distinct from 'won'
    and new.personal_status is distinct from 'lost'
  then
    new.final_price_eur := null;
  end if;
  return new;
end;
$$;

revoke all on function app_private.clear_final_price_unless_result()
  from public, anon, authenticated;

comment on function app_private.clear_final_price_unless_result() is
  'Remet final_price_eur à null quand le statut personnel de l''instantané n''est ni won ni lost.';

drop trigger if exists clear_final_price_unless_result on public.user_followed_sale_snapshots;
create trigger clear_final_price_unless_result
before insert or update on public.user_followed_sale_snapshots
for each row execute function app_private.clear_final_price_unless_result();

-- 3. Droits et RLS ----------------------------------------------------------------------------------
-- select et delete restent accordés (20261028190100) ; ni insertion ni mise à jour de table entière.
grant update (personal_status, final_price_eur) on table public.user_followed_sale_snapshots
  to authenticated;

drop policy if exists user_followed_sale_snapshots_update_own on public.user_followed_sale_snapshots;
create policy user_followed_sale_snapshots_update_own
on public.user_followed_sale_snapshots for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

notify pgrst, 'reload schema';

commit;
