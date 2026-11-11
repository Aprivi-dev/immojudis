# Collecte : deux passages perdus avant le démarrage du pipeline (11/11/2026)

Note rédigée le 11/11/2026 avec le correctif (branche `claude/collecte-demarrage-robuste`). Lecture des
journaux des deux exécutions seulement : aucun workflow lancé, aucune écriture en base.

## Cause

Le workflow `data-pipeline.yml` a échoué deux fois de suite (exécutions 4209 à 14:30 UTC et 4210 à
15:30 UTC) à l'étape « Install document extraction packages ». Le runner GitHub ne résolvait plus le nom
de son miroir apt (`Temporary failure resolving 'azure.archive.ubuntu.com'`), alors que le reste du
réseau répondait (les dépôts `packages.microsoft.com` ont été lus normalement dans la même étape).

- `apt-get update` a mis 3 min 30 à ne rien lire, a affiché des avertissements et a rendu le code 0.
- `apt-get install` a ensuite réessayé chaque archive pendant 6 min, puis a échoué (code 100).

Neuf minutes par passage, et le pipeline Python n'a jamais démarré.

## Effet en cascade

1. Les étapes `if: always()` qui suivent ont tourné sans les dépendances Python (leur installation vient
   après celle des paquets système) et ont planté : `ModuleNotFoundError` pour `src.run_finalizer`,
   `src.cache_invalidation`, `src.pipeline_health` et `src.photo_mirror`. Quatre traces d'erreur sans
   rapport avec la cause.
2. Le run du passage est resté `queued` dans `auction_runs`. Le lanceur
   (`claim_autonomous_pipeline_run`) ne déclenche rien tant qu'un run est ouvert : il a fallu attendre
   l'expiration du bail d'une heure (`completion_status = lease_expired`). Constaté : run `agrasc` ouvert
   de 14:30 à 15:30, aucun passage à 15:00 ni à 16:00. Un échec coûtait une heure au lieu de trente
   minutes.
3. Même avec ses dépendances, `src.run_finalizer` n'aurait pas clos ce run : pour un passage automatique,
   il ne clôt que le run que son propre job a réclamé (protection contre un double déclenchement), et
   ici rien n'avait été réclamé.

## Correctif

- **Installation des paquets** : `services/data-pipeline/scripts/install_system_packages.sh`, utilisé par
  `data-pipeline.yml` et `information-agent-evidence.yml` (les deux seuls workflows qui appellent apt).
  Phase réseau (`apt-get update` puis téléchargement seul) : trois tentatives au plus, attente de 10 s
  puis 20 s, chaque commande sous `timeout` (40 s et 60 s), le tout sous un plafond de 150 s. Un index
  illisible est une erreur qui relance une tentative (`APT::Update::Error-Mode=any`), plus un simple
  avertissement ; à la dernière tentative seulement, le téléchargement est quand même essayé avec les
  index disponibles (un dépôt en panne dont ces paquets n'ont pas besoin ne bloque pas le passage, comme
  avant). Le temps de ce dernier téléchargement est réservé : le dernier `update` ne reçoit que ce que le
  plafond laisse au-delà, et il est sauté s'il ne reste rien (cas d'un dépôt qui pend : deux `update`
  coupés à 40 s, puis téléchargement direct avec les 40 s restantes). Phase locale (installation de ce qui est téléchargé, sans réseau) : une seule fois, jamais
  interrompue par le plafond réseau. Une panne d'une minute et demie environ ne fait plus échouer le
  passage ; une panne durable échoue en 2 min 35 au plus avec l'annotation « Installation des paquets
  système impossible ».
