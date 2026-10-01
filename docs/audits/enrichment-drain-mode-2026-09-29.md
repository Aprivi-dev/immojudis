# Mode de drainage d'enrichissement — 29 septembre 2026

## Objet

La migration `20260929153000_enrichment_drain_mode.sql` ajoute une fenêtre
interne et réversible, `auction_pipeline_control.enrichment_drain_until`.
`NULL` ou une date passée laisse le planificateur dans son fonctionnement
normal. Une date future est limitée à six heures par un trigger et par la
fonction opérateur `app_private.set_enrichment_drain_until(timestamptz)`.

Pendant cette fenêtre, une file d'enrichissement due peut utiliser chaque tick
du planificateur même si `next_enrichment_at` vient d'être avancé par le tick
précédent. La règle de fraîcheur des sources reste active : une source due
depuis moins d'une heure peut être préemptée ; une source plus ancienne garde
son tour jusqu'à trois claims de collecte, puis la file reçoit un tour borné.
Le verrou `immojudis-pipeline-dispatch`, le verrou de ligne du contrôle et le
contrôle des runs actifs restent inchangés. Le mode n'autorise donc aucun
writer parallèle.

Ce mode ne crée pas de capacité supplémentaire. Il réduit le temps d'attente
entre deux claims, mais reste limité par le worker GitHub, les limites
fournisseur, les leases et les erreurs réseau ou documentaires. Il ne doit pas
être utilisé pour masquer une file qui continue de croître.

## Préflight et activation

La migration laisse le mode désactivé. Vérifier d'abord, avec le rôle
`service_role`, qu'aucun run automatique n'est `queued` ou `running`, que
la file due est réelle et que les sources les plus anciennes ont une fenêtre de
collecte acceptable :

```sql
select
  c.enabled,
  c.enrichment_drain_until,
  c.next_enrichment_at,
  count(j.id) filter (
    where j.status in ('queued', 'failed')
      and j.attempt_count < j.max_attempts
      and j.next_attempt_at <= statement_timestamp()
  ) as due_jobs
from public.auction_pipeline_control c
left join public.auction_enrichment_jobs j on true
where c.id
group by c.enabled, c.enrichment_drain_until, c.next_enrichment_at;

select count(*) as active_automatic_runs
from public.auction_runs
where scheduler_owned and status in ('queued', 'running');
```

Activer au maximum pour six heures :

```sql
select app_private.set_enrichment_drain_until(
  statement_timestamp() + interval '6 hours'
);
```

Désactiver immédiatement :

```sql
select app_private.set_enrichment_drain_until(null);
```

Une première fenêtre de deux heures a été activée en production le 29
septembre à 12 h 59 UTC, jusqu'à 14 h 59 UTC. Le précontrôle montrait zéro
run automatique actif, 7 320 tâches dues et Vench comme source la plus
ancienne due depuis 11 h 20 UTC. Contrôler périodiquement
`enrichment_drain_until`, les runs actifs, le nombre de tâches dues et l'âge
de la source la plus ancienne ; arrêter la fenêtre si les limites fournisseur
ou les échecs du worker deviennent le goulot. La fenêtre expire sans nouvelle
intervention si elle n'est pas renouvelée.

Le contrôle de 13 h 21 UTC suit une collecte Vench réussie à 13 h 18 et
constate zéro run automatique actif. Il compte encore 7 521 tâches dues,
dont 3 085 âgées de plus de 48 heures. Ce premier intervalle a absorbé une
collecte de source ; il ne démontre pas encore un gain de débit sur la file.
La fenêtre ne doit être renouvelée qu'après une nouvelle lecture du nombre
de tâches dues, de l'âge des sources et des erreurs du worker.
