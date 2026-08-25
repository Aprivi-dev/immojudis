# Exploitation des données — phase 3

## Architecture de supervision

Le contrôle primaire est exécuté toutes les 15 minutes par Supabase Cron. Le job
`immojudis-operational-health` lit son URL et `CRON_SECRET` dans Supabase Vault, puis appelle
`/api/cron/operational-health` avec un Bearer token. Le cron Vercel quotidien à `07:00 UTC` reste
un second déclencheur de secours compatible avec le plan Hobby.

Chaque passage :

1. écrit un run corrélé dans `public.operational_job_runs` et dans les Runtime Logs Vercel ;
2. mesure les crons applicatifs, webhooks Stripe, imports, files de refresh et données DVF ;
3. maintient une alerte dédupliquée dans `public.operational_alerts` ;
4. réclame atomiquement les notifications en attente ;
5. les expédie vers `OPERATIONS_ALERT_WEBHOOK_URL` ou, par défaut, vers le workflow GitHub
   `operational-alert.yml` au moyen de `GITHUB_SCROLL_TOKEN` ;
6. retente les échecs avec un délai exponentiel borné à une heure et expédie aussi les résolutions.

Le workflow GitHub termine en échec pour une ouverture ou un rappel d’incident, ce qui rend le
signal visible dans Actions et déclenche les notifications GitHub du dépôt. Une résolution produit
un run vert distinct. Les payloads sont bornés et ne contiennent ni secret ni donnée utilisateur.

## Objectifs de niveau de service

| Signal               | Objectif                                                                            | Alerte warning             | Alerte critical                                                          |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| Contrôle de santé    | au moins un passage réussi par fenêtre de 30 min ; disponibilité mensuelle ≥ 99,5 % | dernière mesure > 30 min   | scheduler absent/inactif ou contrôle durablement impossible              |
| Crons quotidiens     | dernier succès < 30 h                                                               | —                          | aucun succès dans la fenêtre                                             |
| Crons hebdomadaires  | dernier succès < 8 jours                                                            | —                          | aucun succès dans la fenêtre                                             |
| Webhook Stripe       | 99,9 % traités, aucun événement `processing` > 15 min                               | —                          | échec dans l’heure ou traitement > 15 min                                |
| Pipeline d’import    | démarrage de la file < 30 min, run < 3 h                                            | attente > 30 min           | attente > 2 h ou run > 3 h                                               |
| Refresh utilisateur  | démarrage < 30 min                                                                  | attente > 30 min           | attente > 2 h                                                            |
| DVF                  | au moins une transaction et un import terminé dans les 220 jours                    | dernier import > 220 jours | aucune donnée, import bloqué > 6 h ou échec postérieur au dernier succès |
| Notification externe | 99 % des transitions livrées dans les 20 min                                        | livraison en attente       | livraison en échec après tentative                                       |

Les seuils applicatifs ont été introduits dans
`supabase/migrations/20260727185139_phase_3_data_operations.sql` et la sémantique de récupération
DVF est corrigée dans `20260729143903_phase_5_observability.sql` : un échec historique reste auditable
mais ne maintient pas l'incident ouvert lorsqu'un import complet plus récent l'a remplacé. Toute
modification de seuil doit mettre à jour ce document et ses tests pgTAP dans le même changement.

## Tableaux de bord

- `/admin` → panneau **Readiness offre** : scheduler, dernière mesure, taux de succès sur 30 jours,
  cible SLO, alertes ouvertes, sévérité et état de livraison externe.
- Vercel → Observability / Runtime Logs, filtre
  `requestPath:/api/cron/operational-health` ou `scope:operational-alert-delivery`.
- Supabase → Integrations / Cron / `immojudis-operational-health` pour l’historique du scheduler.
- GitHub Actions → workflow **Immojudis Operational Alert** pour l’historique externe des incidents
  et résolutions.
- GitHub Actions → workflow **Production smoke** pour la disponibilité des parcours publics toutes
  les 30 minutes.

Requêtes de diagnostic :

