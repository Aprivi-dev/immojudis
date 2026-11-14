begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Pilote automatique de l'agent d'information : jours de simulation EFFECTIFS (relecture du lot B du 14/11/2026,
-- point 1, validé par le propriétaire le même jour).
--
-- La porte du mode réel « 7 jours de simulation sans anomalie » comptait le temps écoulé depuis
-- simulation_started_at : un pilote muet, arrêté par le plafond des brouillons simulés en attente ou en erreur la
-- remplissait quand même. public.information_agent_autopilot_stats rend désormais aussi `clean_simulation_days` :
-- les jours (heure de Paris) depuis le début de la simulation qui ont au moins un évènement `would_send` d'un
-- passage PLANIFIÉ ET aucun passage en erreur (évènement `run` dont le détail porte une clé `error_<code>` :
-- draft_error, cancel_failed, preview_error, mark_failed, stale_check_failed). Les envois simulés d'un passage lancé
-- à la main (trace `run` du même run_id avec `manual` vrai) ne comptent pas : des clics ne remplacent pas la tâche
-- planifiée. L'application exige 5 de ces jours en plus des 7 jours écoulés (AUTOPILOT_MIN_CLEAN_SIMULATION_DAYS,
-- autopilot-readiness.ts). Une erreur de passage, à la main ou planifié, gâte la journée ; elle ne remet pas à zéro
-- toute la simulation : `anomalies_since_simulation` (arrêts automatiques, erreurs d'envoi) ne change pas.
--
-- Reprise EN ENTIER de la dernière définition (20261119100500), mêmes droits et même search_path ; seul ajout, la
-- clé `clean_simulation_days`. Aucune donnée modifiée.
--
-- Verrous : aucun sur une table (CREATE OR REPLACE FUNCTION ne touche que le catalogue).
--
-- Retour arrière : rejouer la définition de public.information_agent_autopilot_stats de
-- 20261119100500_information_agent_autopilot_rearm.sql dans une nouvelle migration (la porte reste alors fermée :
-- la clé absente vaut 0).

create or replace function public.information_agent_autopilot_stats(p_now timestamptz default statement_timestamp())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day_start timestamptz := ((p_now at time zone 'Europe/Paris')::date)::timestamp at time zone 'Europe/Paris';
  v_first timestamptz;
  -- Dernière réactivation journalisée après un arrêt automatique (mode « simulation » ou « live ») ; -infinity : aucune.
  v_reactivated timestamptz;
  v_result jsonb;
begin
  select min(entry.created_at) into v_first
  from public.email_send_log entry where entry.mode = 'autopilot' and entry.category = 'agent';

  select coalesce(pg_catalog.max(e.at), '-infinity'::timestamptz) into v_reactivated
  from public.information_agent_autopilot_events e
  where e.kind = 'mode_changed' and e.after_values ->> 'mode' in ('simulation', 'live')
    and coalesce((e.before_values ->> 'auto_stopped')::boolean, false);

  with sent as (
    select m.id, m.sale_id, m.approved_at, pg_catalog.lower(pg_catalog.split_part(m.recipient_email, '@', 2)) as domain
    from public.information_agent_missions m
    where m.approved_at is not null
      and m.approved_at >= p_now - interval '8 days'
      and (m.status in ('sending', 'sent', 'replied', 'review', 'completed')
           or (m.status = 'failed' and m.metadata ->> 'send_outcome' = 'unverified'))
  ),
  ap as (
    select entry.status, entry.bounce_type, entry.created_at, entry.to_address
    from public.email_send_log entry where entry.mode = 'autopilot' and entry.category = 'agent'
  ),
  ap_first100 as (select * from ap order by created_at asc limit 100),
  ap_first30 as (select * from ap order by created_at asc limit 30),
  ap_mature as (
    select * from (select * from ap where created_at <= p_now - interval '48 hours' order by created_at desc limit 100) latest
  ),
  manual as (
    select entry.status, entry.bounce_type
    from public.email_send_log entry
    where entry.mode = 'manual' and entry.category = 'agent' and entry.to_address <> 'delivered@resend.dev'
  )
  select pg_catalog.jsonb_build_object(
    'sent_today_total', (select pg_catalog.count(*) from sent where approved_at >= v_day_start),
    'sent_last_hour_total', (select pg_catalog.count(*) from sent where approved_at >= p_now - interval '1 hour'),
    'last_send_at', (select pg_catalog.max(approved_at) from sent),
    'today_by_domain', (select coalesce(pg_catalog.jsonb_object_agg(domain, n), '{}'::jsonb)
      from (select domain, pg_catalog.count(*) as n from sent where approved_at >= v_day_start group by domain) d),
    'week_by_domain', (select coalesce(pg_catalog.jsonb_object_agg(domain, n), '{}'::jsonb)
      from (select domain, pg_catalog.count(*) as n from sent where approved_at >= p_now - interval '7 days' group by domain) d),
    'today_by_court', (select coalesce(pg_catalog.jsonb_object_agg(court, n), '{}'::jsonb)
      from (select s.tribunal_code as court, pg_catalog.count(*) as n
            from sent join public.auction_sales s on s.id = sent.sale_id
            where sent.approved_at >= v_day_start and s.tribunal_code is not null group by s.tribunal_code) c),
    'recent_domains', (select coalesce(pg_catalog.jsonb_agg(distinct domain), '[]'::jsonb)
      from sent where approved_at >= p_now - interval '15 minutes'),
    'first_autopilot_send_at', v_first,
    'autopilot_total', (select pg_catalog.count(*) from ap),
    'first100_complaints', (select pg_catalog.count(*) from ap_first100 where status = 'complained'),
    'first30_permanent_bounces', (select pg_catalog.count(*) from ap_first30 where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'),
    'mature_total', (select pg_catalog.count(*) from ap_mature),
    'mature_permanent_bounces', (select pg_catalog.count(*) from ap_mature where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'),
    'last24h_sent', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour'),
    'last24h_delayed', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour' and status = 'delayed'),
    'last24h_delivered', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour' and status = 'delivered'),
    'last24h_failed', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour' and status = 'failed'),
    'complaints_14d', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '14 days' and status = 'complained'),
    'sent_14d', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '14 days'),
    'oppositions_14d', (select pg_catalog.count(distinct contact.normalized_email)
      from public.information_agent_contacts contact
      where contact.scope_sale_id is null and contact.opposition_status = 'opposed'
        and contact.opposed_at >= p_now - interval '14 days'
        and contact.normalized_email in (select to_address from ap)),
    'weeks', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('week', w.week, 'sent', w.sent,
        'complaints', w.complaints, 'permanent_bounces', w.permanent_bounces) order by w.week), '[]'::jsonb)
      from (select pg_catalog.floor(extract(epoch from (created_at - v_first)) / 604800)::integer as week,
                   pg_catalog.count(*)::integer as sent,
                   (pg_catalog.count(*) filter (where status = 'complained'))::integer as complaints,
                   (pg_catalog.count(*) filter (where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'))::integer as permanent_bounces
            from ap where v_first is not null group by 1) w),
    -- Depuis le dernier envoi réussi ET depuis la dernière réactivation après un arrêt automatique.
    'consecutive_api_errors', (select pg_catalog.count(*) from public.information_agent_autopilot_events e
      where e.kind = 'send_error' and e.details ->> 'status' is distinct from '429'
        and e.at > coalesce((select pg_catalog.max(at) from public.information_agent_autopilot_events where kind = 'sent'), '-infinity'::timestamptz)
        and e.at >= v_reactivated),
    -- Sur 7 jours glissants ET depuis la dernière réactivation après un arrêt automatique.
    'rejected_7d', (select pg_catalog.count(*) from public.information_agent_autopilot_events e
      where e.kind = 'skip' and e.at >= p_now - interval '7 days' and e.at >= v_reactivated
        and e.details ->> 'code' in ('policy_rejected', 'content_rejected')),
    'unverified_open', (select pg_catalog.count(*) from public.information_agent_missions m
      where m.metadata ->> 'send_outcome' = 'unverified' and m.status in ('sending', 'failed')),
    'stuck_sending', (select pg_catalog.count(*) from public.information_agent_missions m
      where m.status = 'sending' and m.sent_at is null and coalesce(m.approved_at, m.updated_at) < p_now - interval '30 minutes'),
    'manual_real_sends', (select pg_catalog.count(*) from manual),
    'manual_complaints', (select pg_catalog.count(*) from manual where status = 'complained'),
    'manual_permanent_bounces', (select pg_catalog.count(*) from manual where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'),
    'would_send_days', (select pg_catalog.count(distinct (e.at at time zone 'Europe/Paris')::date)
      from public.information_agent_autopilot_events e
      where e.kind = 'would_send'
        and e.at >= coalesce((select simulation_started_at from public.information_agent_autopilot_settings where singleton), p_now)),
    -- Seul ajout : jours effectifs de simulation, avec au moins un envoi simulé d'un passage planifié ET aucun passage
    -- en erreur ce jour-là (évènement `run` dont le détail porte une clé `error_<code>`, quel que soit le passage).
    -- Mêmes jours de Paris, même début que ci-dessus.
    'clean_simulation_days', (select pg_catalog.count(distinct (e.at at time zone 'Europe/Paris')::date)
      from public.information_agent_autopilot_events e
      where e.kind = 'would_send'
        and e.at >= coalesce((select simulation_started_at from public.information_agent_autopilot_settings where singleton), p_now)
        -- RÈGLE LIÉE : `AUTOPILOT_MANUAL_RUN_MARK` (autopilot-rules.ts). Un passage lancé à la main écrit sa trace
        -- `run` de début, marquée `manual` et du même run_id, avant ses envois simulés : ceux-ci ne comptent pas.
        and not exists (
          select 1 from public.information_agent_autopilot_events m
          where m.run_id = e.run_id and m.kind = 'run' and m.details ->> 'manual' = 'true'
        )
        and not exists (
          select 1 from public.information_agent_autopilot_events r
          where r.kind = 'run'
            and (r.at at time zone 'Europe/Paris')::date = (e.at at time zone 'Europe/Paris')::date
            and exists (
              select 1
              from pg_catalog.jsonb_object_keys(
                case when pg_catalog.jsonb_typeof(r.details) = 'object' then r.details else '{}'::jsonb end
              ) detail_key
              where pg_catalog.starts_with(detail_key, 'error_')
            )
        )),
    'anomalies_since_simulation', (select pg_catalog.count(*) from public.information_agent_autopilot_events e
      where e.kind in ('auto_stop', 'send_error')
        and e.at >= coalesce((select simulation_started_at from public.information_agent_autopilot_settings where singleton), p_now))
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.information_agent_autopilot_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.information_agent_autopilot_stats(timestamptz) to service_role;

comment on function public.information_agent_autopilot_stats(timestamptz) is
  'Compteurs du pilote automatique de l''agent d''information (plafonds, arrêts automatiques, contrôle de préparation). Les rejets de politique sur 7 jours et les erreurs d''API consécutives se comptent depuis la dernière réactivation journalisée après un arrêt automatique (mode « simulation » ou « live », before_values.auto_stopped vrai). clean_simulation_days : jours de Paris depuis le début de la simulation avec un envoi simulé d''un passage planifié (pas d''un passage lancé à la main) et aucun passage en erreur. Aucune adresse. Réservée à service_role.';

notify pgrst, 'reload schema';

commit;
