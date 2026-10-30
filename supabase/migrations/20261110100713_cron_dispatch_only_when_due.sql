begin;

set local lock_timeout = '5s';

-- Les tâches pg_cron n'appellent plus Vercel pour rien (30/10/2026). Le forfait gratuit de Vercel était
-- dépassé (temps CPU actif 6 h 20 / 4 h) alors que, sur sept jours, presque tous les appels des tâches les
-- plus fréquentes n'avaient rien à faire : 4 860 appels de la file entrante de l'agent (aucun message),
-- 1 914 calculs d'estimation (aucun dossier dû), 1 912 passages de rétention (rien à supprimer).
--
-- Les planifications ne changent pas. La fonction appelée par chaque tâche vérifie d'abord, en base, s'il y a
-- du travail ou si un passage de contrôle est dû, et ne fait l'appel HTTP que dans ce cas :
--   * information-agent-inbound (toutes les 2 min) : un message dû dans la file, sinon un passage toutes les
--     6 min (cron.stale attend un succès en moins de 10 min) ;
--   * precompute-valuations (toutes les 5 min) : un dossier dû dans la file d'estimation, sinon une fois par
--     heure ;
--   * sale-retention (toutes les 5 min) : un reste annoncé par le dernier passage, sinon un passage toutes
--     les 15 min (cron.stale : 20 min) ;
--   * operational-health (toutes les 15 min) : un passage toutes les 30 min (cron.stale : 45 min) ;
--   * sale-flood-risk (toutes les heures) : un passage toutes les 2 h (cron.stale : 3 h) ; Géorisques refuse
--     nos appels depuis le 28/10 et chaque passage durait 37 s.
-- « Dû » se lit dans public.operational_job_runs (tout passage commencé, réussi ou non).
--
-- Le contrôle est inséré en tête du corps de chaque fonction existante, sans réécrire le reste (adresse et
-- secret lus dans Vault, route, délai d'attente), ici comme en production. Retour arrière : recréer ces
-- fonctions depuis leur dernière migration, ou faire rendre true à app_private.cron_dispatch_due.

create or replace function app_private.cron_job_started_since(p_job text, p_since timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.operational_job_runs run
    where run.job_name = p_job
      and run.started_at >= p_since
  );
$function$;

create or replace function app_private.cron_dispatch_due(
  p_job text,
  p_now timestamptz default statement_timestamp()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case p_job
    when 'information-agent-inbound' then
      exists (
        select 1
        from public.information_agent_inbound_jobs job
        where job.attempts < 10
          and job.available_at <= p_now
          and job.status in ('queued', 'failed', 'processing')
      )
      or not app_private.cron_job_started_since(p_job, p_now - interval '6 minutes')
    when 'precompute-valuations' then
      exists (
        select 1
        from public.auction_sale_market_estimates queue
        where queue.next_refresh_at <= p_now
      )
      or not app_private.cron_job_started_since(p_job, p_now - interval '1 hour')
    when 'sale-retention' then
      coalesce((
        select (run.summary->>'remaining') ~ '^[0-9]+$' and (run.summary->>'remaining')::bigint > 0
        from public.operational_job_runs run
        where run.job_name = p_job
          and run.status = 'success'
        order by run.started_at desc
        limit 1
      ), false)
      or not app_private.cron_job_started_since(p_job, p_now - interval '14 minutes')
    when 'operational-health' then
      not app_private.cron_job_started_since(p_job, p_now - interval '25 minutes')
    when 'sale-flood-risk' then
      not app_private.cron_job_started_since(p_job, p_now - interval '110 minutes')
    else true
  end;
$function$;

revoke all on function app_private.cron_job_started_since(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function app_private.cron_dispatch_due(text, timestamptz)
  from public, anon, authenticated, service_role;

comment on function app_private.cron_dispatch_due(text, timestamptz) is
  'Vrai quand la tâche pg_cron doit appeler sa route Vercel : travail en file ou passage de contrôle dû (20261110100713).';

do $guard$
declare
  target record;
  definition text;
  guarded text;
begin
  for target in
    select *
    from (values
      ('app_private.invoke_information_agent_inbound_endpoint()', 'information-agent-inbound'),
      ('app_private.invoke_market_valuation_precompute_endpoint()', 'precompute-valuations'),
      ('app_private.invoke_sale_retention_endpoint()', 'sale-retention'),
      ('app_private.invoke_operational_health_endpoint()', 'operational-health'),
      ('app_private.invoke_sale_flood_risk_endpoint()', 'sale-flood-risk')
    ) as targets(signature, job)
  loop
    definition := pg_catalog.pg_get_functiondef(target.signature::regprocedure);
    if position('app_private.cron_dispatch_due(' in definition) > 0 then
      continue;
    end if;
    guarded := pg_catalog.regexp_replace(
      definition,
      E'\nbegin\n',
      pg_catalog.format(
        E'\nbegin\n  -- Appel Vercel seulement s''il y a du travail ou un passage de contrôle dû (20261110100713).\n'
        || E'  if not app_private.cron_dispatch_due(%L) then\n    return null;\n  end if;\n',
        target.job
      )
    );
    if guarded = definition then
      raise exception using
        errcode = '55000',
        message = pg_catalog.format('%s: body start not found, review before guarding it.', target.signature);
    end if;
    execute guarded;
  end loop;
end;
$guard$;

commit;
