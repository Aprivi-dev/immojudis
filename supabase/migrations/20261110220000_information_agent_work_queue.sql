begin;

set local lock_timeout = '5s';

-- Agent d'information, lot 1 (refonte validée le 02/11/2026) : file de travail utile, attestation de l'aller-retour
-- de réception, indicateurs d'exploitation et alertes de santé.
--
--   1. public.admin_information_agent_queue : la file de l'agent, filtrée AVANT la pagination (vente en cours, date
--      non passée, pas déjà sollicitée) et répartie en quatre classes. Approximation SQL du résolveur TypeScript, qui
--      reste l'arbitre : le SQL est un filtre sûr (sur-ensemble), la page affichée est revérifiée en TypeScript.
--        A  adresse d'avocat ou de cabinet dans l'annonce (champ de contact, blocs de contact, registre interne)
--        B  adresse seulement dans un texte libre de l'annonce (à confirmer par l'administrateur)
--        C  aucune adresse d'avocat, mais le greffe du tribunal a une adresse (référentiel des tribunaux)
--        D  contact impossible (téléphone seul, nom seul, rien)
--      Un dossier dont l'unique message a rebondi (metadata.delivery.status = 'bounced') ne compte plus comme « déjà
--      sollicité » : la vente redevient éligible pour un autre destinataire.
--   2. public.information_agent_operations (ligne unique) et public.attest_information_agent_roundtrip : date à laquelle
--      un administrateur a vérifié, de bout en bout, qu'une réponse envoyée à l'adresse de réponse arrive jusqu'à la
--      revue. Lue par le contrôle de préparation du pilote automatique (lot 2).
--   3. public.information_agent_indicators : envoyés, remis, retardés, rebonds, plaintes, oppositions, réponses et
--      délai de réponse, avec l'effectif. Compteurs seulement, aucune adresse.
--   4. public.evaluate_information_agent_health : reprise EN ENTIER de la dernière définition (20261101150200), avec
--      trois alertes en plus : taux de rebond, plainte, message non routé en attente.
--
-- Aucune ligne existante n'est modifiée, aucune migration existante non plus.

