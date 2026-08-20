# Workflows DVF adjudications et Judilibre

Ces workflows automatisent uniquement les connecteurs Outcome Graph. Ils ne déploient rien, ne
modifient aucune politique de source et n'appellent jamais le collecteur général `src.main` ni une
source Avoventes.

## DVF adjudications

Le workflow `Outcome Graph - DVF adjudications` :

1. interroge le catalogue officiel
   `https://www.data.gouv.fr/api/1/datasets/demandes-de-valeurs-foncieres/` ;
2. vérifie l'identifiant du dataset DGFiP, celui de l'organisation éditrice, l'accès ouvert et la
   Licence Ouverte 2.0 avant de sélectionner une seule ressource principale `txt.zip` ;
3. refuse toute URL hors du préfixe officiel `static.data.gouv.fr`, vérifie le checksum publié et
   teste l'archive ZIP ;
4. exécute toujours `validate-local dvf-adjudications` avant toute écriture ;
5. ingère au maximum le nombre de candidats demandé, jamais avec `--all` ;
6. après une ingestion autorisée, exécute `match-dvf` avec la même borne globale, parcourt les
   sources par pages de 500 et dépose uniquement des candidats de rapprochement dans la file de
   revue ;
7. publie le nombre de pages et de sources parcourues, les écritures, les plafonds de contextes
   atteints, la troncature éventuelle et le dernier UUID permettant une reprise explicite.

Le lancement manuel est en mode `validate` par défaut. Le mode `ingest` exige la confirmation
`INGEST-DVF` ainsi que les secrets `SUPABASE_DB_URL`, `SUPABASE_URL` et
`SUPABASE_SERVICE_ROLE_KEY`. Le run semestriel reste une validation sans écriture tant que la
variable de dépôt `DVF_ADJUDICATION_INGESTION_ENABLED` n'est pas exactement `true`.
`DVF_ADJUDICATION_MAX_CANDIDATES` peut réduire ou augmenter la borne planifiée entre 1 et 20 000 ;
la valeur par défaut est 5 000. Cette borne est le plafond de tout le run de matching, pas la taille
d'une page. Le workflow n'utilise jamais `match-dvf --all`. Si le résumé indique
`source_scan_truncated=true`, relancer manuellement avec l'UUID publié dans
`matching_after_source_record_id`; un curseur absent ou mal formé est refusé. Une page terminale
plus courte que 500, ou la sonde bornée effectuée au plafond, permet de distinguer un scan achevé
d'un backlog restant.

Les lignes produites restent des `auction_result_candidate`, avec
`training_eligible=false`. Le dataset DVF signalant lui-même la présence possible de données à
caractère personnel, l'archive téléchargée reste éphémère : elle n'est ni mise en cache ni publiée
comme artefact GitHub, et aucune ligne brute n'est écrite dans les logs.

Le rapprochement utilise une parcelle commune ou, à défaut, une adresse exacte accompagnée d'une
date à plus ou moins 30 jours. Le prix DVF n'entre jamais dans le score, aucun résultat n'est relié
automatiquement et l'éligibilité d'entraînement ne change pas. En l'absence de lot Outcome actif,
la commande s'arrête proprement avec zéro écriture ; il faut donc avoir exécuté le bridge du
catalogue avant d'attendre des candidats exploitables. `source_scan_truncated` concerne uniquement
la pagination des enregistrements DVF. `context_limits_reached` indique séparément qu'au moins un
enregistrement a atteint le plafond de 250 contextes ; le curseur source ne reprend pas ces
contextes supplémentaires.

## Judilibre

Le workflow `Outcome Graph - Judilibre synchronization` reste fermé par défaut sans la variable de
dépôt `JUDILIBRE_ENABLED=true`. Le mode `plan` reste sans secret et sans écriture. Après le bootstrap
manuel ciblé, un suivi quotidien recharge seulement les décisions déjà retenues afin de propager les
corrections et suppressions dans le délai maximal de 72 heures.

Le premier jour UTC de chaque mois, ce même workflow télécharge les deux référentiels officiels du
ministère de la Justice, vérifie l'organisation productrice, la licence, la taille, le hash, le
schéma et la cohérence croisée des fichiers, puis importe le registre des structures dans le stockage
privé. Une exécution manuelle peut demander la même opération avec
`refresh_justice_references=true`. Ce registre est requis pour résoudre exactement un code Judilibre
`tj<INSEE>` vers un tribunal Outcome ; une structure absente ou ambiguë reste non rapprochée.
Le code ministériel historique `TGI` est accepté uniquement pour les lignes courantes dont le nom
officiel correspond exactement à un tribunal judiciaire du catalogue ; il est traité comme
l'équivalent de type du code `TJ`, sans modifier le nom ni autoriser une recherche approximative.

Après validation des credentials et avant tout bootstrap ou suivi, le workflow exécute
`scripts/check_judilibre_contract.py`. Ce canary tente au maximum quatre fenêtres historiques
contiguës de 31 jours, avec une seule page d'un résultat par fenêtre et sans nouvelle tentative HTTP.
Il ignore toute réponse relâchée, s'arrête au premier résultat exact et lit au maximum une décision ;
il contrôle le schéma, le texte, les zones et la sortie d'extraction sans écrire dans Supabase ou
Storage. Le canary échoue si aucune réponse exacte exploitable n'est trouvée après les quatre
fenêtres. Tout échec interrompt le workflow avant l'ingestion.

