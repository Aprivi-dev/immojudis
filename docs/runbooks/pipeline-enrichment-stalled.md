# Alertes `pipeline.enrichment.stalled` et `pipeline.enrichment.exhausted` (avertissements)

## `stalled`

Depuis `20261201100000`, l'alerte signale un **blocage** de la file d'enrichissement
(`auction_enrichment_jobs`), et non plus son âge : avec une file de plus de 1 000 tâches et un débit inférieur
à la file, « une tâche de plus de 24 h » était toujours vraie. Elle s'ouvre dans l'un de ces trois cas :

- **(a) bail expiré** (`expired_lease_24h`) : une tâche `running` dont le bail de 30 minutes a expiré depuis
  plus de 24 h (`coalesce(locked_at, updated_at)` de plus de 24 h 30), budget IA atteint ou non. La revendication
  aurait dû la reprendre : voir « Tâche `running` jamais reprise » plus bas.
- **(b) file qui ne bouge plus** : des tâches **prenables** restent non servies depuis plus de **72 h**
  (`unserved_72h`), **et** leur nombre n'a pas baissé en un jour. Chaque observation `enrichment-queue` garde les
  deux mesures : `unserved_72h_all` (toutes familles) et `unserved_72h_source_detail`. La mesure du régime courant
  (`unserved_72h_measure` : `unserved_72h_source_detail` sous budget atteint, `unserved_72h_all` sinon) est
  comparée à **la même mesure** de l'observation la plus récente prise **entre 48 h et 24 h** avant le passage
  (`unserved_72h_24h_before`, prise à `unserved_72h_compared_at`) : un budget atteint aujourd'hui et pas hier ne
  compare pas deux périmètres différents. Une file longue qui avance n'ouvre rien ; sans observation dans cette
  fenêtre (premier jour après la migration, observateur arrêté plus de 24 h), (b) n'ouvre rien non plus.
- **(c) tâche oubliée** : une tâche prenable n'est pas servie depuis plus de **7 jours** (`unserved_7d`, toutes
  familles, budget atteint ou non, sans tendance). La famille `enrichment_oldest` sert les plus anciennes une
  prise générale sur quatre, hors des pauses dues au budget IA : ce cas ne doit plus arriver. S'il
  arrive, la voie `enrichment_oldest` ne tourne pas (journal du travailleur, « Équité de la file » plus bas) ou le
  budget IA est nul depuis une semaine.

« Prenable » est la colonne `claimable` de l'observateur, les mêmes conditions que la revendication : vente
gardée (échéance de conservation matérialisée et non dépassée), révision la plus récente, source active et non
suspendue pour une tâche `source_detail`, aucun bail en cours sur la vente. « Non servie » : ni la dernière
écriture (`updated_at`) ni l'échéance (`next_attempt_at`) ne datent de moins de 72 h. Une description ou une
passe de faits qui attend la lecture des pièces de sa vente (tâche `pdf` encore en cours) n'est jamais comptée.

Les mesures précédentes restent dans les détails et dans l'observation, pour comparaison : `older_than_24h`
(tâches créées il y a plus de 24 h), `immobile_24h` (même définition que (a) et (b) avec 24 h au lieu de 72 h,
sans tendance), `claimable_due`, `excluded_due`, `backlog`.

### Report voulu par le budget IA

Le budget IA du jour (`LLM_DAILY_BUDGET_EUR` côté collecte, `daily_ai_budget_usd` côté contrôle du pilote) fait
reporter les tâches qui utilisent l'IA : le travailleur les remet en file avec l'erreur « Daily … budget
exhausted », rend la tentative et fixe la prochaine à minuit UTC (`defer_budget_jobs`). Le plafond horaire d'appels
(« Hourly LLM request budget exhausted », 60 appels sur les 60 dernières minutes, `reserve_llm_request`) et celui de
l'exécution (90 par 30 min) font de même, prochaine tentative 30 min plus tard. Seules les passes de faits
(`fact_extraction`) appellent l'IA ; la lecture des pièces (`pdf` : téléchargement, OCR local) jamais. Depuis
`20261205100000`, après un refus, les prises générales du travailleur ne sont plus que des lectures de pièces
(famille `enrichment_pdf`) pendant 5 minutes, puis une passe de faits est réessayée
(`GeneralClaimPlan` et `FACT_PASSES_RETRY_AFTER_BUDGET_SECONDS`, `src/enrichment_claim_schedule.py`) : une réservation refusée par processus toutes les
5 minutes au plus, aucune tentative perdue. Quand il ne reste rien d'autre que ces passes de faits, le passage
s'arrête avec `llm_budget_exhausted` (voir « Voie parallèle » plus bas). Avant `20261205100000` (et sur une base sans
la migration, qui refuse la famille en 22023), après le premier refus le travailleur ne prenait plus que des tâches
`source_detail`. Quand une tâche a été
reportée dans les 24 h (`budget_limited`), le cas (b) ne compte donc que les tâches `source_detail` ; les cas (a)
et (c) comptent toujours. La mesure reste visible dans `auction_pipeline_observations` (`source_name = 'enrichment-queue'`,
`budget_deferred_24h`).

