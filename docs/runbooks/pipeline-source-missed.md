# Alerte `pipeline.source.<source>.missed` (critique)

Une source activée n'a pas terminé d'inventaire complet depuis plus de **18 heures**
(`last_inventory_complete_at`, à défaut la date d'activation de l'observation). Seuil : cadence de 12 h,
plus dispatch et exécution, plus deux passages de l'ordonnanceur (`20261020120019`). Une source qui ne se
termine plus ne publie plus : ses ventes vieillissent sans que personne le voie.

## Diagnostic

1. Lire l'alerte : `select details from operational_alerts where alert_key = 'pipeline.source.<source>.missed';`
   (`availability`, `last_inventory_complete_at`, `run_id`, `inventory_count`).
2. État de la source : `select enabled, suspended_until, suspension_reason, consecutive_failures,
last_attempt_at, last_error, availability from auction_source_state where source_name = '<source>';`
3. Dernier run : `select status, started_at, finished_at, summary->>'completion_status', errors from
auction_runs where id = <run_id>;` puis le workflow `data-pipeline.yml` correspondant (GitHub Actions).
   `completion_status = failed_before_start` : le job a échoué avant le pipeline (étape dans
   `summary->'startup_failure'`, le plus souvent l'installation des paquets système) ; la source n'a pas
   été contactée, voir « Échec avant démarrage » ci-dessous.
4. `availability = access_denied` ou `unavailable` : la source bloque ou est tombée. Contrôler à la main
   l'adresse de la source ; ne pas contourner un blocage (robots.txt, conditions d'utilisation).
5. Cause précise de l'arrêt : `select coverage->'publication_blocker_details'->'inventory_incomplete',
   coverage->'robots_policy' from auction_source_state where source_name = '<source>';`. La clé `stop_cause`
   vaut `robots_unavailable`, `robots_refused`, `list_fetch_failed` ou, à défaut, la raison d'arrêt de la
   couverture (`stop_reason`). Avec `robots_unavailable` ou `robots_refused`, voir « 0 requête : robots.txt
   illisible » ci-dessous.

## Actions

- Source tombée ou bloquée : laisser faire l'ordonnanceur (nouvelle tentative au prochain passage) ; si le
  blocage dure, suspendre la source (`suspended_until`, `suspension_reason`) plutôt que laisser l'alerte
  ouverte sans fin, et noter la cause.
- Run bloqué (`running` depuis plus de 3 h) : alerte `pipeline.import.unhealthy` (sa procédure est dans le
  dépôt interne, `docs/operations-phase-3.md`). En bref : contrôler `auction_runs` puis le workflow
  `data-pipeline.yml` associé ; ne pas démarrer un second run tant qu'un run sain est actif ; marquer
  explicitement un run réellement abandonné, puis relancer le worker.
- Pilote coupé ou plus aucune source récente : `docs/runbooks/pipeline-scheduler-disabled.md` et
  `docs/runbooks/pipeline-inventory-stale.md`.
- Cause de code (décodage de la source cassé) : corriger dans `services/data-pipeline/`, jamais en base.

### 0 requête : robots.txt illisible

Signe : passages qui échouent en moins d'une minute, `http_attempts 0` (`http_attempts_including_retries`),
`availability = unavailable`, `stop_reason = source_errors` et une seule erreur. Le client HTTP lit robots.txt
avant toute page (`PoliteHttpClient`, `services/data-pipeline/src/sources/common.py`) : s'il ne se lit pas,
aucune page n'est demandée, l'inventaire s'arrête et l'ordonnanceur recule (30 min, puis jusqu'à 6 h).
Enchères Immobilières, novembre 2026 : 7 passages sur 14 arrêtés ainsi.

Depuis le 16/11/2026 :

- robots.txt a au moins 4 essais, espacés de 5, 10 puis 20 s, quel que soit le budget d'essais des pages ;
- pendant une panne passagère (délai dépassé, erreur réseau, réponse 5xx), la dernière politique lue avec
  succès est réutilisée 24 heures au plus après cette lecture (RFC 9309 §2.4), avec ses Disallow et son
  Crawl-delay. Elle est gardée dans `auction_source_state.coverage->'robots_policy_copies'` (une entrée par
  origine, `verified_at`) et le journal du run l'annonce : « reusing the policy verified N h ago » ;
- un 401 ou un 403 sur robots.txt, une page de défi, un autre code 4xx, ou une copie de plus de 24 h gardent
  l'arrêt (`stop_cause` `robots_refused` ou `robots_unavailable`).

Diagnostic :

1. `coverage->'robots_policy'` : `state` (`verified`, `reused_copy` avec `copy_age_hours`, `unavailable`,
   `refused`), `error_type`, `status_code`, `transient`, `error` (message court).
2. `unavailable` et `transient = true` sans copie utilisable : panne passagère de la source, ou plus de 24 h
   sans lecture réussie. Ouvrir `https://<source>/robots.txt` à la main ; s'il répond, laisser l'ordonnanceur
   reprendre (la lecture réussie suivante refait la copie).
3. `unavailable` et `transient = false` (code 4xx autre que 401/403, redirection hors de la source) ou
   `refused` : la source refuse ou a changé d'adresse. Ne rien contourner ; vérifier la configuration de la
   source (`BASE_URL`, origines de redirection admises) et, si le refus dure, suspendre la source.
4. `reused_copy` : l'inventaire a tourné sur la copie. Rien à faire tant que la copie a moins de 24 h ; une
   copie qui vieillit d'un passage à l'autre dit que robots.txt ne se lit plus du tout.

### Échec avant démarrage (`failed_before_start`)

Depuis le 11/11/2026 (`docs/audits/2026-11-11-collecte-echec-avant-demarrage.md`), un job qui échoue avant
l'étape du pipeline (paquets système, dépendances Python, référentiels Justice) clôt son run tout de
suite : étape « Close run that never started » de `data-pipeline.yml`. Le run est `failed`, la source
redevient à échéance et le passage suivant part au prochain tick du lanceur.

- Un ou deux runs `failed_before_start` isolés : panne passagère du runner GitHub (réseau, miroir apt).
  Rien à faire, le passage suivant reprend la source.
- Plusieurs de suite : lire l'annotation d'erreur de l'étape en échec dans GitHub Actions. Panne du
  miroir apt ou de PyPI : attendre, ou couper le pilote le temps de la panne
  (`docs/runbooks/pipeline-scheduler-disabled.md`) pour ne pas accumuler les exécutions en échec.
- « Close run that never started » rouge : la clôture immédiate n'a pas pu écrire (base injoignable,
  secret absent). Le run se ferme alors à l'expiration de son bail d'une heure (`lease_expired`), comme
  avant ; rien à corriger en base.

## Fermeture

Automatique : elle se ferme deux heures après le premier inventaire complet suivant. Aucune remise à zéro
manuelle. Cas connu : `licitor` (ouverte depuis le 16/09), dont la cause est traitée par un autre chantier ;
l'alerte est gardée tant que l'inventaire n'aboutit pas.
