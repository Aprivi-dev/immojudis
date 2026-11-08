begin;

set local lock_timeout = '5s';

-- Alerte de rendement du vidage des pièces jointes : pipeline.documents_backlog.low_yield (T8/T9 de l'état
-- des lieux du 08/11/2026, post-mortem docs/audits/2026-11-04-post-mortem-vidage-pieces.md).
--
-- Le 04/11/2026, des vidages de ~45 minutes ont fini 8 lectures chacun, avec des passes qui concluaient
-- « PDF document manifest is partial » sans lire de pièce (53 passes pour 27 ventes à 11:20) et des points
-- d'étape refusés. Seule la lecture du journal du workflow l'a montré : aucune alerte ne mesurait le
-- rendement du vidage.
--
-- Le bilan n'existe que dans le processus Python du vidage (src/document_backlog.py) : c'est lui qui décide,
-- avec ses constantes nommées (src/document_backlog_yield.py), et appelle cette fonction en fin de passe.
-- Règle (tests/test_document_backlog_yield.py) : un vidage de PLUS DE 30 MINUTES, attente du verrou du
-- catalogue retranchée, qui a lu moins de 4 ventes par heure (référence saine : 43 ventes en 150 minutes,
-- environ 17 par heure), ou dont plus de 30 % des passes sont partielles. Un vidage plus court (celui de
-- 8 minutes qui suit chaque passage de la file d'enrichissement), ou arrêté faute d'avoir obtenu le verrou du
-- catalogue, ne mesure rien et n'appelle pas la fonction.
--
-- La fonction ne fait qu'enregistrer, pour cette seule clé, avec la catégorie `import` et la gravité
-- `warning` des autres alertes pipeline.* (pipeline.enrichment.exhausted) ; elle refuse un détail qui
-- n'est pas un objet JSON. Cycle de vie : celui de app_private.sync_operational_alert (ouverture et
-- notification, rappel au plus une fois par 24 h, fermeture deux heures après le premier vidage long sain,
-- constatée par un vidage long suivant). Le détail porte le bilan chiffré et les seuils, aucune donnée
-- personnelle.
--
-- Appelée par le rôle de connexion du pipeline (SUPABASE_DB_URL), comme
-- app_private.withdraw_missing_source_sales : aucun droit pour public, anon, authenticated ni service_role.
-- Tant que cette migration n'est pas appliquée, le vidage le note dans son journal et continue.
--
-- RETOUR ARRIÈRE : drop function app_private.sync_documents_backlog_low_yield_alert(boolean, jsonb, timestamptz);
-- le vidage revient à « function not deployed ». Une alerte ouverte se referme à la main
-- (update public.operational_alerts set status = 'resolved', resolved_at = now() ...).

create or replace function app_private.sync_documents_backlog_low_yield_alert(
  p_active boolean,
  p_details jsonb,
  p_now timestamptz default statement_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_active is null then
    raise exception using
      errcode = '22004',
      message = 'The document backlog yield alert needs an explicit active flag.';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception using
      errcode = '22023',
      message = 'The document backlog yield alert details must be a JSON object.';
  end if;

  perform app_private.sync_operational_alert(
    'pipeline.documents_backlog.low_yield',
    'import',
    'warning',
    p_details,
    p_active,
    p_now
  );
end;
$function$;

revoke all on function app_private.sync_documents_backlog_low_yield_alert(boolean, jsonb, timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.sync_documents_backlog_low_yield_alert(boolean, jsonb, timestamptz) is
  'Ouvre ou referme l''alerte pipeline.documents_backlog.low_yield (avertissement, catégorie import) à la fin d''un vidage des pièces de plus de 30 minutes (attente du verrou du catalogue retranchée) ; la décision et ses seuils sont dans src/document_backlog_yield.py.';

commit;