Un retard structurel dû au budget ne s'alerte pas ; il se décide : relever `daily_ai_budget_usd` (route
d'administration du pilote) ou accepter l'attente.

### Diagnostic

1. `select details from operational_alerts where alert_key = 'pipeline.enrichment.stalled';`
   (`expired_lease_24h`, `unserved_72h`, `unserved_72h_measure`, `unserved_72h_24h_before`, `unserved_7d`,
   `budget_limited`, `claimable_due`).
2. Tendance de la file :
   `select observed_at, metrics->'unserved_72h_all', metrics->'unserved_72h_source_detail', metrics->'unserved_7d',
metrics->'budget_limited', metrics->'claimable_due', metrics->'backlog' from auction_pipeline_observations where
source_name = 'enrichment-queue' order by observed_at desc limit 96;`
3. Tâches comptées, en lecture seule (le cas, et ce qui rend une tâche prenable) :

```sql
select j.id, j.job_type, j.status, j.attempt_count, j.max_attempts, j.next_attempt_at, j.locked_at, j.updated_at,
       case when j.status = 'running' then 'a' else 'b' end as cas,
       j.status <> 'running' and j.job_type <> 'source_detail' as ne_compte_pas_sous_budget,
       s.status as sale_status, s.retention_deadline_materialized, s.retention_deadline,
       exists (
         select 1
           from public.auction_enrichment_jobs pdf
          where pdf.source_url = j.source_url
            and pdf.job_type = 'pdf'
            and pdf.status in ('queued', 'running', 'failed')
            and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)
       ) and j.job_type in ('display_description', 'fact_extraction') as attend_les_pieces
  from public.auction_enrichment_jobs j
  left join public.auction_sales s on s.source_url = j.source_url
 where (
         j.status = 'running'
         and coalesce(j.locked_at, j.updated_at) < now() - interval '24 hours 30 minutes'
       )
    or (
         j.status in ('queued', 'failed')
         and j.attempt_count < j.max_attempts
         and j.next_attempt_at <= now()
         and greatest(j.updated_at, j.next_attempt_at) < now() - interval '72 hours'
       )
 order by j.updated_at;
```

4. `claimable_due = 0` et `excluded_due > 0` : les tâches échues ne peuvent pas être prises (vente expirée,
   source désactivée ou suspendue, `source_details_enabled` faux). Corriger la condition, pas la file.
5. `claimable_due > 0` et rien ne bouge : le travailleur ne tourne pas ; voir le workflow `data-pipeline.yml`
   et `pipeline.scheduler.disabled`. Des runs `enrichment-queue` en `failed_before_start` : voir « Échec avant
   démarrage » dans `docs/runbooks/pipeline-source-missed.md`.
6. Le travailleur tourne mais une voie n'avance pas : lire « Équité de la file » ci-dessous.

### Tâche `running` jamais reprise (cas (a))

La revendication (`claim_auction_enrichment_jobs_family`) reprend une tâche `running` dont le bail de 30 minutes
a expiré, avec une tentative de plus, et la passe en `failed` à sa dernière tentative (test
`supabase/tests/898_enrichment_claim_reclaims_expired_lease.sql`). Une tâche reprise est classée comme une tâche
en file : elle n'a aucune priorité propre. Une lecture de pièces restée en `running` depuis le 11/11/2026 n'a
pas été reprise. Relevé du 16/11 : tentative 1 sur 4, échue, vente `upcoming` prenable, aucun autre bail. Cause :
le dernier cas ci-dessous, la tâche attendait son tour derrière les ventes proches (« Équité de la file ») ;
corrigé par la famille `enrichment_oldest` (`20261201100000`). Selon le code de la revendication, seules ces
raisons l'expliquent ; la requête suivante les départage (lecture seule) :