- **Clôture immédiate** : nouvelle étape « Close run that never started », exécutée quand l'étape du
  pipeline a été sautée. Elle lance `services/data-pipeline/scripts/close_unstarted_run.py`, qui n'utilise
  que la bibliothèque standard de Python (`python3 -I -S`) et l'API REST de Supabase. Elle ne clôt que le
  run demandé et seulement s'il est encore `queued` ; un run `running`, déjà clos ou d'un autre passage
  n'est pas touché. La clé n'est envoyée qu'à une adresse `https`, sans suivre de redirection, et le
  script s'arrête de lui-même après 140 s au plus (plafond de l'étape : 3 min). Un passage automatique
  clôt toujours son run ; sinon, les modes qui n'exécutent pas le run demandé (`publication_check`,
  `documents_backlog`, `enrichment_only`) ne le closent pas : le vidage des pièces tourne dans un autre
  groupe de concurrence, en parallèle d'un passage planifié. Elle écrit `status = failed`, `summary.completion_status = failed_before_start`,
  `summary.startup_failure` (étape : `system_packages`, `python_dependencies`, `justice_references` ou
  `job_preparation`) et, dans `errors.runner`, « Échec avant démarrage : installation des paquets système
  (apt). Le pipeline n'a pas démarré… ». Pour une collecte planifiée, elle remet la source à échéance
  (`next_inventory_at`), comme le fait le lanceur après un bail expiré ; le compteur d'échecs de la source
  ne bouge pas, la source n'ayant pas été contactée.
- **Autres étapes `always()`** : l'invalidation du cache public, le rapport de couverture et la copie des
  photos sont sautés quand les dépendances Python ne sont pas installées. « Finalize unfinished run » ne
  tourne plus que si l'étape du pipeline a tourné.
- **Inchangés** : cadence de la collecte, durée du bail, groupe de concurrence, budgets des sources,
  migrations. Le bail d'une heure reste le filet si la clôture immédiate échoue elle-même.

Pas de cache des paquets apt : aucun n'existait, et un cache de fichiers `.deb` peut diverger de l'image
du runner. Aucune action tierce ajoutée.

## Ce qu'on doit voir au prochain incident du même type

- Dans GitHub Actions : l'étape « Install document extraction packages » rouge après 2 min 35 au plus,
  avec une seule annotation d'erreur ; « Close run that never started » verte, avec dans le résumé du job
  « Échec avant démarrage : installation des paquets système (apt) » ; les étapes de cache, de rapport et
  de photos grises (sautées), sans trace d'erreur. Le job reste en échec.
- En base : `select status, finished_at, summary->>'completion_status', summary->'startup_failure',
errors->'runner' from auction_runs where id = '<run_id>';` rend `failed`, une heure de fin à moins de
  cinq minutes du déclenchement, `failed_before_start` et l'étape en cause.
- Le passage suivant part au prochain tick du lanceur (trente minutes après le déclenchement manqué au
  lieu d'une heure) et reprend la même source si elle est la plus ancienne à échéance.
- Si « Close run that never started » est rouge (base injoignable, secret absent) : le run reste ouvert
  et se ferme comme avant à l'expiration du bail (`lease_expired`).

## Limites

- Non vérifié sur un runner GitHub : les tests simulent apt et l'API REST. La première exécution réelle
  après fusion est à regarder (durée de l'étape des paquets, à comparer aux exécutions précédentes).
- Une panne durable relance désormais un passage toutes les trente minutes au lieu d'une fois par heure,
  sans recul ni alerte dédiée : deux fois plus d'exécutions en échec (courtes) tant qu'elle dure. Une
  alerte stable sur des `failed_before_start` consécutifs demande une migration ; elle est reportée à
  une décision du propriétaire.
- Un job annulé pendant qu'il attend dans le groupe `concurrency` n'exécute aucune étape : le run reste
  ouvert jusqu'à l'expiration du bail.
- Un lancement manuel en mode `documents_backlog` ou `enrichment_only` qui porterait un `run_id` et
  échouerait avant le pipeline ne clôt pas ce run (ces modes ne l'exécutent pas) : le bail s'applique.
- La clôture relit `summary` et `errors` puis les réécrit en entier : une écriture du lanceur entre les
  deux (compte rendu d'un déclenchement) peut être perdue. Sans effet, le run devient terminal.
- Un échec du `checkout` lui-même n'est pas couvert (le script n'est alors pas sur le runner) : le bail
  s'applique.
