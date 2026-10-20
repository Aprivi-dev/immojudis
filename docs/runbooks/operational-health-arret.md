# La tâche `operational-health` ne réussit plus (`/api/health` dégradé, `cron.stale`)

`operational-health` évalue toutes les alertes et répartit la collecte : si elle ne passe plus, plus aucune
alerte ne s'ouvre ni ne se ferme. `/api/health` devient `degraded` au-delà de 45 minutes sans succès ;
la sonde externe (`docs/operations/supervision-externe.md`) et le test de fumée s'en aperçoivent même si
GitHub et Supabase ne disent plus rien.

Chaîne : Supabase `pg_cron` (`immojudis-operational-health`, toutes les 15 min) → fonction
`app_private.invoke_*` (Vault : `immojudis_operational_health_url` et `_secret`) → `GET
/api/cron/operational-health` sur Vercel → `evaluate_operational_health`, `evaluate_market_valuation_health`,
`observe_autonomous_pipeline`, puis envoi des alertes ouvertes à GitHub Actions.

## Diagnostic

1. `curl -s https://immojudis.com/api/health` : `operationalHealth.ageMinutes`.
2. Derniers passages : `select status, started_at, finished_at, error_message from operational_job_runs
where job_name = 'operational-health' order by started_at desc limit 10;`
   - `failed` : lire `error_message` (une évaluation en échec, « No external operational alert channel is
     configured », échecs d'envoi à GitHub) et les journaux Vercel (`scope: cron`).
   - aucun passage : le job `pg_cron` ne part plus. `select jobname, active, schedule from cron.job;` puis
     `select status, return_message from cron.job_run_details order by start_time desc limit 10;`
3. 401 de la route : le secret de Vault n'est plus celui de `CRON_SECRET`.
4. Site tombé : état de Vercel et du dernier déploiement.

## Actions

- Secret ou origine périmés : `npm run ops:health-scheduler:configure` avec l'origine HTTPS de production et
  le `CRON_SECRET` courant (action du propriétaire).
- Job désactivé : le réactiver dans Supabase Cron (cadence `*/15 * * * *`).
- Canal d'alerte absent ou en échec : variables du workflow `operational-alert.yml` (voir
  `docs/operations-phase-5.md`, « Notification externe en échec »).

## Fermeture

Dès le premier succès, `/api/health` redevient `ok` ; `cron.stale` se ferme deux heures après.
