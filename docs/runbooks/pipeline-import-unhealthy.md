# Alerte `pipeline.import.unhealthy` (avertissement ou critique)

Les exécutions de collecte (`public.auction_runs`) ne passent plus. Évaluée par `operational-health` à chaque
passage (toutes les 30 minutes, `app_private.evaluate_operational_health`). Elle s'ouvre dans l'un de ces cas :

| Condition                                                              | Sévérité      | Détail                       |
| ---------------------------------------------------------------------- | ------------- | ---------------------------- |
| au moins 3 exécutions `failed` dans l'heure                            | avertissement | `failed_last_hour`           |
| au moins 1 échec dans l'heure **et** une exécution en file             | avertissement | `failed_last_hour`, `queued` |
| une exécution `running` démarrée il y a plus de 3 h                    | critique      | `stuck_running`              |
| l'exécution en file la plus ancienne attend depuis plus de **5 400 s** | avertissement | `oldest_queued_age_seconds`  |
| ... depuis plus de 7 200 s                                             | critique      | `oldest_queued_age_seconds`  |

Seuil d'âge de file (`maximum_queued_age_seconds`, migration `20261201100000`) : 2 x la cadence de 30 minutes
(c'est `operational-health` qui déclenche le workflow `data-pipeline.yml`) + la durée d'un passage d'environ
29 minutes, soit 89 minutes arrondies à 90 (règle « Règle pour un seuil » de `docs/operations/planification.md`).
Jusqu'au 16/11/2026 le seuil était de 1 800 s, égal à la cadence : une file de 1 802 s ouvrait l'alerte sans
incident. Un passage manqué ne suffit plus à alerter, deux oui.

## Diagnostic

1. Lire l'alerte :
   `select severity, details, first_seen_at from operational_alerts where alert_key = 'pipeline.import.unhealthy';`
2. Exécutions en file, en cours et en échec récent :

```sql
select id, source, status, created_at, started_at, finished_at,
       extract(epoch from now() - created_at)::integer as age_seconds,
       summary->>'completion_status' as completion, left(errors::text, 200) as errors
  from public.auction_runs
 where status in ('queued', 'running')
    or (status = 'failed' and coalesce(finished_at, updated_at, created_at) >= now() - interval '6 hours')
 order by created_at desc;
```

3. Le lanceur tourne-t-il ? Dernier passage d'`operational-health` :
   `select job_name, status, started_at, finished_at from operational_job_runs where job_name = 'operational-health'
order by started_at desc limit 5;` (une alerte `cron.stale` ouverte pour cette tâche explique tout le reste).
4. Pilote coupé : `select enabled, updated_at from auction_pipeline_control where id;` (alerte
   `pipeline.scheduler.disabled`).
5. Dans GitHub Actions, le run `data-pipeline.yml` correspondant à l'exécution (identifiant dans le nom du run).

## Décision

- **File qui attend** (`oldest_queued_age_seconds`) : le workflow n'est plus déclenché ou ne démarre pas.
  `operational-health` en retard : voir [`operational-health-arret`](operational-health-arret.md). Workflow
  déclenché mais en attente de runner, ou refusé : vérifier GitHub Actions (quota, panne). Ne pas créer de
  seconde exécution à la main tant que la première est en file.
- **Exécution bloquée** (`stuck_running`) : contrôler le run GitHub associé. S'il tourne encore, attendre ; s'il
  est terminé ou annulé sans avoir clos l'exécution, la marquer explicitement abandonnée (statut `failed`, avec
  la raison) puis laisser l'ordonnanceur relancer la source. Ne jamais démarrer un second run tant qu'un run sain
  est actif.
- **Échecs répétés** : lire `errors` et `summary->'startup_failure'`. `failed_before_start` : voir « Échec avant
  démarrage » dans [`pipeline-source-missed`](pipeline-source-missed.md). Échec d'une seule source : traiter
  l'alerte `pipeline.source.<source>.*` correspondante.

## Quand acquitter

Il n'y a pas d'acquittement : `operational_alerts` n'a que les statuts `open` et `resolved`, et l'alerte se
referme d'elle-même deux heures après le retour à la normale (plus d'échec dans l'heure, plus d'exécution en file
ancienne ni bloquée). Ne pas passer la ligne en `resolved` à la main : si la condition est encore vraie, le
passage suivant la rouvre et renvoie une notification.