Deux opérations d'ingestion séparées sont disponibles :

1. `bootstrap` lance une recherche ciblée avec
   `judilibre-search-sync --profile … --date-start … --date-end … --max-results-per-window …
--max-total-results …`. Le profil doit
   être l'un de `saisie_immobiliere_v2`, `vente_forcee_v2`, `adjudication_v2`, `adjuge_v2`,
   `mise_a_prix_v2` ou `surenchere_v2`. Les deux dates sont obligatoires, la fenêtre contient au plus 31 jours
   calendaires, le plafond par sous-fenêtre doit être compris entre 1 et 500 et le plafond global
   entre 1 et 10 000. Une fenêtre trop dense est divisée en intervalles calendaires disjoints ; le
   bootstrap échoue sans écriture si une seule journée reste trop dense, si le total global est
   dépassé ou si l'API relâche la requête. Chaque sous-fenêtre terminale est lue deux fois ; le
   bootstrap échoue aussi sans écriture si le total, l'ensemble des identifiants ou l'empreinte des
   métadonnées associées à un identifiant change entre ces deux lectures. L'ordre brut peut varier
   pour deux décisions partageant la même date ; les identifiants sont donc triés localement avant
   calcul de l'empreinte canonique. L'opérateur doit saisir exactement
   `BOOTSTRAP-JUDILIBRE-TARGETED` dans `confirm_bootstrap`.
2. `sync` lance `judilibre-sync` avec des plafonds de pages et d'événements. Cette synchronisation
   transactionnelle est **tracked-only** : elle recharge ou marque supprimés uniquement les
   identifiants déjà retenus par un bootstrap ciblé ; les événements portant sur d'autres décisions
   sont ignorés. L'opérateur doit saisir exactement `SYNC-JUDILIBRE-TRACKED-ONLY` dans
   `confirm_sync`.

Après chaque ingestion, `scripts/run_outcome_retention.py` traite les purges avec reprise, nettoie
les objets privés sans provenance âgés de plus de 24 heures et applique la rétention de 730 jours au
brut Judilibre. `scripts/match_judilibre_candidates.py --persist` ajoute ensuite uniquement des
candidats de rapprochement soumis à revue ; il ne crée aucun résultat et ne modifie jamais
`training_eligible`.

L'activation effective nécessite simultanément :

- une ligne `data_sources.judilibre` active, juridiquement approuvée et autorisée en ingestion
  automatisée ;
- une variable de dépôt `JUDILIBRE_BASE_URL` explicite, pointant d'abord vers la sandbox puis vers
  la production seulement après validation ;
- les trois secrets Supabase serveur ;
- soit `JUDILIBRE_KEY_ID`, soit le couple
  `JUDILIBRE_OAUTH_CLIENT_ID` / `JUDILIBRE_OAUTH_CLIENT_SECRET`, selon
  `JUDILIBRE_AUTH_MODE` ;
- pour le premier suivi transactionnel manuel, un point de départ ISO-8601 dans l'entrée `since` si
  aucun checkpoint n'existe. Le suivi planifié utilise au besoin une borne glissante de 72 heures.

Les variables optionnelles sont `JUDILIBRE_BASE_URL`, `JUDILIBRE_OAUTH_TOKEN_URL`,
`JUDILIBRE_OAUTH_SCOPE`, `JUDILIBRE_OAUTH_CLIENT_AUTH_METHOD`,
`JUDILIBRE_HISTORY_PAGE_SIZE`, les paramètres de retry, ainsi que
les entrées manuelles `max_pages` et `max_records`. Pour le suivi, ces deux bornes valent
respectivement 10 et 1 000 par défaut, avec des maxima workflow de 50 pages et 5 000 événements.

Le stream est volontairement fixé à `transactional_history` afin d'éviter plusieurs checkpoints
concurrents pour la même source. Le connecteur reprend le checkpoint Supabase ; `since` ne sert que
s'il n'existe pas. Après un segment borné traité sans erreur, le connecteur persiste le prochain
curseur temporel inclusif avec `scan_complete=false`, sans jamais conserver le `from_id` éphémère
de Judilibre et sans promouvoir le watermark public. `max_pages` et `max_records` sont des budgets :
le connecteur peut les dépasser pour finir toutes les transactions portant le même timestamp. Le
run suivant reprend cette borne ; seule la page terminale inscrit `scan_complete=true` et promeut le plus ancien
`query_date` observé pendant tout le scan. Un échec avant ce checkpoint rejoue donc le segment de
façon idempotente. Aucun texte de décision n'est déposé dans les artefacts GitHub : le brut va
uniquement dans le bucket Supabase privé prévu à cet effet.

Le mode manuel `plan` ne lit aucun secret, force `JUDILIBRE_ENABLED=false` et affiche seulement les
conditions d'activation du CLI.
