begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Registre des pièces, lot R2b, étape B2 (plan du 11/11/2026, section 10 ; annexe 08, point 6). INERTE : aucune
-- vente ne tient de champ et le journal des décisions est vide, la condition du report est donc fausse pour toute
-- fusion ; le journal des publications de l'agent d'information est vide lui aussi.
--
-- app_private.carry_sale_user_data_to_merged_sale() (définition de 20261029150000, reprise à l'identique) reçoit
-- deux ajouts, après ses transferts existants :
--   1. public.information_agent_fact_publications suit la fiche conservée (UPDATE de sale_id). Sa clé étrangère
--      « on delete cascade » effaçait la trace des publications avec la fiche fusionnée. La clé étrangère est
--      gardée : la retirer demanderait un verrou sur auction_sales.
--   2. REPORT DES PIÈCES. Rien n'est déplacé dans le registre : les décisions gardent l'identifiant de la fiche
--      fusionnée, les observations sont détachées par leur clé étrangère, et la projection de la fiche conservée
--      lit déjà les fiches qu'elle a absorbées. La fonction appelle la projection de la fiche conservée, avec les
--      entrées held_fields de la fiche fusionnée en indice (20261118100000 : valeur d'annonce, mémoire d'écho,
--      libération si aucune pièce ne prend le champ). L'appel n'a lieu que s'il existe quelque chose à reporter :
--      la fiche fusionnée tient ou mémorise un champ, ou une décision la nomme, elle OU une fiche qu'elle avait
--      elle-même absorbée (fusion en chaîne : A absorbée par B, puis B par C ; les décisions nomment A, B ne
--      tient rien si sa pièce était bloquée, et C doit pourtant être reprojetée). La condition est lue AVANT que
--      la table des fusions ne soit remise à plat.
--
-- VERROUS À L'EXÉCUTION. Le déclencheur auction_sales_carry_sale_user_data est un BEFORE DELETE de la fiche
-- fusionnée : la suppression verrouille la fiche fusionnée, PUIS le déclencheur verrouille la fiche conservée (la
-- projection la prend FOR NO KEY UPDATE). Cet ordre n'est pas celui des lots de la collecte, qui verrouillent par
-- ordre d'identifiant : une suppression de doublon peut donc croiser un lot qui tient la fiche conservée et
-- demande la fiche fusionnée. PostgreSQL détecte alors l'interblocage et annule l'une des deux transactions, sans
-- écriture partielle. Une transaction qui tient déjà la fiche conservée quand elle supprime la fiche fusionnée
-- n'attend pas. C'est pourquoi l'appel est conditionnel, et pourquoi la suppression des doublons vente par vente,
-- sous point de sauvegarde, est une condition du lot R2c côté collecte (docs/runbooks/registre-des-pieces-r2b.md,
-- « Suppression de doublons en échec »). Une erreur de la projection annule la suppression : la fusion n'efface
-- jamais une pièce en silence.
--
-- Verrous de la migration : remplacement d'une fonction ; le déclencheur l'appelle par son nom et n'est pas touché.
-- Aucun verrou sur auction_sales ni sur auction_fact_claims. À APPLIQUER ENTRE DEUX LOTS DE PUBLICATION : une
-- fusion en cours changerait de fonction en route.
--
-- Retour arrière, par une nouvelle migration : rétablir la définition de 20261029150000. Tant qu'aucune vente ne
-- tient de champ, sans effet.

create or replace function app_private.carry_sale_user_data_to_merged_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
  v_target_url text;
  v_carries_registry boolean;
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

  -- Registre des pièces : y a-t-il une pièce ou une mémoire à reporter ? La fiche supprimée tient ou mémorise un
  -- champ, ou une décision la nomme, elle ou une fiche qu'elle avait absorbée. À lire avant la remise à plat des
  -- correspondances ci-dessous.
  v_carries_registry := old.held_fields is not null or exists (
    select 1
    from public.auction_fact_claim_decisions decision
    where decision.sale_id = old.id
      or decision.sale_id in (
        select merge.old_sale_id from app_private.auction_sale_merges merge
        where merge.canonical_sale_id = old.id
      )
  );

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

  -- Journal des publications de l'agent d'information : il suit la fiche conservée (sa clé étrangère « on delete
  -- cascade » l'effacerait avec la fiche fusionnée).
  update public.information_agent_fact_publications publication
     set sale_id = v_target
   where publication.sale_id = old.id;

  -- Registre des pièces. Rien n'est déplacé : les décisions gardent l'identifiant de la fiche fusionnée, que la
  -- projection de la fiche conservée lit par app_private.auction_sale_merges (écrite plus haut). La fiche
  -- conservée est reprojetée seulement s'il existe une pièce ou une mémoire à reporter ; les entrées de la fiche
  -- fusionnée servent d'indice (valeur d'annonce, mémoire d'écho). old.held_fields est lue, jamais écrite.
  if v_carries_registry then
    perform app_private.project_sale_fields(v_target, null, true, old.held_fields);
  end if;

  return old;
end;
$$;

revoke all on function app_private.carry_sale_user_data_to_merged_sale()
  from public, anon, authenticated, service_role;

comment on function app_private.carry_sale_user_data_to_merged_sale() is
  'Avant la suppression d''une ligne fusionnée dans une autre : transfère à la fiche conservée les favoris, notes, rapports, alertes, suivis, ensembles d''analyse, demandes d''actualisation, rappels déjà envoyés et publications de l''agent d''information (sans doublon, sans quota), note ancien identifiant -> fiche conservée, et reprojette la fiche conservée quand la fiche fusionnée portait une pièce du registre.';

commit;
