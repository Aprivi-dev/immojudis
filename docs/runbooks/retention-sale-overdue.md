# Alerte `retention.sale.overdue` (critique)

La purge des ventes échues (`/api/cron/sale-retention`, Supabase `pg_cron` toutes les 5 min, fonction
`purge_expired_auction_sales`) a du retard : la vente échue la plus ancienne (`catalogue_expiry_deadline`
dépassée) date de plus de **2 heures**, ou les **6 derniers passages** ont tous réussi en laissant des ventes
restantes (`remaining` > 0). Des ventes expirées restent alors au catalogue et leurs données conservées
au-delà de la durée prévue.

## Diagnostic

1. `select details from operational_alerts where alert_key = 'retention.sale.overdue';`
   (`overdue_count` plafonné à 1 001, `oldest_overdue_age_minutes`, `passes_with_remaining`).
2. Derniers passages : `select status, started_at, error_message, summary from operational_job_runs
where job_name = 'sale-retention' order by started_at desc limit 10;`
   - `failed` répétés : la purge lève une erreur ; lire `error_message` et les journaux Vercel de la route.
     Cas connu : un lot de 25 qui échoue en entier (collision d'index sur les événements de mesure à la
     suppression d'une vente, correction traitée par le point 1 du compte-rendu du 20/10).
   - `success` avec `busy: true` : un autre traitement tient le verrou de purge ; attendre le passage suivant.
   - `success` avec `deleted > 0` et `remaining` qui baisse : la purge rattrape un gros lot, rien à faire.
3. Aucun passage récent : voir aussi `cron.stale` (`sale-retention`, 20 min).

## Actions

Corriger la cause de l'échec par migration relue ; ne jamais supprimer des ventes à la main hors de la
fonction de purge (elle écrit les tombes de rétention et la file de suppression des fichiers).

## Fermeture

Automatique : plus de vente échue depuis plus de 2 h et une série de passages interrompue, puis deux heures
d'hystérésis.