```sql
select j.id, j.attempt_count, j.max_attempts, j.next_attempt_at, j.locked_at, j.created_at,
       j.next_attempt_at <= now() as echue,
       j.attempt_count < j.max_attempts as essais_restants,
       s.status as sale_status, s.retention_deadline_materialized, s.retention_deadline,
       coalesce(
         s.status in ('active', 'unknown', 'upcoming', 'postponed', 'past')
           and s.retention_deadline_materialized
           and (s.retention_deadline is null or s.retention_deadline > now()),
         false
       ) as vente_prenable,
       exists (
         select 1
           from public.auction_enrichment_jobs other
          where other.source_url = j.source_url
            and other.id <> j.id
            and other.status = 'running'
            and coalesce(other.locked_at, other.updated_at) >= now() - interval '30 minutes'
       ) as autre_bail_en_cours,
       (
         select count(*)
           from public.auction_enrichment_jobs o
           join public.auction_sales os on os.source_url = o.source_url
          where o.job_type <> 'source_detail'
            and o.status in ('queued', 'failed')
            and o.next_attempt_at <= now()
            and o.attempt_count < o.max_attempts
            and o.priority + extract(epoch from now() - o.created_at) / 3600
                + case when o.job_type = 'pdf' then 24 else 0 end
                + case when os.sale_date between now() and now() + interval '7 days' then 168 else 0 end
              > j.priority + extract(epoch from now() - j.created_at) / 3600 + 24
                + case when s.sale_date between now() and now() + interval '7 days' then 168 else 0 end
       ) as taches_devant
  from public.auction_enrichment_jobs j
  left join public.auction_sales s on s.source_url = j.source_url
 where j.job_type = 'pdf'
   and j.status = 'running'
   and coalesce(j.locked_at, j.updated_at) < now() - interval '24 hours';
```

- `essais_restants` faux : la revendication de la voie générale l'aurait passée en `failed` ; elle n'a donc
  pas tourné du tout (travailleur arrêté, ou seule la voie `source_detail` est prise : budget IA atteint dès le
  début de chaque passage).
- `echue` faux : une échéance future a été écrite sur une tâche `running` (aucune écriture de ce genre n'existe
  dans `services/data-pipeline/src/` aujourd'hui : chercher une écriture manuelle).
- `vente_prenable` faux avec `retention_deadline_materialized` faux : la vente est gardée par prudence (la
  tâche n'est pas annulée) mais jamais prenable tant que son échéance de conservation n'est pas matérialisée.
  Corriger la matérialisation, pas la tâche.
- `autre_bail_en_cours` vrai : une autre tâche de la même vente renouvelle sans cesse son bail.
- Tout est vrai et `taches_devant` est grand : la tâche attend son tour dans la voie générale. Depuis
  `20261201100000`, une prise générale sur quatre la sert par ancienneté (`enrichment_oldest`) : elle doit être
  reprise dans les passages qui suivent. Si elle ne l'est pas, vérifier dans le journal du travailleur que la
  famille n'est pas refusée (« The database refused the enrichment_oldest queue family »).

Tant qu'elle reste en `running`, la description et les faits de sa vente l'attendent (la garde compte une tâche
`pdf` `running` quel que soit son bail). Ne pas la modifier par son identifiant sans avoir établi la cause.

### Équité de la file

Le travailleur alterne deux voies, réparties côté Python (`_enrichment_family_cycle` dans
`services/data-pipeline/src/queued_runner.py`) : `source_detail` (collecte des fiches) et `enrichment` (pièces,
faits, descriptions). Trois tâches `source_detail` pour une générale, ou une sur deux quand la file générale est
plus longue ; après un refus du budget IA, ses prises générales ne sont plus que des lectures de pièces
(`enrichment_pdf`) pendant 5 minutes (« Report voulu par le budget IA » plus haut). Une
description et une tâche `source_detail` ne sont donc jamais classées l'une contre l'autre par la base.

Dans la voie générale, la famille `enrichment` classe par score : `priority` + âge en heures + 24 si `pdf` + 168 si
la vente a lieu dans les 7 jours. Le 16/11/2026, la voie traitait ~115 tâches par jour pour ~600 en file : le bonus
de 168 points renouvelé chaque jour par les nouvelles ventes proches tenait en queue, pendant des jours, les tâches
des ventes lointaines (la lecture de pièces au bail expiré du 11/11, des lectures du 06/11).

Depuis `20261201100000` :

- **Part réservée à l'ancienneté.** La famille `enrichment_oldest` prend les mêmes tâches que `enrichment` (mêmes
  filtres : conservation, révision, bail en cours, attente des pièces ; bail expiré repris) mais par échéance la
  plus ancienne (`next_attempt_at`). Pendant un passage, le travailleur la demande une prise générale sur quatre
  (`services/data-pipeline/src/general_lane_claims.py`) ; les ventes proches gardent trois prises sur quatre et la
  famille `enrichment` garde son ordre. Une base sans la migration refuse la famille (SQLSTATE 22023) : le
  travailleur se replie sur `enrichment` jusqu'à la fin du passage et le note dans son journal.
- **Descriptions sans objet closes.** Depuis `20261112110000`, une tâche `display_description` ne produit plus
  rien : le travailleur la termine sans appel. La migration a clos de la même façon (statut `completed`) celles
  qui restaient en file, en échec avec essais restants ou en `running` au bail expiré avec essais restants ; les
  épuisées n'ont pas été touchées. **Une création subsiste** : la publication d'un fait de l'agent d'information
  (`app_private.apply_information_agent_fact`, migration `20261119100900`) insère encore une tâche
  `display_description` (priorité 90) ; le travailleur la termine aussitôt. Contrôle :
  `select count(*) from auction_enrichment_jobs where job_type = 'display_description' and created_at > now() -
interval '24 hours';`

Une passe de faits n'est jamais prise tant que la tâche `pdf` de sa vente peut encore avancer. Requête de
contrôle :

```sql
select j.job_type,
       exists (
         select 1 from public.auction_enrichment_jobs pdf
          where pdf.source_url = j.source_url and pdf.job_type = 'pdf'
            and pdf.status in ('queued', 'running', 'failed')
            and (pdf.status = 'running' or pdf.attempt_count < pdf.max_attempts)
       ) as attend_les_pieces,
       count(*), min(j.updated_at)
  from public.auction_enrichment_jobs j
 where j.status in ('queued', 'failed') and j.job_type in ('display_description', 'fact_extraction')
 group by 1, 2;
```

### Voie séparée des collectes (17/11/2026)

Décision du propriétaire, étape 1 : la file tourne en continu, séparée des collectes (migration `20261203100000`,
`services/data-pipeline/src/collection_priority.py`, `src/autonomous_runner.py`).

- **Qui lance quoi.** À chaque passage d'`operational-health` (30 min), le site appelle
  `claim_autonomous_pipeline_run()` une fois par voie : une collecte due, puis la file. Chaque voie a au plus une
  exécution active. La file part dans son propre groupe de concurrence GitHub (`immojudis-enrichment-queue`,
  entrée `enrichment_only`), les collectes restent dans `immojudis-data-pipeline`.
- **Unité de la file.** Elle enchaîne des passages comme avant (travailleur : 180 tâches et 1 200 s au plus, puis
  passes facultatives) jusqu'à son bail (`running_lease_seconds`, 7 200 s, écrit par le planificateur) moins 15
  minutes, soit 105 minutes ; elle s'arrête plus tôt quand la file est vide ou que le travailleur échoue. Elle part au
  passage d'`operational-health` qui suit sa fin.
- **Pas une requête de plus par site.** Les passes facultatives qui contactent un hôte extérieur (vidage des pièces,
  positions BAN, photos des pièces, historique Licitor) gardent leur volume d'avant la voie, environ 17 tours par
  jour : une fois par unité au plus, et seulement si aucune exécution de la file qui les a faites n'a fini depuis
  24 h / 17 (85 min ; `EXTERNAL_PASS_KEYS` et `EXTERNAL_PASS_MIN_INTERVAL`, `src/autonomous_runner.py`). Sinon,
  `passes_skipped` porte `site_cadence`. La lecture des pièces (IA seulement, bornée par le budget IA) suit chaque
  passage du travailleur.
- **Jamais en même temps qu'une collecte.** Dès qu'une collecte est demandée (lancement en vol ou accepté, ou
  exécution manuelle en file) ou en cours, le travailleur ne prend plus de lot et se termine, ce qui rend le
  verrou des écritures du catalogue ; l'unité attend la fin de la collecte (`collection_wait_seconds`) et saute ses
  passes facultatives (`passes_skipped`). La collecte, avant d'être prise et avant que son budget ne coure,
  attend ce verrou 25 minutes au plus (`catalogue_prewait` dans son résumé) : le lot en cours se termine. Le
  travailleur n'écrit le catalogue que sous ce verrou (test
  `test_the_queue_worker_writes_the_catalogue_only_under_its_writer_lock`).
