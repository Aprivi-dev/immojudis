begin;

set local lock_timeout = '5s';

-- Fusion de doublons sans perte (point 6 de la session du 18/10/2026).
--
-- Le balayage des doublons (reconcile_duplicate_sales_in_supabase) enregistre la fiche conservée, dont
-- source_urls liste les annonces secondaires, puis SUPPRIME les lignes secondaires de auction_sales.
-- 20261023110000 ne transférait que les déblocages (user_sale_unlocks). Toutes les autres tables liées
-- par « on delete cascade » à auction_sales(id) perdaient leurs lignes : favoris, notes (espace de
-- travail et annotations), rapports enregistrés, correspondances et notifications d'alerte, suivis
-- (instantanés et événements de changement), ensembles d'analyse, demandes d'actualisation.
--
-- Avant la suppression d'une ligne, ce déclencheur :
--   1. retrouve la fiche conservée (celle dont source_urls liste l'URL de la ligne supprimée, comme
--      20261023110000) ;
--   2. fait passer à cette fiche les lignes des comptes. Fusion « on conflict do nothing » : une ligne
--      est déplacée par UPDATE (son identifiant et ses enfants, notes d'un espace de travail ou
--      notifications d'une correspondance, la suivent) seulement si le compte n'a pas déjà la même ligne
--      sur la fiche conservée ; sinon la ligne en double disparaît avec la ligne supprimée, comme avant.
--      Le déplacement est un UPDATE : le déclencheur de quota de favoris (app_private.enforce_favorite_quota,
--      « before insert ») et les quotas d'ensemble d'analyse (« update of user_id, analysis_set_id ») ne
--      se déclenchent pas, un transfert ne peut donc pas être bloqué par un quota et ne fait jamais
--      grandir le nombre de favoris d'un compte ;
--   3. note la correspondance ancien identifiant -> fiche conservée dans app_private.auction_sale_merges,
--      pour que /sales/<ancien identifiant> réponde par une redirection permanente au lieu d'un 404.
--
-- Hors transfert, volontairement : les tables dérivées que la collecte reconstruit pour la fiche conservée
-- (présence source, lecture des pièces, indice de complétude, estimations, copies de photos, historique de
-- préparation) et les dossiers de l'agent d'information (conversations externes, une seule par vente et
-- contact), qui demandent une décision à part. À signaler au propriétaire, voir le rapport du chantier.

-- 1. Correspondance ancien identifiant -> fiche conservée ----------------------------------------------
create table if not exists app_private.auction_sale_merges (
  old_sale_id uuid primary key,
  old_source_url text not null,
  canonical_sale_id uuid not null references public.auction_sales(id) on delete cascade,
  merged_at timestamptz not null default now()
);

comment on table app_private.auction_sale_merges is
  'Ancien identifiant d''une fiche supprimée par une fusion de doublons -> fiche conservée. Alimentée par le déclencheur auction_sales_carry_sale_user_data ; lue par app_private.get_merged_sale_target.';

create index if not exists auction_sale_merges_canonical_idx
  on app_private.auction_sale_merges (canonical_sale_id);

alter table app_private.auction_sale_merges enable row level security;
revoke all on table app_private.auction_sale_merges from public, anon, authenticated;
grant select on table app_private.auction_sale_merges to service_role;

-- 2. Transfert des données des comptes ---------------------------------------------------------------
create or replace function app_private.carry_sale_user_data_to_merged_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
  v_target_url text;
begin
  select merged.id, merged.source_url
    into v_target, v_target_url
  from public.auction_sales merged
  where merged.id <> old.id
    and jsonb_typeof(merged.source_urls) = 'array'
    and merged.source_urls ? old.source_url
  order by merged.updated_at desc nulls last, merged.id
  limit 1;

  -- Suppression sans fiche conservée (rétention, retrait) : rien à transférer, comme avant.
  if v_target is null then
    return old;
  end if;

  -- Correspondance. Les anciennes fiches déjà fusionnées dans la ligne supprimée suivent la nouvelle
  -- fiche conservée (sinon la cascade supprimerait leur correspondance).
  update app_private.auction_sale_merges
     set canonical_sale_id = v_target
   where canonical_sale_id = old.id;
  insert into app_private.auction_sale_merges (old_sale_id, old_source_url, canonical_sale_id)
  values (old.id, old.source_url, v_target)
  on conflict (old_sale_id) do update
    set canonical_sale_id = excluded.canonical_sale_id,
        old_source_url = excluded.old_source_url,
        merged_at = pg_catalog.now();

  -- Favoris : unique (user_id, sale_id).
  update public.user_favorites favorite
     set sale_id = v_target
   where favorite.sale_id = old.id
     and not exists (
       select 1 from public.user_favorites kept
       where kept.user_id = favorite.user_id and kept.sale_id = v_target
     );

  -- Espaces de travail (notes) : unique (user_id, sale_id). Les annotations suivent leur espace.
  update public.sale_workspaces workspace
     set sale_id = v_target
   where workspace.sale_id = old.id
     and not exists (
       select 1 from public.sale_workspaces kept
       where kept.user_id = workspace.user_id and kept.sale_id = v_target
     );
  update public.sale_workspace_annotations annotation
     set sale_id = v_target
   where annotation.sale_id = old.id
     and exists (
       select 1 from public.sale_workspaces moved
       where moved.id = annotation.workspace_id and moved.sale_id = v_target
     );

  -- Rapports enregistrés : unique (user_id, sale_id, report_kind).
  update public.saved_property_reports report
     set sale_id = v_target
   where report.sale_id = old.id
     and not exists (
       select 1 from public.saved_property_reports kept
       where kept.user_id = report.user_id
         and kept.sale_id = v_target
         and kept.report_kind = report.report_kind
     );

  -- Correspondances d'alerte : unique (alert_id, sale_id). Les notifications suivent leur correspondance
  -- (celles d'une correspondance en double disparaissent avec elle : le compte a déjà celle de la fiche
  -- conservée, donc pas de deuxième notification).
  update public.user_alert_matches alert_match
     set sale_id = v_target
   where alert_match.sale_id = old.id
     and not exists (
       select 1 from public.user_alert_matches kept
       where kept.alert_id = alert_match.alert_id and kept.sale_id = v_target
     );
  update public.user_alert_notifications notification
     set sale_id = v_target
   where notification.sale_id = old.id
     and exists (
       select 1 from public.user_alert_matches moved
       where moved.id = notification.match_id and moved.sale_id = v_target
     );

  -- Suivis. watch_id est l'identifiant de la correspondance, du favori ou de l'espace de travail suivi :
  -- un instantané n'est déplacé que si ce suivi existe encore sur la fiche conservée (il y est arrivé
  -- par les mises à jour ci-dessus ou il y était déjà). unique (user_id, sale_id, watch_kind, watch_id).
  update public.user_sale_watch_snapshots snapshot
     set sale_id = v_target
   where snapshot.sale_id = old.id
     and (
       (snapshot.watch_kind = 'favorite' and exists (
         select 1 from public.user_favorites moved
         where moved.id = snapshot.watch_id and moved.sale_id = v_target))
       or (snapshot.watch_kind = 'workspace' and exists (
         select 1 from public.sale_workspaces moved
         where moved.id = snapshot.watch_id and moved.sale_id = v_target))
       or (snapshot.watch_kind = 'alert_match' and exists (
         select 1 from public.user_alert_matches moved
         where moved.id = snapshot.watch_id and moved.sale_id = v_target))
     )
     and not exists (
       select 1 from public.user_sale_watch_snapshots kept
       where kept.user_id = snapshot.user_id
         and kept.sale_id = v_target
         and kept.watch_kind = snapshot.watch_kind
         and kept.watch_id = snapshot.watch_id
     );
  -- Événements de changement : l'historique du compte est gardé tel quel. unique (user_id, sale_id,
  -- event_kind, fingerprint).
  update public.user_sale_change_events change_event
     set sale_id = v_target
   where change_event.sale_id = old.id
     and not exists (
       select 1 from public.user_sale_change_events kept
       where kept.user_id = change_event.user_id
         and kept.sale_id = v_target
         and kept.event_kind = change_event.event_kind
         and kept.fingerprint = change_event.fingerprint
     );

  -- Ensembles d'analyse : unique (analysis_set_id, sale_id).
  update public.user_sale_analysis_items item
     set sale_id = v_target
   where item.sale_id = old.id
     and not exists (
       select 1 from public.user_sale_analysis_items kept
       where kept.analysis_set_id = item.analysis_set_id and kept.sale_id = v_target
     );

  -- Demandes d'actualisation : sale_id et source_url suivent la fiche conservée. L'unicité ne porte que
  -- sur les demandes actives : unique (user_id, source_url, request_kind) where status in (queued, running).
  update public.data_refresh_requests refresh_request
     set sale_id = v_target,
         source_url = v_target_url
   where refresh_request.sale_id = old.id
     and not (
       refresh_request.status in ('queued', 'running')
       and exists (
         select 1 from public.data_refresh_requests kept
         where kept.user_id = refresh_request.user_id
           and kept.source_url = v_target_url
           and kept.request_kind = refresh_request.request_kind
           and kept.status in ('queued', 'running')
       )
     );

  return old;
