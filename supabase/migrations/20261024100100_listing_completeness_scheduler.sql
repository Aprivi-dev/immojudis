begin;

-- Le calcul du palier de complétude des annonces (route /api/cron/listing-completeness) doit tourner
-- toutes les heures, ce que Vercel Hobby n'autorise pas (les crons Vercel restent quotidiens, voir
-- vercel.json).  Même mécanisme que les autres jobs sous-quotidiens: pg_cron appelle la route
-- protégée avec l'origine et le Bearer déjà chiffrés dans Vault par
-- `npm run ops:health-scheduler:configure` (aucun nouveau secret, aucune nouvelle configuration).
create or replace function app_private.invoke_listing_completeness_endpoint()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint_url text;
  cron_secret text;
  request_id bigint;
begin
  select decrypted_secret into endpoint_url
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_url'
  order by updated_at desc
  limit 1;

  select decrypted_secret into cron_secret
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_secret'
  order by updated_at desc
  limit 1;

  if nullif(pg_catalog.btrim(endpoint_url), '') is null
    or nullif(pg_catalog.btrim(cron_secret), '') is null then
    raise warning 'ImmoJudis scheduler Vault secrets are not configured.';
    return null;
  end if;

  select net.http_get(
    url => pg_catalog.rtrim(endpoint_url, '/') || '/api/cron/listing-completeness',
    headers => jsonb_build_object(
      'Authorization', 'Bearer ' || cron_secret,
      'Accept', 'application/json',
      'User-Agent', 'immojudis-supabase-cron/1.0'
    ),
    timeout_milliseconds => 280000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function app_private.invoke_listing_completeness_endpoint()
from public, anon, authenticated, service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'immojudis-listing-completeness';

select cron.schedule(
  'immojudis-listing-completeness',
  '20 * * * *',
  'select app_private.invoke_listing_completeness_endpoint();'
);

-- Alerte de fraîcheur: ajouter la tâche à la liste des tâches attendues de cron.stale (trois
-- passages horaires manqués).  Même méthode que 20260928170000: refuser de deviner si une
-- migration ultérieure a changé la forme de cette liste.
do $$
declare
  definition text;
begin
  definition := pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure);
  if position('(''listing-completeness''' in definition) = 0 then
    if position('(''information-agent-inbound'', interval ''10 minutes'')' in definition) = 0 then
      raise exception 'Operational health expected-jobs list changed; review listing completeness monitoring';
    end if;
    execute replace(
      definition,
      '(''information-agent-inbound'', interval ''10 minutes'')',
      '(''information-agent-inbound'', interval ''10 minutes''), (''listing-completeness'', interval ''3 hours'')'
    );
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