- **Un seul processus à la fois vers les sources.** Verrou consultatif `immojudis:source-traffic:v1`
  (`src/source_traffic.py`) : une collecte planifiée le prend avant de démarrer (avec l'attente du verrou du
  catalogue, bornée par 25 min et par le bail de sa ligne en file moins 5 min) et le garde jusqu'à la fin de ses
  écritures, elles-mêmes faites sous le verrou du catalogue ; la copie de ses photos le prend à son tour (4 min
  d'attente au plus, sinon reportée) ; l'unité le prend autour de chaque passe qui contacte un hôte (sinon
  `source_traffic_busy`) ; le travailleur le reprend lot par lot sans attendre et cède dès qu'un autre l'attend.
  Une collecte n'interroge donc jamais un site en même temps que la file. Ces attentes de verrou ne sont jamais
  coupées par le `statement_timeout` de 2 min de la session (incident du 17/11/2026 : une unité morte en
  `QueryCanceled` derrière une collecte de 13 min) : seul leur `lock_timeout` les borne
  (`catalogue_lock.queued_wait`). Une unité dont le tour des sources n'est pas venu s'arrête proprement,
  `stop_reason` = `source_traffic_busy`.
- **Plafond d'appels IA par exécution.** `max_ai_predictions_per_run` (90) se compte sur les 30 dernières minutes de
  l'exécution (migration `20261203100000`) : chaque passage d'une unité garde le plafond d'un passage d'avant
  (24 appels en moyenne, 39 au plus sur 56 passages mesurés). Le budget quotidien (`daily_ai_budget_usd`) et le
  plafond horaire restent les garde-fous globaux. Un report « AI prediction budget exhausted for this execution » ne
  devrait plus se voir en régime normal.
- **Retour arrière sans commit.** Variable de dépôt GitHub `ENRICHMENT_LANE=off` : chaque unité de la file ne
  fait plus qu'un passage (environ 30 minutes), toujours dans son groupe. Retour complet :
  `supabase/maintenance/20261203100000_restore_pipeline_scheduler_before_lanes.sql` remet les corps exacts d'avant
  la migration (dont `claim_autonomous_pipeline_run` : 20260929153000 retouchée par 20260929235500, 20261001070853
  et 20261016100000, md5 `0ee8bdb4cd09923283f3f3a357852b0f`), quand aucune unité de file ne tourne.

Une unité `running` de la file à côté d'une collecte `running` est l'état normal. Le cas (a) ci-dessus (bail d'une
tâche) et l'observation `enrichment-queue` ne dépendent pas du nombre d'unités : rien n'y change.

**Mesure** (à lire deux jours après la mise en production ; les lignes `auction_runs` de la file portent
`summary->'enrichment_unit'` et `summary->'enrichment_jobs_by_type'` depuis ce lot) :

```sql
-- Durée de travail de la file par jour, attente des collectes déduite.
select date_trunc('day', started_at) as jour,
       count(*) as unites,
       count(*) filter (where summary #>> '{enrichment_unit,mode}' = 'lane') as unites_voie_separee,
       round(sum(extract(epoch from finished_at - started_at)) / 3600, 1) as heures_unites,
       round(sum(coalesce((summary #>> '{enrichment_unit,collection_wait_seconds}')::numeric, 0)) / 3600, 1)
         as heures_attente_collectes,
       jsonb_agg(summary #>> '{enrichment_unit,stop_reason}') as raisons_arret
  from public.auction_runs
 where source = 'enrichment-queue' and started_at >= now() - interval '3 days' and finished_at is not null
 group by 1 order by 1;

-- Tâches traitées par type et par jour (statut final atteint pendant les unités).
select date_trunc('day', r.started_at) as jour, t.key as type_tache,
       sum(coalesce((t.value->>'completed')::integer, 0)) as terminees,
       sum(coalesce((t.value->>'failed')::integer, 0)) as en_echec
  from public.auction_runs r
  cross join lateral jsonb_each(coalesce(r.summary->'enrichment_jobs_by_type', '{}'::jsonb)) t
 where r.source = 'enrichment-queue' and r.started_at >= now() - interval '3 days'
 group by 1, 2 order by 1, 2;

-- Taille de la file (prenables ou non), par type et par site.
select job_type, detail_source_name, status, count(*)
  from public.auction_enrichment_jobs
 where status in ('queued', 'running', 'failed') and attempt_count < max_attempts
 group by 1, 2, 3 order by 1, 2, 3;

-- Attente des collectes avant démarrage (doit rester de quelques secondes à quelques minutes).
select source, count(*), max((summary #>> '{catalogue_prewait,seconds}')::numeric) as attente_max_s,
       count(*) filter (where summary #>> '{catalogue_prewait,timed_out}' = 'true') as attentes_depassees
  from public.auction_runs
 where source <> 'enrichment-queue' and scheduler_owned and started_at >= now() - interval '3 days'
 group by 1 order by 1;
```

### Voie parallèle : 1 processus de fiches + N de pièces et de faits (17/11/2026)

Décision du propriétaire du 17/11/2026 : dans chaque unité de la voie séparée, un processus ne prend que les
relectures de fiches (`source_detail`) et N processus ne prennent que la famille générale (`pdf`,
`fact_extraction`, `enrichment_oldest`), côte à côte (`src/autonomous_runner.py`, `_run_lane_workers` ;
`python -m src.queued_runner --enrichment-only --family source_detail|enrichment`). L'unité attend la fin de
tous les processus, puis fait ses passes facultatives comme avant ; l'échec d'un processus n'arrête pas les autres
(il arrête l'unité après le passage, comme l'échec du travailleur unique). Le cycle n'est « à vide »
(fin de l'unité) que si **tous** les processus le sont : un processus de fiches à vide en quelques
secondes attend le cycle suivant. Raison d'arrêt du cycle à vide : `llm_budget_exhausted` si un processus général n'a
plus trouvé que des passes de faits refusées par le budget IA, `queues_empty` seulement sinon. Les sorties sont
préfixées `[famille#n]` ; si l'unité s'arrête (exception, job
annulé), les processus encore en vie sont terminés. Une tâche n'est reprise par un autre processus qu'après 30 min
sans nouvelle (`locked_at`) : un processus de la voie est tué 25 min au plus après le début de son passage, et
chaque processus télécharge dans son propre fichier temporaire.

- **Réglages** (variables de dépôt GitHub, `src/enrichment_lane_settings.py`) :
  `PIPELINE_ENRICHMENT_GENERAL_WORKERS` (0 à 3, **2 par défaut**), `PIPELINE_WORKER_LOCK_MODE`
  (`exclusive`/`shared`) et `PIPELINE_HOST_TURNS` (`on`/`off`). Vides, les deux derniers suivent N (`shared` et
  `on` dès que N ≥ 1). N ≥ 1 avec `exclusive` ou avec `off` est refusé au démarrage de l'unité (run `failed`,
  erreur « Enrichment lane settings refused: … ») et du travailleur (code 3).
- **Retour arrière, sans commit** : `PIPELINE_ENRICHMENT_GENERAL_WORKERS=0` ramène le travailleur mixte unique,
  en verrous exclusifs et sans tours par hôte. Puis, si besoin, `ENRICHMENT_LANE=off` (un seul passage par unité)
  et `PIPELINE_SOURCE_AUTO_SUSPEND=off` (espacement progressif d'avant pour une source muette, plus de nouvelle
  suspension ; `docs/runbooks/pipeline-source-missed.md`). **Ce n'est pas l'avant à l'identique** : restent, quel
  que soit N, l'attente des verrous dans la file de PostgreSQL (au lieu d'essais espacés), la copie commune de
  robots.txt et l'attente sans requête après un échec récent, le report sans essai d'une publication sur
  `lock_timeout`, et le report des pièces d'un site suspendu (`suspended_host_until`).
