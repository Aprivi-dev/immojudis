begin;

set local lock_timeout = '5s';

-- Voie d'enrichissement parallèle (décision du propriétaire du 17/11/2026) : deux pièces en base, aucune fonction
-- existante redéfinie.
--
--   1. app_private.robots_policies : copie commune des politiques robots.txt, partagée par tous les processus du
--      pipeline (lot 1b). Jusqu'ici chaque processus relisait robots.txt une fois par hôte et par passage : avec un
--      processus de fiches et jusqu'à trois processus de pièces côte à côte, un site aurait reçu jusqu'à quatre
--      lectures au lieu d'une. Une ligne par origine (schéma://hôte:port) : les règles retenues pour notre agent,
--      le Crawl-delay, l'heure de lecture, l'empreinte de l'agent (jamais l'agent lui-même), et le dernier échec
--      (classe, heure, échecs consécutifs, client qui l'a relevé). Mêmes règles de fraîcheur et de repli que les copies par source déjà gardées dans
--      auction_source_state.coverage (services/data-pipeline/src/sources/robots_policy_copies.py, RFC 9309 §2.4) :
--      lue depuis moins de 30 min, la copie tient lieu de lecture ; plus vieille, elle ne sert que de repli d'une
--      panne passagère, 24 h au plus. Un refus (401, 403, page de défi) n'est jamais gardé comme une politique :
--      seule sa trace (classe, heure) l'est. Aucune donnée personnelle : des adresses de sites et des règles
--      publiques. Accès : rôle de service seulement (RLS active, aucun droit pour anon, authenticated ni public).
--   2. app_private.sync_source_suspension_alerts(p_now) (lot 5) : ouvre ou referme, pour chaque source,
--      l'avertissement pipeline.source.<source>.suspended_unreachable, par la mécanique commune
--      (app_private.sync_operational_alert, catégorie « import »). Il est ouvert tant que la source est suspendue
--      parce que son site ne répond plus depuis 72 h (suspended_until futur, suspension_reason commençant par
--      « source_unreachable », posés par la fin de collecte : services/data-pipeline/src/source_suspension.py).
--      Ses détails portent la date de reprise (la sonde), la classe de l'échec et le début de l'indisponibilité.
--      Appelée à la fin de chaque collecte (autonomous_runner.finish_source). Rien n'est retiré du catalogue.
--
-- ORDRE DE DÉPLOIEMENT : indifférent. Le code part à la fusion : sans la table, chaque processus lit robots.txt
-- comme avant (et la sonde horaire d'un site en panne n'est pas activée : l'espacement d'avant reste) ; sans la
-- fonction, la fin de collecte n'ouvre pas l'alerte (la suspension, elle, s'applique).
--
-- Retour arrière : drop function app_private.sync_source_suspension_alerts(timestamptz); drop table
-- app_private.robots_policies; (le pipeline revient alors seul au comportement d'avant).
--
-- Garde de départ : la fonction est nouvelle ; une fonction du même nom au corps inattendu (créée hors migration)
-- fait échouer la migration au lieu d'être écrasée. Migration rejouée : le corps de cette migration est accepté.
do $guard$
declare
  found_md5 text;
begin
  select md5(procedure_row.prosrc) into found_md5
    from pg_catalog.pg_proc procedure_row
   where procedure_row.oid = to_regprocedure('app_private.sync_source_suspension_alerts(timestamptz)');
  if found_md5 is not null and found_md5 is distinct from '578df37538e2a6e06982bca9c0e01b6f' then
    raise exception using
      errcode = '55000',
      message = format(
        'Unexpected body for app_private.sync_source_suspension_alerts(timestamptz) (md5 %s); refusing the migration.',
        found_md5
      );
  end if;
end;
$guard$;

-- 1. Copie commune des politiques robots.txt --------------------------------------------------------------------
create table if not exists app_private.robots_policies (
  origin text primary key check (origin ~ '^https?://[a-z0-9.-]+:[0-9]{1,5}$' and length(origin) <= 300),
  rules jsonb check (rules is null or (jsonb_typeof(rules) = 'array' and jsonb_array_length(rules) <= 1000)),
  crawl_delay numeric check (crawl_delay is null or crawl_delay >= 0),
  verified_at timestamptz,
  user_agent_digest text check (user_agent_digest is null or user_agent_digest ~ '^[0-9a-f]{16}$'),
  last_failure_class text check (
    last_failure_class is null
    or last_failure_class in ('no_tcp_response', 'timeout', 'server_error', 'access_refused', 'http_error')
  ),
  last_failure_at timestamptz,
  -- Échecs consécutifs (la sonde suivante s'espace : 60 min, 2 h, 4 h, puis 6 h) et client qui a relevé le dernier :
  -- « pages » (client d'une source, seul compté pour la suspension) ou « documents » (pièces jointes).
  failure_count integer not null default 0 check (failure_count >= 0),
  last_failure_by text check (last_failure_by is null or last_failure_by in ('pages', 'documents')),
  updated_at timestamptz not null default now(),
  constraint robots_policies_copy_complete check (
    (verified_at is null and rules is null and user_agent_digest is null)
    or (verified_at is not null and rules is not null and user_agent_digest is not null)
  ),
  constraint robots_policies_failure_complete check ((last_failure_class is null) = (last_failure_at is null))
);

comment on table app_private.robots_policies is
  'Copie commune des politiques robots.txt par origine (pipeline de collecte) : règles retenues pour notre agent, Crawl-delay, heure de lecture (24 h de validité au plus, RFC 9309), dernier échec. Rôle de service seulement.';

alter table app_private.robots_policies enable row level security;
revoke all on table app_private.robots_policies from public, anon, authenticated;
grant select, insert, update, delete on table app_private.robots_policies to service_role;

-- 2. Avertissement d'une source suspendue parce que son site ne répond plus -------------------------------------
create or replace function app_private.sync_source_suspension_alerts(p_now timestamptz default statement_timestamp())
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  source_row record;
  suspended boolean;
  active_count integer := 0;
begin
  for source_row in
    select state.source_name, state.suspended_until, state.suspension_reason, state.coverage
      from public.auction_source_state state
     where (state.suspended_until > p_now and state.suspension_reason like 'source_unreachable%')
        or exists (
          select 1
            from public.operational_alerts alert
           where alert.alert_key = 'pipeline.source.' || state.source_name || '.suspended_unreachable'
             and alert.status = 'open'
        )
  loop
    suspended := coalesce(
      source_row.suspended_until > p_now and source_row.suspension_reason like 'source_unreachable%',
      false
    );
    perform app_private.sync_operational_alert(
      'pipeline.source.' || source_row.source_name || '.suspended_unreachable',
      'import',
      'warning',
      jsonb_build_object(
        'source', source_row.source_name,
        'suspended_until', source_row.suspended_until,
        'resume_probe_at', source_row.suspended_until,
        'suspension_reason', left(source_row.suspension_reason, 300),
        'failure_class', source_row.coverage->>'failure_class',
        'unreachable_since', source_row.coverage->>'unreachable_since',
        'runbook', 'docs/runbooks/pipeline-source-missed.md'
      ),
      suspended,
      p_now
    );
    if suspended then
      active_count := active_count + 1;
    end if;
  end loop;
  return active_count;
end;
$function$;

revoke all on function app_private.sync_source_suspension_alerts(timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.sync_source_suspension_alerts(timestamptz) is
  'Ouvre ou referme pipeline.source.<source>.suspended_unreachable : source suspendue 7 jours après 72 h sans réponse de son site (fin de collecte du pipeline).';

commit;