end;
$$;

revoke all on function app_private.carry_sale_user_data_to_merged_sale()
  from public, anon, authenticated;

drop trigger if exists auction_sales_carry_sale_user_data on public.auction_sales;
create trigger auction_sales_carry_sale_user_data
before delete on public.auction_sales
for each row execute function app_private.carry_sale_user_data_to_merged_sale();

comment on function app_private.carry_sale_user_data_to_merged_sale() is
  'Avant la suppression d''une ligne fusionnée dans une autre : transfère à la fiche conservée les favoris, notes, rapports, alertes, suivis, ensembles d''analyse et demandes d''actualisation des comptes (sans doublon, sans quota) et note ancien identifiant -> fiche conservée.';

-- 3. Redirection d'un ancien identifiant -------------------------------------------------------------
-- Minimal : l'identifiant de la fiche conservée, seulement si elle est visible au catalogue public
-- (même prédicat que get_public_sale_summary), sinon aucune ligne. Aucune autre donnée.
create or replace function app_private.get_merged_sale_target(p_sale_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select merge.canonical_sale_id
  from app_private.auction_sale_merges merge
  where merge.old_sale_id = p_sale_id
    and app_private.auction_sale_is_publicly_visible(merge.canonical_sale_id);
$function$;

revoke all on function app_private.get_merged_sale_target(uuid) from public, anon, authenticated;
grant execute on function app_private.get_merged_sale_target(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_merged_sale_target(p_sale_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $function$
  select app_private.get_merged_sale_target(p_sale_id);
$function$;

revoke all on function public.get_merged_sale_target(uuid) from public;
grant execute on function public.get_merged_sale_target(uuid)
  to anon, authenticated, service_role;

comment on function public.get_merged_sale_target(uuid) is
  'Fiche conservée (identifiant seul) d''une fiche fusionnée, si elle est visible au catalogue public : sert la redirection 308 de /sales/<ancien identifiant>.';

notify pgrst, 'reload schema';

commit;
