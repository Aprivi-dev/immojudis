begin;

set local lock_timeout = '5s';

-- Le calcul des pépites (route /api/cron/sale-pepites, migration 20261104100000) doit tourner toutes les
-- heures, ce que Vercel Hobby n'autorise pas (les crons Vercel restent quotidiens : le filet de vercel.json).
-- Même mécanisme que la complétude des annonces (20261024100100) : pg_cron appelle la route protégée avec
-- l'origine et le Bearer déjà chiffrés dans Vault par `npm run ops:health-scheduler:configure` (aucun nouveau
-- secret, aucune nouvelle configuration). Passage décalé à :35, pour ne pas tomber avec la complétude (:20),
-- la santé opérationnelle (:00, :15, :30, :45) ni les autres tâches horaires.
--
-- PREMIER CALCUL : la migration déclenche elle-même un premier passage à la fin (invoke_sale_pepites_endpoint),
-- sans attendre :35 ni l'appel manuel de la route. Sans secret Vault configuré, l'appel rend null et n'échoue pas
-- (même mécanisme que les autres tâches planifiées). L'appel est asynchrone (pg_net) : la migration n'attend pas
-- la route. Le mode initial est « shadow » : le premier passage calcule et stocke, rien n'est public.
--
-- SUPERVISION : toute redéfinition de app_private.evaluate_operational_health doit GARDER l'entrée
-- ('sale-pepites', interval '3 hours') de sa liste de tâches attendues, posée plus bas ; la retirer par
-- mégarde couperait l'alerte cron.stale de cette tâche.
--
-- RETOUR ARRIÈRE : cette migration se défait APRÈS 20261104110000 (dont on restaure d'abord
-- app_private.snapshot_sale_market_estimate) et AVANT 20261104100000 : cron.unschedule(jobid) pour la tâche
-- 'immojudis-sale-pepites', drop function app_private.invoke_sale_pepites_endpoint(), puis retirer
-- ', (''sale-pepites'', interval ''3 hours'')' de la liste de app_private.evaluate_operational_health (même
-- méthode : pg_get_functiondef, replace, execute). Voir l'en-tête de 20261104100000 pour la procédure complète.
create or replace function app_private.invoke_sale_pepites_endpoint()
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
    url => pg_catalog.rtrim(endpoint_url, '/') || '/api/cron/sale-pepites',
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

revoke all on function app_private.invoke_sale_pepites_endpoint()
from public, anon, authenticated, service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'immojudis-sale-pepites';

select cron.schedule(
  'immojudis-sale-pepites',
  '35 * * * *',
  'select app_private.invoke_sale_pepites_endpoint();'
);

-- Alerte de fraîcheur : ajouter la tâche à la liste des tâches attendues de cron.stale (trois passages
-- horaires manqués). Même méthode que 20261024100100 et 20261028130200 : refuser de deviner si une migration
-- ultérieure a changé la forme de cette liste.
--
-- Ordre de mise en production (docs/operations/planification.md, « Ajouter une tâche supervisée ») : déployer le
-- code qui porte la route AVANT cette migration, puis appeler la route une fois avec CRON_SECRET : tant qu'elle
-- n'a jamais réussi, cron.stale ouvre une alerte critique, qui se referme d'elle-même au premier succès.
do $$
declare
  definition text;
begin
  definition := pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure);
  if position('(''sale-pepites''' in definition) = 0 then
    if position('(''listing-completeness'', interval ''3 hours'')' in definition) = 0 then
      raise exception 'Operational health expected-jobs list changed; review sale pepites monitoring';
    end if;
    execute replace(
      definition,
      '(''listing-completeness'', interval ''3 hours'')',
      '(''listing-completeness'', interval ''3 hours''), (''sale-pepites'', interval ''3 hours'')'
    );
  end if;
end $$;

-- Premier passage immédiat (voir l'en-tête) : la route est appelée dès la fin de la transaction de pose, sans
-- attendre l'heure suivante. Appel pg_net asynchrone : un échec de la route ne fait pas échouer la migration.
select app_private.invoke_sale_pepites_endpoint();

notify pgrst, 'reload schema';

commit;