```sql
select
  alert_key,
  category,
  severity,
  status,
  notification_event,
  notification_status,
  notification_attempt_count,
  notification_error,
  details,
  first_seen_at,
  last_seen_at,
  resolved_at
from public.operational_alerts
order by status, severity, last_seen_at desc;

select job_name, status, started_at, finished_at, duration_ms, error_message
from public.operational_job_runs
order by started_at desc
limit 100;

select jobid, jobname, schedule, active
from cron.job
where jobname like 'immojudis-operational%';
```

## Runbooks

### `cron.stale`

1. Lire `details.stale_jobs` pour identifier précisément le job.
2. Ouvrir les Runtime Logs Vercel sur la route correspondante et contrôler son dernier statut.
3. Corriger la cause, puis déclencher manuellement la route avec `CRON_SECRET`.
4. Vérifier au passage suivant que l’alerte est `resolved` et sa notification `delivered`.

### `stripe.webhook.unhealthy`

1. Contrôler `stripe_webhook_events` et les logs `/api/stripe/webhook`.
2. Pour un événement bloqué, vérifier la disponibilité Supabase et Stripe avant tout retry.
3. Rejouer depuis Stripe uniquement après confirmation de l’idempotence par `event_id`.

### `pipeline.import.unhealthy`

1. Contrôler `auction_runs`, puis le workflow `data-pipeline.yml` associé.
2. Ne pas démarrer un second run tant qu’un run sain est actif.
3. Marquer explicitement un run réellement abandonné, puis relancer le worker.

### `refresh_queue.stale`

1. Mesurer l’âge et le volume de `data_refresh_requests` en `queued`/`running`.
2. Vérifier la santé du pipeline avant une relance.
3. Traiter le plus ancien élément en premier et confirmer la baisse de l’âge maximal.

### `dvf.freshness`

1. Contrôler `dvf_import_batches` et le workflow `dvf-import.yml`.
2. Comparer l'échec actif au dernier batch `completed` : un échec antérieur est déjà remplacé et ne
   doit pas entraîner une nouvelle relance.
3. Vérifier la disponibilité et le checksum de la ressource officielle data.gouv.fr.
4. Relancer l’import semestriel, puis confirmer un batch `completed` et un nombre de transactions
   strictement positif.

### Notification externe en échec

1. Lire `notification_error` sans recopier de token dans un ticket ou un log.
2. Vérifier la permission Actions du PAT ou la disponibilité du webhook HTTPS.
3. Corriger le canal, puis relancer `/api/cron/operational-health` ; le claim reprend les entrées
   `failed` après leur `notification_next_attempt_at`.

## Migrations et dérive

La CI démarre une base Supabase éphémère, rejoue toutes les migrations depuis zéro, vérifie
l’absence de dérive `public,app_private`, exécute les tests de concurrence puis toute la suite
pgTAP. Le workflow de migration applique les changements en production, provisionne les secrets
Vault du scheduler et lance le même contrôle de dérive contre la base distante.

Le contrôle compare uniquement les objets applicatifs. Il ignore le schéma d’installation non
relocalisable de `pg_net` et les droits du connecteur externe `lovable_readonly`, tous deux gérés
hors migrations. Toute autre différence reste bloquante. Le bootstrap historique
`services/data-pipeline/sql/schema.sql` est limité aux bases locales jetables et refuse les URL
Supabase hébergées.

Commandes locales :

```bash
npx supabase@2.110.0 start
npx supabase@2.110.0 db reset --local --no-seed
npm run check:schema-drift
npm run test:db-concurrency
npx supabase@2.110.0 test db
```

Ne jamais exécuter `supabase db reset --linked` sur la production.

## Test du canal externe

Un test complet doit produire un workflow GitHub rouge pour une alerte réelle ouverte, puis un
workflow vert lors de sa résolution. Contrôler ensuite que `notification_status = 'delivered'` et
que `notification_error is null`. Le test unitaire de transport et le test pgTAP de claim/ack sont
également obligatoires en CI.