-- 1. File de travail -------------------------------------------------------------------------------------------
create or replace function public.admin_information_agent_queue(
  p_limit integer default 50,
  p_offset integer default 0,
  p_class text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_result jsonb;
begin
  if p_class is not null and p_class not in ('A', 'B', 'C', 'D') then
    raise exception using errcode = '22023', message = 'Classe de file inconnue.';
  end if;

  with population as (
    select
      t.id,
      t.class,
      case t.class when 'A' then 0 when 'C' then 1 when 'B' then 2 else 3 end as rank,
      t.score,
      t.sale_date
    from (
      select
        s.id,
        s.premium_readiness_score as score,
        s.sale_date,
        case
          when e.email_fort or e.email_registre then 'A'
          when e.email_faible then 'B'
          when e.greffe then 'C'
          else 'D'
        end as class
      from public.auction_sales s
      cross join lateral (
        select
          (
            app_private.listing_has_contact_email(s.lawyer_contact)
            or exists (
              select 1
              from pg_catalog.jsonb_each_text(
                case when pg_catalog.jsonb_typeof(s.raw_payload -> 'source_blocks') = 'object'
                  then s.raw_payload -> 'source_blocks' else '{}'::jsonb end
              ) as block(key, value)
              where block.key ~* '(contact|mail|notaire|organisat|commissaire)'
                and app_private.listing_has_contact_email(block.value)
            )
          ) as email_fort,
          (
            app_private.listing_has_contact_email(s.description)
            or app_private.listing_has_contact_email(s.raw_payload ->> 'source_description')
            or exists (
              select 1
              from pg_catalog.jsonb_each_text(
                case when pg_catalog.jsonb_typeof(s.raw_payload -> 'source_blocks') = 'object'
                  then s.raw_payload -> 'source_blocks' else '{}'::jsonb end
              ) as block(key, value)
              where app_private.listing_has_contact_email(block.value)
            )
          ) as email_faible,
          exists (
            select 1
            from public.information_agent_contacts c
            where c.scope_sale_id = s.id
              and c.source_kind = 'sale_listing'
              and c.metadata ->> 'observation_channel' = 'licitor_cloudflare_decoded'
              and c.opposition_status <> 'opposed'
              and c.bounce_status <> 'permanent'
          ) as email_registre,
          app_private.sale_has_court_registry_email(s) as greffe
      ) e
      where s.status in ('upcoming', 'unknown', 'postponed')
        and (s.premium_readiness_status is distinct from 'premium_ready' or s.premium_readiness_override = 'hold')
        and (s.sale_date is null or s.sale_date >= pg_catalog.statement_timestamp() - interval '1 day')
        and not exists (
          select 1
          from public.information_agent_cases k
          where k.sale_id = s.id
            and k.status in ('sending', 'sent', 'replied', 'review', 'completed')
            and coalesce(k.metadata -> 'delivery' ->> 'status', '') <> 'bounced'
        )
    ) t
  ),
  selected as (
    select p.*
    from population p
    where case when p_class is null then p.class <> 'D' else p.class = p_class end
  ),
  page as (
    select s.id, s.class, pg_catalog.row_number() over (
      order by s.rank, s.score desc nulls last, s.sale_date asc nulls last, s.id
    ) as ord
    from selected s
    order by ord
    limit v_limit offset v_offset
  )
  select pg_catalog.jsonb_build_object(
    'counts', (
      select pg_catalog.jsonb_build_object(
        'A', pg_catalog.count(*) filter (where class = 'A'),
        'B', pg_catalog.count(*) filter (where class = 'B'),
        'C', pg_catalog.count(*) filter (where class = 'C'),
        'D', pg_catalog.count(*) filter (where class = 'D')
      )
      from population
    ),
    'total', (select pg_catalog.count(*) from selected),
    -- Les premières ventes « contact impossible » (bloc replié de l'écran), quelle que soit la page demandée.
    'impossible', (
      select coalesce(pg_catalog.jsonb_agg(d.id order by d.rank, d.score desc nulls last, d.sale_date asc nulls last, d.id), '[]'::jsonb)
      from (
        select p.id, p.rank, p.score, p.sale_date
        from population p
        where p.class = 'D'
        order by p.rank, p.score desc nulls last, p.sale_date asc nulls last, p.id
        limit 100
      ) d
    ),
    'items', (
      select coalesce(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object('id', page.id, 'class', page.class) order by page.ord
        ),
        '[]'::jsonb
      )
      from page
    )
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_information_agent_queue(integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.admin_information_agent_queue(integer, integer, text) to service_role;

comment on function public.admin_information_agent_queue(integer, integer, text) is
  'File de l''agent d''information : ventes en cours, date non passée, pas déjà sollicitées, réparties en classes A (avocat, adresse), B (adresse en texte libre), C (greffe) et D (contact impossible), filtrées avant la pagination. Approximation SQL du résolveur TypeScript (qui fait foi). Réservée à service_role ; les routes d''administration vérifient le rôle.';

-- 2. Aller-retour de réception attesté -----------------------------------------------------------------------------
create table if not exists public.information_agent_operations (
  singleton boolean primary key default true check (singleton),
  inbound_roundtrip_verified_at timestamptz,
  -- Identifiant de l'administrateur, sans clé étrangère : la ligne ne doit pas dépendre d'un compte.
  inbound_roundtrip_verified_by uuid,
  updated_at timestamptz not null default now()
);

comment on table public.information_agent_operations is
  'Ligne unique d''exploitation de l''agent d''information : date de la dernière vérification, par un administrateur, de l''aller-retour réel d''une réponse (envoi, réception, revue). Lue par le contrôle de préparation du pilote automatique.';

insert into public.information_agent_operations (singleton) values (true) on conflict (singleton) do nothing;

alter table public.information_agent_operations enable row level security;
revoke all on table public.information_agent_operations from public, anon, authenticated;
grant select, insert, update on table public.information_agent_operations to service_role;
-- Aucune politique : RLS sans politique refuse tout rôle soumis aux politiques ; service_role les contourne.

create or replace function public.attest_information_agent_roundtrip(p_admin_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_admin_id is null or not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = p_admin_id and profile.user_role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  insert into public.information_agent_operations as ops (singleton, inbound_roundtrip_verified_at, inbound_roundtrip_verified_by, updated_at)
  values (true, v_at, p_admin_id, v_at)
  on conflict (singleton) do update set
    inbound_roundtrip_verified_at = excluded.inbound_roundtrip_verified_at,
    inbound_roundtrip_verified_by = excluded.inbound_roundtrip_verified_by,
    updated_at = excluded.updated_at;
  return v_at;
end;
$$;

revoke all on function public.attest_information_agent_roundtrip(uuid) from public, anon, authenticated;
grant execute on function public.attest_information_agent_roundtrip(uuid) to service_role;

comment on function public.attest_information_agent_roundtrip(uuid) is
  'Enregistre qu''un administrateur a vérifié l''aller-retour réel d''une réponse à l''agent d''information. Refuse un compte qui n''est pas administrateur. Réservée à service_role.';

-- 3. Indicateurs -----------------------------------------------------------------------------------------------
create or replace function public.information_agent_indicators(
  p_since timestamptz default null,
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_since timestamptz := coalesce(p_since, p_now - interval '30 days');
  v_sent integer;
  v_delivered integer;
  v_delayed integer;
  v_bounced_permanent integer;
  v_bounced_temporary integer;
  v_complained integer;
  v_failed integer;
  v_oppositions integer;
  v_replies integer;
  v_response_median_seconds numeric;
  v_response_mean_seconds numeric;
  v_unrouted_pending integer;
begin
  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (where status = 'delivered')::integer,
    pg_catalog.count(*) filter (where status = 'delayed')::integer,
    pg_catalog.count(*) filter (where status = 'bounced' and coalesce(bounce_type, '') = 'permanent')::integer,
    pg_catalog.count(*) filter (where status = 'bounced' and coalesce(bounce_type, '') <> 'permanent')::integer,
    pg_catalog.count(*) filter (where status = 'complained')::integer,
    pg_catalog.count(*) filter (where status = 'failed')::integer
  into v_sent, v_delivered, v_delayed, v_bounced_permanent, v_bounced_temporary, v_complained, v_failed
  from public.email_send_log
  -- Les essais d'administrateur (mode test) et les envois internes ne comptent pas dans les taux.
  where category = 'agent' and mode not in ('test', 'internal') and created_at >= v_since and created_at <= p_now;

  select pg_catalog.count(*)::integer
  into v_oppositions
  from public.information_agent_contacts
  where scope_sale_id is null and opposition_status = 'opposed' and opposed_at >= v_since and opposed_at <= p_now;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.percentile_cont(0.5) within group (order by extract(epoch from (replied_at - sent_at))),
    pg_catalog.avg(extract(epoch from (replied_at - sent_at)))
  into v_replies, v_response_median_seconds, v_response_mean_seconds
  from public.information_agent_cases
  where sent_at >= v_since and sent_at <= p_now and replied_at is not null and replied_at >= sent_at;

  select pg_catalog.count(*)::integer
  into v_unrouted_pending
  from public.information_agent_unrouted_messages
  where status = 'pending';

  return pg_catalog.jsonb_build_object(
    'since', v_since,
    'sent', v_sent,
    'delivered', v_delivered,
    'delayed', v_delayed,
    'bounced_permanent', v_bounced_permanent,
    'bounced_temporary', v_bounced_temporary,
    'complained', v_complained,
    'failed', v_failed,
    'oppositions', v_oppositions,
    'replies', v_replies,
    'response_median_seconds', v_response_median_seconds,
    'response_mean_seconds', v_response_mean_seconds,
    'unrouted_pending', v_unrouted_pending
  );
end;
$$;

revoke all on function public.information_agent_indicators(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.information_agent_indicators(timestamptz, timestamptz) to service_role;

comment on function public.information_agent_indicators(timestamptz, timestamptz) is
  'Indicateurs d''exploitation de l''agent d''information depuis une date : envoyés, remis, retardés, rebonds (définitifs et passagers), plaintes, échecs, oppositions, réponses, délai de réponse (médiane et moyenne, en secondes). Compteurs seulement. Réservée à service_role.';

-- 4. Santé ---------------------------------------------------------------------------------------------------
-- Reprend EN ENTIER la définition de 20261101150200 (mission en envoi, réponse en file, exécution bloquée, envoi à
-- vérifier) et ajoute :
--   information_agent.delivery.bounce_rate   rebonds définitifs ≥ 3 % des envois des 14 derniers jours (au moins 10
--                                            envois) ; critique à partir de 5 %
--   information_agent.delivery.complaint     au moins une plainte sur les 14 derniers jours (critique)
--   information_agent.unrouted.pending       message sans dossier en attente de traitement depuis plus de 24 h
create or replace function public.evaluate_information_agent_health(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  stuck_mission_count integer;
  oldest_stuck_mission timestamptz;
  stuck_job_count integer;
  oldest_stuck_job timestamptz;
  blocked_run_count integer;
  oldest_blocked_run timestamptz;
  unverified_send_count integer;
  oldest_unverified_send timestamptz;
  recent_sent_count integer;
  recent_bounced_count integer;
  recent_complaint_count integer;
  unrouted_pending_count integer;
  oldest_unrouted_pending timestamptz;
  bounce_percent numeric;
  details jsonb;
begin
  select count(*)::integer, min(coalesce(mission.approved_at, mission.updated_at))
  into stuck_mission_count, oldest_stuck_mission
  from public.information_agent_missions mission
  where mission.status = 'sending'
    and mission.sent_at is null
    and coalesce(mission.approved_at, mission.updated_at) < p_now - interval '30 minutes';

  select count(*)::integer, min(job.updated_at)
  into stuck_job_count, oldest_stuck_job
  from public.information_agent_inbound_jobs job
  where job.status in ('queued', 'processing', 'failed')
    and job.updated_at < p_now - interval '30 minutes'
    and greatest(job.available_at, coalesce(job.locked_at, job.available_at))
      < p_now - interval '30 minutes';

  select count(*)::integer, min(run.started_at)
  into blocked_run_count, oldest_blocked_run
  from public.operational_job_runs run
  where run.job_name like 'information-agent-%'
    and run.status = 'running'
    and run.started_at < p_now - interval '20 minutes';

  select count(*)::integer, min(mission.updated_at)
  into unverified_send_count, oldest_unverified_send
  from public.information_agent_missions mission
  where mission.status in ('sending', 'failed')
    and mission.metadata ->> 'send_outcome' = 'unverified';

  select
    count(*)::integer,
    count(*) filter (where entry.status = 'bounced' and coalesce(entry.bounce_type, '') = 'permanent')::integer,
    count(*) filter (where entry.status = 'complained')::integer
  into recent_sent_count, recent_bounced_count, recent_complaint_count
  from public.email_send_log entry
  where entry.category = 'agent'
    and entry.mode not in ('test', 'internal')
    and entry.created_at >= p_now - interval '14 days'
    and entry.created_at <= p_now;
  bounce_percent := case when recent_sent_count > 0
    then round(recent_bounced_count * 100.0 / recent_sent_count, 1) else 0 end;

  select count(*)::integer, min(message.created_at)
  into unrouted_pending_count, oldest_unrouted_pending
  from public.information_agent_unrouted_messages message
  where message.status = 'pending'
    and message.created_at < p_now - interval '24 hours';

  details := jsonb_build_object(
    'stuck_missions', stuck_mission_count,
    'oldest_stuck_mission_at', oldest_stuck_mission,
    'stuck_inbound_jobs', stuck_job_count,
    'oldest_stuck_inbound_job_at', oldest_stuck_job,
    'blocked_cron_runs', blocked_run_count,
    'oldest_blocked_cron_run_at', oldest_blocked_run,
    'blocked_cron_maximum_age_minutes', 20,
    'unverified_sends', unverified_send_count,
    'oldest_unverified_send_at', oldest_unverified_send,
    'maximum_age_minutes', 30,
    'recent_sent', recent_sent_count,
    'recent_permanent_bounces', recent_bounced_count,
    'recent_bounce_percent', bounce_percent,
    'recent_complaints', recent_complaint_count,
    'unrouted_pending_over_24h', unrouted_pending_count
  );

  perform app_private.sync_operational_alert(
    'information_agent.mission.stuck',
    'cron',
    'warning',
    jsonb_build_object(
      'count', stuck_mission_count,
      'oldest_at', oldest_stuck_mission,
      'maximum_age_minutes', 30
    ),
    stuck_mission_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.inbound.stuck',
    'cron',
    case when stuck_job_count >= 5 then 'critical' else 'warning' end,
    jsonb_build_object(
      'count', stuck_job_count,
      'oldest_at', oldest_stuck_job,
      'maximum_age_minutes', 30
    ),
    stuck_job_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.cron.blocked',
    'cron',
    'warning',
    jsonb_build_object(
      'count', blocked_run_count,
      'oldest_started_at', oldest_blocked_run,
      'maximum_age_minutes', 20
    ),
    blocked_run_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.send.unverified',
    'cron',
    'warning',
    jsonb_build_object(
      'count', unverified_send_count,
      'oldest_at', oldest_unverified_send
    ),
    unverified_send_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.delivery.bounce_rate',
    'cron',
    case when bounce_percent >= 5 then 'critical' else 'warning' end,
    jsonb_build_object(
      'sent', recent_sent_count,
      'permanent_bounces', recent_bounced_count,
      'percent', bounce_percent,
      'window_days', 14,
      'warning_percent', 3,
      'critical_percent', 5
    ),
    recent_sent_count >= 10 and bounce_percent >= 3,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.delivery.complaint',
    'cron',
    'critical',
    jsonb_build_object(
      'complaints', recent_complaint_count,
      'window_days', 14
    ),
    recent_complaint_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.unrouted.pending',
    'cron',
    'warning',
    jsonb_build_object(
      'count', unrouted_pending_count,
      'oldest_at', oldest_unrouted_pending,
      'maximum_age_hours', 24
    ),
    unrouted_pending_count > 0,
    p_now
  );

  return details;
end;
$$;

revoke all on function public.evaluate_information_agent_health(timestamptz)
from public, anon, authenticated;
grant execute on function public.evaluate_information_agent_health(timestamptz)
to service_role;

comment on function public.evaluate_information_agent_health(timestamptz) is
  'Alertes de l''agent d''information : mission en envoi, réponse en file, exécution bloquée, envoi à vérifier, taux de rebond, plainte, message non routé en attente. Séparée d''evaluate_operational_health.';

notify pgrst, 'reload schema';

commit;