- **Jamais deux écrivains sur une vente** : la revendication refuse une tâche dont la vente a une tâche `running`
  de moins de 30 min et verrouille la tâche et la vente (`for update of j, s skip locked`) ; toutes les
  revendications passent par `claim_auction_enrichment_jobs_request`, sérialisées par le verrou de transaction
  `immojudis:queue-claim-backoff` (test `supabase/tests/907_parallel_enrichment_claims.sql`). Chaque publication
  prend le verrou `immojudis:outcome_catalogue_bridge:v1` et compare `updated_at` (garde de version).
- **Verrous en mode partagé** : les processus de la voie prennent le verrou des écritures du catalogue et le tour
  des sources **en partagé** ; tout le reste les prend en exclusif (collectes, recalcul, vidage des pièces,
  anonymisation, positions, copie des photos, passes externes de l'unité). Une demande exclusive attend dans la
  file de PostgreSQL et fait échouer toute nouvelle demande partagée : une collecte n'est jamais affamée.
- **Tours par hôte** (`src/host_turn.py`) : jamais deux processus sur le même site en même temps. Le tour d'un
  hôte (clé `immojudis:host-turn:v1:<hôte sans www>`) est tenu pendant la requête et ses reprises, puis rendu une
  fois écoulé le délai du site (le nôtre ou le `Crawl-delay`). Attente bornée (180 s ou l'échéance du passage) :
  au-delà, la tâche est remise en file sans perdre d'essai, 15 min plus tard (fiches ; 30 min pour les pièces)
  quand l'hôte était seulement occupé, journalisée « Host turn of … not obtained after … s (busy) », et le
  processus n'attend plus cet hôte pendant 10 min. Une session de tours perdue pendant une requête compte un tour
  perdu (`host_turns.lost` du compte rendu) ; un battement garde la session ouverte tant qu'un tour est tenu. Les démarrages Replicate passent par la même règle
  (`api.replicate.com`, 11 s entre deux envois, tous processus confondus : le tour est pris avant les réservations
  et rendu juste avant l'envoi). Seuls les processus de la voie
  prennent ces tours, ainsi que le vidage manuel des pièces (`python -m src.document_backlog` et ses processus de
  préparation, groupe de concurrence à part) quand ils sont allumés ; tout autre processus qui parle aux sources
  tient le tour des sources en exclusif, donc seul.
- **robots.txt commun** (`app_private.robots_policies`, migration `20261204100000`) : une lecture de moins de
  30 min tient lieu de lecture pour tous les processus ; au-delà, elle reste le repli d'une panne passagère
  (24 h). Lectures par hôte et par jour : 48 au plus (avant : une par passage, ~72, et une par processus). Après
  un échec, la sonde suivante s'espace : 1 h, 2 h, 4 h, puis 6 h (`robots_policy_copies.probe_interval`).
- **`lock_timeout` de publication** (15 s sur le verrou de publication) : la publication est annulée et la tâche
  remise en file 5 min plus tard **sans perdre d'essai** (`pipeline_usage.publication_lock_deferral`), pour les
  fiches comme pour les pièces ; 6 fois d'affilée au plus (`last_error` porte le compte, « [n/6] ») : au-delà,
  l'essai est consommé, pour qu'une tâche ne revienne pas sans fin.
- **Plafond IA** : tous les processus portent le `AUTONOMOUS_RUN_ID` de l'unité ; `max_ai_predictions_per_run`
  (90 par 30 min) reste celui de l'unité entière, le budget quotidien et le plafond horaire ne changent pas.
- **Budget IA atteint : les pièces continuent** (migration `20261205100000`, famille `enrichment_pdf`). Incident de
  la première unité (17/11, 15:30-15:54 UTC) : chaque processus général s'arrêtait au premier refus du plafond
  horaire (`llm_budget_exhausted`), l'unité prenait cet arrêt pour une file vide et se terminait en `queues_empty`
  au bout de 24 min, avec 189 lectures de pièces et 175 passes de faits échues en file (3 pièces terminées en deux
  heures). Désormais, après un refus, un processus général ne prend plus que des lectures de pièces pendant 5 min,
  puis réessaie une passe de faits ; il ne s'arrête en `llm_budget_exhausted` que lorsqu'aucune pièce n'est prenable.
  L'unité continue tant qu'un processus a travaillé jusqu'à son budget, et ne se termine en `llm_budget_exhausted`
  que si tous les processus sont à vide et qu'il reste des faits bloqués par le budget. Chaque processus compte ses
  refus (`llm_budget_refusals` du compte rendu).
- **Un processus « pièces d'abord »** : avec N ≥ 2, le premier processus général (`--pdf-first`) demande d'abord
  les lectures de pièces (`enrichment_pdf`), puis la famille générale quand il n'en reste aucune ; les autres gardent
  l'ordre par score (+24 pour une pièce) et la part `enrichment_oldest`. Les faits d'une vente attendent de toute
  façon sa lecture de pièces, et sont bornés par le plafond horaire (60 appels par heure, un document peut en
  demander plus de 100) : un processus suffit à les servir. Avec N = 1, le processus garde l'ordre par score, sans
  quoi les faits attendraient la fin de tout l'arriéré de pièces pendant que le budget IA reste inutilisé.
  `pdf_first` est dans le compte rendu de chaque processus.
- **Base sans `20261205100000`** : elle refuse la famille (22023) ; le travailleur le note (« The database refused the
  enrichment_pdf queue family ») et garde, jusqu'à la fin de son passage, la règle d'avant (plus aucune prise
  générale après le premier refus du budget IA, prise générale ordinaire pour le processus « pièces d'abord »).
  L'unité s'arrête alors en `llm_budget_exhausted`, pièces en attente ou non : appliquer la migration.
- **Écart de 11 s entre deux démarrages Replicate : inchangé.** Il vient de la limite que Replicate peut appliquer
  à un compte (6 créations de prédiction par minute, rafale de 1 : `src/config.py`, `replicate_min_interval_seconds`).
  Rien dans le dépôt n'établit que le compte en est sorti ; sous cette limite, un écart plus court ferait des 429.
  Sous le plafond horaire, il ne freine pas : 60 appels espacés de 11 s prennent 11 min, et le plafond est atteint
  bien avant la fin de l'heure. Les ~70 s d'attente par processus et par cycle relevés le 17/11 viennent des faits
  pris par les deux processus à la fois ; avec la reprise des pièces, ils ne coûtent plus que ces secondes, pas le
  passage.
- **Calcul** : `OMP_NUM_THREADS` (et BLAS) = 4 / (N + 1), Tesseract à un fil (`OMP_THREAD_LIMIT=1`) : N OCR à la
  fois sur 4 vCPU, sans surcharge (Docling coupé : aucun modèle chargé N fois). Délais d'OCR inchangés (60 s par
  page pour ~1 s mesurée).
- **Connexions de session** (pooler en mode session) : trois par processus de la voie (verrou du catalogue, tour
  des sources, tours par hôte), soit 3 × (N + 1) : 9 avec N = 2, 12 avec N = 3, plus 2 pour une collecte qui
  attend. Le défaut est 2 tant que la taille du pool de sessions (« Pool size » du pooler Supabase) n'a pas été
  vérifiée à 20 ou plus ; à 15 (petites instances), N = 3 laisserait trop peu de marge.
- **Surveillance inchangée** : une seule ligne `auction_runs` par unité, comme avant ; `stalled`, `exhausted`,
  `pipeline.import.unhealthy`, `cron.stale` et l'observation `enrichment-queue` lisent la file et les runs, pas
  le nombre de processus.

**Mesure** (lecture seule ; chaque cycle porte `workers`, un objet par processus) :

```sql
-- Tâches prises par type et par processus, secondes d'OCR, attentes de tour par hôte, reports pour lock_timeout.
select date_trunc('day', r.started_at) as jour, w->>'family' as famille,
       coalesce((w->>'pdf_first')::boolean, false) as pieces_d_abord, count(*) as passages,
       sum(coalesce((w->>'handled')::integer, 0)) as traitees,
       sum(coalesce((w->'claimed_by_job_type'->>'pdf')::integer, 0)) as pdf_prises,
       sum(coalesce((w->'claimed_by_job_type'->>'fact_extraction')::integer, 0)) as faits_pris,
       sum(coalesce((w->'claimed_by_job_type'->>'source_detail')::integer, 0)) as fiches_prises,
       round(sum(coalesce((w->>'ocr_seconds')::numeric, 0))) as secondes_ocr,
       round(sum(coalesce((w->'host_turns'->>'wait_seconds')::numeric, 0))) as attente_tours_s,
       sum(coalesce((w->'host_turns'->>'timeouts')::integer, 0)) as tours_depasses,
       sum(coalesce((w->>'publication_lock_deferrals')::integer, 0)) as reports_lock_timeout,
       sum(coalesce((w->>'llm_budget_refusals')::integer, 0)) as refus_budget_ia,
       count(*) filter (where w->>'stop_reason' = 'llm_budget_exhausted') as arrets_budget_ia,
       count(*) filter (where (w->>'exit_code')::integer <> 0) as processus_en_echec
  from public.auction_runs r
  cross join lateral jsonb_array_elements(coalesce(r.summary #> '{enrichment_unit,cycles}', '[]'::jsonb)) c
  cross join lateral jsonb_array_elements(coalesce(c->'workers', '[]'::jsonb)) w
 where r.source = 'enrichment-queue' and r.started_at >= now() - interval '3 days'
 group by 1, 2, 3 order by 1, 2, 3;

-- Pièces lues par jour (tâches pdf terminées) et fiches en attente.
select date_trunc('day', completed_at) as jour, count(*) as pieces_lues
  from public.auction_enrichment_jobs
 where job_type = 'pdf' and status = 'completed' and completed_at >= now() - interval '3 days'
 group by 1 order by 1;
select count(*) as fiches_en_attente
  from public.auction_enrichment_jobs
 where job_type = 'source_detail' and status in ('queued', 'failed') and attempt_count < max_attempts
   and next_attempt_at <= now();

-- Publications reportées pour lock_timeout et jamais reprises (doit rester vide).
select id, job_type, status, attempt_count, next_attempt_at, updated_at
  from public.auction_enrichment_jobs
 where last_error like 'Publication lock busy (lock_timeout)%'
   and updated_at < now() - interval '2 hours' and status in ('queued', 'failed');

-- Appels IA par unité et par tranche de 30 min (plafond 90) et dépense du jour.
select run_id, date_trunc('hour', created_at) + interval '30 min' * floor(extract(minute from created_at) / 30)
         as tranche, count(*) as appels
  from public.auction_pipeline_usage
 where created_at >= now() - interval '1 day'
 group by 1, 2 having count(*) > 60 order by 3 desc;
```

**Critères de réussite**, deux jours après la mise en production : pièces lues ≥ 130 par jour ; fiches en attente
< 100 ; aucun report `lock_timeout` non repris (troisième requête vide) ; attente des collectes avant démarrage
inchangée (dernière requête de la section précédente) ; appels IA sous leurs plafonds (aucune tranche à 90, aucun
« Daily AI budget exhausted » avant l'heure habituelle) ; aucune unité terminée en `queues_empty` ou en
`llm_budget_exhausted` alors que des lectures de pièces prenables attendaient (comparer `raisons_arret` de la
première requête de la section précédente avec la taille de la file `pdf`). Sinon : `PIPELINE_ENRICHMENT_GENERAL_WORKERS=1`, ou `0`.

## `exhausted`

Une tâche `failed` dont `attempt_count >= max_attempts` n'est plus jamais prise (lettre morte). L'alerte s'ouvre
quand :

- au moins **greatest(10, 2 % de la file vivante)** tâches sont devenues épuisées dans les dernières 24 h
  (`exhausted_24h`) ; la file vivante est `backlog` moins les tâches épuisées. Avec ~1 280 tâches vivantes, le
  seuil est 26. Avant `20261201100000`, il était de 3 : six épuisements en un jour sur plus de 1 000 tâches
  ouvraient l'alerte ;
- ou au moins **50** tâches épuisées attendent une décision (`exhausted`).

Les seuils appliqués sont dans les détails : `exhausted_24h_threshold` (seuil calculé), `exhausted_24h_minimum`,
`exhausted_24h_queue_share`, `exhausted_threshold`. Un report par le budget ne consomme pas de tentative : cette
alerte ne vient jamais du budget. Procédure de traitement manuel : `docs/pipeline-reliability.md`, section « Jobs
d'enrichissement épuisés ».

## Fermeture

Automatique, deux heures après le retour à la normale. Acquitter à la main n'a pas de sens : tant que la
condition est vraie, le passage suivant la rouvre.
