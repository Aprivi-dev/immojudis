begin;

set local lock_timeout = '5s';

-- « Surface lue dans les pièces » (P8, état des lieux du 08/11/2026, validé par le propriétaire le 08/11/2026).
--
-- Quand l'annonce ne publie pas la surface bâtie (absente, ou seulement estimée d'après le type et les pièces), un
-- compte peut saisir dans « Mon dossier » de la fiche la surface qu'il a lue dans les pièces du dossier (procès-verbal
-- descriptif, diagnostics). Elle sert à SON calcul de l'enchère plafond, affichée « saisie par vous ».
--
-- Stockage : une colonne de public.user_favorites, la ligne du dossier gratuit (20261028190000), comme le statut
-- personnel et le plafond enregistré. Conséquences voulues :
--   - le catalogue n'est jamais modifié (aucune écriture dans public.auction_sales ni dans l'estimation stockée
--     public.auction_sale_market_estimates : la valeur recalculée sur cette surface n'est ni stockée ni journalisée) ;
--   - la surface n'entre ni dans les statistiques, ni dans les pépites, ni dans les alertes (aucune de ces lectures
--     ne lit user_favorites.user_surface_m2) ;
--   - elle s'efface avec le favori (retirer la vente des favoris) et avec le compte (clé étrangère
--     user_favorites.user_id -> auth.users on delete cascade, et effacement explicite de user_favorites par
--     ERASURE_TABLES, src/lib/privacy-requests.ts) ;
--   - elle n'est pas reprise dans le cliché d'après-vente (user_followed_sale_snapshots) ni dans le rapport PDF.
--
-- Bornes : strictement plus de 0 m², au plus 10 000 m² (même borne que le schéma Zod de /api/favorites/dossier,
-- MAX_ENTERED_SURFACE_M2 de src/lib/surface.ts).
--
-- Sécurité (RLS stricte, inchangée) : les politiques de user_favorites restent celles du propriétaire seul. La mise à
-- jour reste accordée COLONNE PAR COLONNE : user_surface_m2 s'ajoute à personal_status et bid_ceiling_eur ; ni
-- user_id ni sale_id ne deviennent modifiables.
--
-- Fusion de doublons : comme le statut et le plafond, la surface voyage avec la ligne déplacée, et passe sur la ligne
-- conservée quand celle-ci n'en a pas (redéfinition de app_private.carry_favorite_dossier_to_merged_sale, identique
-- à 20261028190000 à la surface près).
--
-- Déploiement : le code applicatif fonctionne avant cette migration (la colonne absente se lit comme « aucune
-- surface », et la saisie répond 503).
-- Retour arrière : redéfinir app_private.carry_favorite_dossier_to_merged_sale telle que 20261028190000, puis
-- revoke update (user_surface_m2) on public.user_favorites from authenticated;
-- alter table public.user_favorites drop column user_surface_m2;

-- 1. Colonne ------------------------------------------------------------------------------------------------------
alter table public.user_favorites
  add column if not exists user_surface_m2 numeric;

comment on column public.user_favorites.user_surface_m2 is
  'Surface (m²) lue dans les pièces et saisie par le compte quand l''annonce ne la publie pas. Sert au seul calcul du plafond de ce compte, affichée « saisie par vous ». Jamais recopiée au catalogue, ni dans les statistiques ni dans les alertes ; effacée avec le favori et le compte. Null : aucune saisie.';

alter table public.user_favorites
  drop constraint if exists user_favorites_user_surface_check;
alter table public.user_favorites
  add constraint user_favorites_user_surface_check check (
    user_surface_m2 is null
    or (user_surface_m2 > 0 and user_surface_m2 <= 10000)
  );

-- 2. Droits -------------------------------------------------------------------------------------------------------
grant update (user_surface_m2) on table public.user_favorites to authenticated;

-- 3. Fusion de doublons -------------------------------------------------------------------------------------------
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
         bid_ceiling_eur = coalesce(kept.bid_ceiling_eur, duplicate.bid_ceiling_eur),
         user_surface_m2 = coalesce(kept.user_surface_m2, duplicate.user_surface_m2)
    from public.user_favorites duplicate
   where duplicate.sale_id = old.id
     and kept.sale_id = v_target
     and kept.user_id = duplicate.user_id
     and (
       (kept.personal_status is null and duplicate.personal_status is not null)
       or (kept.bid_ceiling_eur is null and duplicate.bid_ceiling_eur is not null)
       or (kept.user_surface_m2 is null and duplicate.user_surface_m2 is not null)
     );

  return old;
end;
$$;

revoke all on function app_private.carry_favorite_dossier_to_merged_sale()
  from public, anon, authenticated;

comment on function app_private.carry_favorite_dossier_to_merged_sale() is
  'Avant la suppression d''une fiche fusionnée : reporte le statut, le plafond et la surface saisie d''un favori en double sur le favori de la fiche conservée, s''il n''en a pas.';

notify pgrst, 'reload schema';

commit;
