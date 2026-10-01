begin;

-- The inbound queue needs a sub-daily worker, which is not available on a
-- Vercel Hobby project.  Reuse the canonical origin and bearer secret already
-- managed by the operational scheduler, and let pg_cron dispatch the guarded
-- application route every two minutes.
create or replace function app_private.invoke_information_agent_inbound_endpoint()
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
    url => pg_catalog.rtrim(endpoint_url, '/') || '/api/cron/information-agent-inbound',
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

revoke all on function app_private.invoke_information_agent_inbound_endpoint()
from public, anon, authenticated, service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'immojudis-information-agent-inbound';

select cron.schedule(
  'immojudis-information-agent-inbound',
  '*/2 * * * *',
  'select app_private.invoke_information_agent_inbound_endpoint();'
);

notify pgrst, 'reload schema';

commit;
