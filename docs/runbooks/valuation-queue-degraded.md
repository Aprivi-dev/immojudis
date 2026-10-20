# Alerte `valuation.queue.degraded`

Évaluée par `public.evaluate_market_valuation_health` (appelée par `operational-health`, toutes les
15 min). S'ouvre quand il existe des estimations et que :

- moins de 95 % sont traitées (`processed_pct`, les `insufficient_data` valides comptent comme traitées), ou
- la plus ancienne estimation échue attend depuis plus de 15 min (`oldest_due_seconds`), ou
- plus de 5 tentatives ont échoué dans l'heure (`failed_last_hour`).

Critique quand `processed_pct < 75` ou `oldest_due_seconds > 3600`, avertissement sinon.

## Diagnostic

1. `select details from operational_alerts where alert_key = 'valuation.queue.degraded';`
2. `failed_last_hour` élevé : `select outcome, error, created_at from valuation_estimate_attempts
where created_at >= now() - interval '1 hour' order by created_at desc limit 20;`
3. `due` et `oldest_due_seconds` élevés sans échec : le pré-calcul ne tourne pas. Il est déclenché par la file
   de valorisation (Supabase `pg_cron`, `/api/cron/precompute-valuations`, toutes les 5 min) et n'est pas
   supervisé par `cron.stale` : regarder `operational_job_runs` pour `precompute-valuations` et les journaux
   Vercel de la route.
4. Un modèle de valorisation absent ou non publié fait échouer les estimations : contrôler la version
   publiée (`npm run valuation:publish` est une action du propriétaire, jamais d'un agent).

## Actions

Corriger la cause (route, secret `CRON_SECRET`, modèle), puis appeler la route une fois avec
`Authorization: Bearer $CRON_SECRET` pour vérifier qu'elle traite. Ne pas vider ni réécrire
`auction_sale_market_estimates` à la main.

## Fermeture

Automatique : sous les seuils, l'alerte devient inactive puis se ferme après deux heures.
