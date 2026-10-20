begin;

set local lock_timeout = '5s';

-- Fusion de doublons : les rappels déjà envoyés suivent la fiche conservée (point 8 de la session du 20/10/2026).
--
-- app_private.carry_sale_user_data_to_merged_sale() (20261028110000) transfère les favoris, notes, rapports,
-- alertes, suivis, ensembles d'analyse et demandes d'actualisation d'une fiche fusionnée vers la fiche
-- conservée, mais pas public.sale_reminder_dispatches (20261028130100). Or cette table a une clé étrangère
-- « on delete cascade » vers auction_sales(id) : la suppression de la fiche secondaire effaçait le journal des
-- rappels déjà envoyés, et le cron des rappels (qui réserve la clé unique (user_id, sale_id, reminder_kind,
-- dedupe_key) avant d'envoyer) renvoyait un rappel d'audience ou de changement déjà reçu pour la fiche conservée.
--
-- On redéfinit la fonction à l'identique et on y ajoute le transfert du journal « on conflict do nothing » : une
-- ligne passe à la fiche conservée seulement si le compte n'a pas déjà la même clé (type de rappel, clé de
-- dédoublonnage) sur elle. Le déclencheur auction_sales_carry_sale_user_data n'est pas touché : il appelle la
-- fonction par son nom, la nouvelle définition s'applique donc dès la migration (aucun verrou sur
-- public.auction_sales).

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

  -- Rappels déjà envoyés (journal sale_reminder_dispatches) : unique (user_id, sale_id, reminder_kind,
  -- dedupe_key). Sans ce transfert la cascade supprimait la ligne « déjà envoyé » avec la fiche fusionnée et
  -- le cron renvoyait le même rappel pour la fiche conservée. Une ligne n'est déplacée que si le compte n'a
  -- pas déjà la même clé sur la fiche conservée ; sinon c'est celle de la fiche conservée qui fait foi.
  update public.sale_reminder_dispatches dispatch
     set sale_id = v_target
   where dispatch.sale_id = old.id
     and not exists (
       select 1 from public.sale_reminder_dispatches kept
       where kept.user_id = dispatch.user_id
         and kept.sale_id = v_target
         and kept.reminder_kind = dispatch.reminder_kind
         and kept.dedupe_key = dispatch.dedupe_key
     );

  return old;
end;
$$;

revoke all on function app_private.carry_sale_user_data_to_merged_sale()
  from public, anon, authenticated;

comment on function app_private.carry_sale_user_data_to_merged_sale() is
  'Avant la suppression d''une ligne fusionnée dans une autre : transfère à la fiche conservée les favoris, notes, rapports, alertes, suivis, ensembles d''analyse, demandes d''actualisation et rappels déjà envoyés des comptes (sans doublon, sans quota) et note ancien identifiant -> fiche conservée.';

commit;
