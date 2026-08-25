# Outcome Graph — ingestion des sources d'enrichissement

_Version 0.3 — 17 août 2026._

## État réel

Les connecteurs, parseurs, extracteurs structurés et garde-fous de provenance sont préparés. Ce
travail **n'a pas encore entraîné ni réentraîné le modèle**. Le canary et des audits PISTE bornés en
lecture seule ont validé schémas, textes, zones et extraction, sans écriture Supabase ou Storage. Un
échantillon de 20 décisions du profil `adjudication` a produit 12 mises à prix mais aucun prix final ;
le profil exact `adjuge` a produit 5 prix d'adjudication et 5 événements candidats sur ses 11
résultats récents. Ces sondes ne mesurent ni la couverture nationale, ni le rappel, ni la
représentativité. La migration d'ingestion est déployée, mais aucun artefact ou enregistrement
DVF/Judilibre n'a été envoyé au Supabase distant.

Les fichiers locaux décrits plus bas servent à valider les schémas et à construire des candidats. Ils
ne constituent pas un jeu d'entraînement approuvé. Toute ligne issue de ces sources entre dans le
registre avec `training_eligible = false` et doit rester exclue des cohortes tant qu'elle n'a pas été
rattachée, revue et transformée en résultat canonique avec une preuve admissible.

## Règles non négociables

1. Une donnée source est un **candidat**, jamais un résultat judiciaire canonique par simple import.
2. La politique de `data_sources` est vérifiée avant le réseau ou Storage, puis de nouveau dans la
   transaction de métadonnées. Une source absente, inactive, non approuvée ou ouverte sur le mauvais
   canal est refusée.
3. Le brut reste privé. La projection analytique exclut notamment le texte intégral Judilibre et les
   coordonnées de contact des structures de justice.
4. Aucune identité de magistrat ou de membre du greffe ne peut être utilisée pour évaluer, comparer
   ou prédire une pratique professionnelle, ni devenir une feature, un agrégat, une clé d'index ou un
   champ de restitution.
5. Une adresse seule ne suffit jamais à un rapprochement automatique. Le prix DVF n'est jamais un
   signal de matching.
6. Les dates de l'événement, de publication, de capture et le cutoff de features sont distinctes. Une
   date d'audience ou de mutation ne doit jamais être substituée à une date de publication inconnue.
7. Une reconstruction après audience est rétrospective et non entraînable sans preuve historique
   que chaque donnée était publiée **et** capturée avant le cutoff.
8. Une correction ou suppression amont produit une nouvelle version ou une demande de purge ; elle
   ne se traite pas par la réécriture silencieuse de l'historique.

Voir aussi la [model card](../model-card-outcome-graph.md), le
[dictionnaire](../data-dictionary.md) et le [runbook Outcome Graph](outcome-graph.md).

## Catalogue des sources raccordées ou préparées

| Source                                                                                                                                                                                                                                                                     | Rôle prévu                                                                                                           | Accès et licence                                                                                                                                                                                                            | Politique opérationnelle                                                 | Limites importantes                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Judilibre](https://www.data.gouv.fr/dataservices/api-judilibre) — Cour de cassation                                                                                                                                                                                       | Décisions judiciaires pseudonymisées, métadonnées, mises à jour et suppressions                                      | API JSON via PISTE après inscription ; Licence Ouverte 2.0, [CGU Judilibre](https://www.courdecassation.fr/conditions-generales-dutilisation-pour-la-reutilisation-des-donnees-judiciaires-ouvertes-open-data) et CGU PISTE | `approved`, `allowed_automated`, active ; données personnelles possibles | Couverture progressive selon juridiction et matière, API annoncée bêta sans garantie de complétude, fraîcheur ou disponibilité ; aucun profilage de magistrat/greffe                               |
| [DVF](https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres) — DGFiP                                                                                                                                                                                             | Mutations `Adjudication` comme candidats de prix de résultat ; mutations `Vente` comme comparables de marché séparés | Archives annuelles `.txt.zip` ; Licence Ouverte 2.0 et conditions DVF                                                                                                                                                       | `approved`, `allowed_automated`, active                                  | Cinq années, hors Alsace, Moselle et Mayotte selon la fiche source ; remplacement semestriel complet ; pas d'identifiant durable de mutation ; données potentiellement personnelles selon la DGFiP |
| [Compétence territoriale](https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france) et [structures géocodées](https://www.data.gouv.fr/datasets/donnees-geocodees-des-structures-de-la-justice-30378257) — ministère de la Justice | Référentiel officiel commune → juridiction et identité/adresse des structures                                        | CSV ; Licence Ouverte 2.0                                                                                                                                                                                                   | `approved`, `allowed_automated`, active                                  | Référentiel, pas résultat de vente ; schéma et disponibilité des ressources doivent être contrôlés à chaque téléchargement                                                                         |
| [Enchères Publiques](https://www.data.gouv.fr/datasets/distribution-des-prix-de-vente-des-biens-immobiliers-des-tribunaux-judiciaires-francais)                                                                                                                            | Index non officiel d'audiences et références d'organisateurs                                                         | CSV ; Licence Ouverte 2.0, attribution et lien vers Encheres-Publiques.com demandés par le producteur                                                                                                                       | `pending`, `allowed_manual`, inactive                                    | Le fichier réellement observé ne contient **ni prix ni résultat**, malgré le titre et la description de sa fiche ; uniquement grade C, revue humaine obligatoire                                   |

Les valeurs de politique ci-dessus sont les états opérationnels codifiés par les migrations. Toute
activation réseau reste en plus soumise au drapeau serveur explicite et aux secrets du connecteur.

### À propos de LABEL

[LABEL](https://github.com/Cour-de-cassation/label) est le logiciel libre MIT de la Cour de
cassation qui permet à des annotateurs de relire des décisions pré-annotées, notamment pour leur
pseudonymisation. Ce n'est ni une base de décisions, ni une API de résultats de ventes. Il n'est pas
raccordé à Immojudis dans cette tranche. Il pourrait ultérieurement outiller une revue humaine de
caviardage, après étude dédiée, sans remplacer Judilibre comme source.

### Sources complémentaires inventoriées, non raccordées dans cette tranche

| Source officielle                                                                                                                                                                                       | Apport potentiel                                                           | Statut                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Base Adresse Nationale](https://adresse.data.gouv.fr/contenu-de-la-ban)                                                                                                                                | Normalisation d'adresse, code INSEE, coordonnées et identifiants d'adresse | Un géocodeur existe déjà dans le pipeline ; pas de nouveau snapshot Outcome téléchargé ici |
| [Plan cadastral informatisé](https://cadastre.data.gouv.fr/datasets/plan-cadastral-informatise)                                                                                                         | Parcelles et géométries pour un matching plus robuste                      | Enrichisseur cadastral existant ; pas de chargement national Outcome ici                   |
| [Référentiel national des bâtiments](https://www.data.gouv.fr/datasets/referentiel-national-des-batiments) et [BDNB](https://www.data.gouv.fr/datasets/base-de-donnees-nationale-des-batiments)         | Identité bâtiment, emprise, usage et caractéristiques bâties               | À évaluer et raccorder                                                                     |
| [DPE ADEME](https://data.ademe.fr/datasets/dpe03existant)                                                                                                                                               | Performance énergétique et caractéristiques du logement                    | Enrichisseur existant ; règles temporelles à conserver avant usage modèle                  |
| [RNIC](https://www.data.gouv.fr/datasets/registre-national-dimmatriculation-des-coproprietes) et [Géorisques](https://www.georisques.gouv.fr/acceder-la-carte-interactive-aux-bases-de-donnees-et-lapi) | Copropriété et risques naturels/technologiques                             | Inventoriés ; aucun connecteur Outcome livré ici                                           |
| Statistiques Justice et INSEE                                                                                                                                                                           | Contexte territorial, délais et volumes judiciaires                        | Inventoriés ; aucun connecteur Outcome livré ici                                           |

Aucune de ces sources, prise isolément ou ensemble, ne fournit aujourd'hui un flux national officiel
et exhaustif de tout le cycle d'une vente judiciaire : annonce, audience, adjudication, surenchère,
paiement, réitération et caractère définitif.

## Manifeste des téléchargements

Le répertoire `services/data-pipeline/data/raw/outcome_sources/` est ignoré par Git. Il s'agit d'un
cache de travail local, pas d'un stockage de production ni d'une sauvegarde. Les SHA-256 identifient
exactement les octets contrôlés ; tout remplacement amont exige un nouveau manifeste et une nouvelle
validation de schéma.

| Fichier local                                               |            Taille | SHA-256                                                            | Résultat observé                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------: | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dvf/valeursfoncieres-2025.txt.zip`                         | 69 665 132 octets | `ef03b7230a6cfea53cebb369069657fda56e9f7ba8fe58282e148a3b171fa107` | 5 019 lignes brutes `Adjudication`, 4 938 lignes normalisables, regroupées en 1 604 candidats ; 574 candidats multi-biens ; dates du 3 janvier au 18 décembre 2025 ; 0 entraînable |
| `justice_courts/resource-e2a1941b-observed-competences.csv` |  4 910 684 octets | `fdd570c31b4f7de9e1670abe5831e63653abf9a1bf0c8e09c730cdf25d406807` | Ressource officielle du 28 juillet 2026 : 35 029 lignes valides, 0 rejet et canaris sémantiques conformes                                                                          |
| `justice_courts/2026-domaine-juridique-adresse.csv`         |    206 384 octets | `6c8a9e6792e4f7a71f5839a69fd64ec2163ed88e2bfd361a68d500dc8b3d0d5a` | 1 470 structures valides, 0 rejet ; 3 voies, 8 téléphones et 788 emails absents                                                                                                    |
| `encheres_publiques/resultats-vente-2006-2024.csv`          |  3 402 609 octets | `547f4f797ca4e54a5d55fc078c3af21545f66870707e37b015bc489846e4a500` | 14 550 audiences candidates, 0 rejet ; 245 adresses et 3 catégories absentes, 2 dates antérieures à 2006 ; aucune colonne prix/résultat                                            |
| `encheres_publiques/tribunaux-judiciaires.csv`              |     31 680 octets | `f33417461e7e81ac92e2b67d65bcdc5541062a353d434ba0354020b5618d5f73` | 167 références d'organisateurs valides ; 14 473 audiences jointes, 77 non jointes ; aucun rattachement canonique automatique                                                       |
| `justice_courts/resource-88bda661-download-failed.html`     |        146 octets | `55f7d9e99b8e2d4e0e193b2f0275501e6d9c1ebd29cadbea6a0da48a8587e3e0` | Réponse HTML/404 conservée comme preuve d'un lien de ressource défaillant ; doit être rejetée par le parseur et ne jamais être ingérée comme CSV                                   |

Le cache de compétence téléchargé le 30 juillet 2026, de taille 4 910 649 octets et de SHA-256
`04c482cbd640a2463cfd989933c62bebf8eba1008ada2e24d3e85e1b5db88fb7`, était structurellement valide
mais sémantiquement corrompu : il attribuait notamment Bordeaux à Carcassonne et Haut-Valromey à
Saintes. Il est interdit d'ingestion. Le fichier local portant le même nom a été remplacé le 17 août
par la ressource officielle courante du 28 juillet 2026, identifiée dans le tableau ci-dessus.

Le parseur choisit le schéma à partir des en-têtes réellement reçus et refuse HTML, colonnes
inattendues et schémas ambigus. La validation de production exige en plus au moins 34 000 lignes sans
rejet et des canaris géographiquement dispersés — Bourg-en-Bresse, Marseille, Bordeaux, Lyon et
Paris — afin qu'un CSV bien formé mais décalé ne puisse plus attribuer de faux ressorts.

### Affectation du tribunal compétent

Le pipeline détermine désormais le tribunal dans cet ordre strict :

```text
adresse du bien → géocodage BAN accepté → code INSEE exact
                → compétence territoriale Justice → structure Justice → tribunal applicatif
```

Une valeur issue de l'annonce, une liste de villes ou le département ne peut pas remplacer cette
preuve. Si BAN fournit un code INSEE accepté mais que le référentiel Justice est absent, incomplet ou
incohérent, `tribunal` et `tribunal_code` restent nuls et la vente reçoit
`tribunal_competence_unresolved`. Les correspondances historiques sans code INSEE restent marquées
`tribunal_competence_unverified` et sont retirées de la lignée statistique jusqu'à vérification.

Chaque affectation vérifiée conserve dans `raw_payload.tribunal_assignment` le code INSEE, les codes
Justice de la structure, le hash canonique de la ligne de référence et la méthode
`justice_competence_insee_exact`. Après l'upsert du catalogue, la RPC
`reconcile_catalogue_competent_courts()` corrige uniquement les ponts catalogue encore inconnus et
non utilisés par un snapshot, une prédiction, une preuve ou une statistique. Toute lignée déjà
consommée est bloquée et doit faire l'objet d'une correction gouvernée distincte.

## Vérification locale reproductible

Depuis `services/data-pipeline` :

Sur un worker neuf, créer le dossier de cache puis télécharger les deux ressources par leurs URL
data.gouv stables. Une mise à jour amont est acceptée uniquement si les validations ci-dessous
réussissent ; conserver ensuite taille, SHA-256 et date dans le manifeste d'exploitation :

```bash
mkdir -p data/raw/outcome_sources/justice_courts
curl --fail --location \
  --output data/raw/outcome_sources/justice_courts/resource-e2a1941b-observed-competences.csv \
  https://www.data.gouv.fr/api/1/datasets/r/56423a8b-be50-4e96-acf1-23283e44bf85
curl --fail --location \
  --output data/raw/outcome_sources/justice_courts/2026-domaine-juridique-adresse.csv \
  https://www.data.gouv.fr/api/1/datasets/r/9204b2e2-9f20-4a36-86ce-83493303d987
```

```bash
shasum -a 256 \
  data/raw/outcome_sources/dvf/valeursfoncieres-2025.txt.zip \
  data/raw/outcome_sources/justice_courts/resource-e2a1941b-observed-competences.csv \
  data/raw/outcome_sources/justice_courts/2026-domaine-juridique-adresse.csv \
  data/raw/outcome_sources/encheres_publiques/resultats-vente-2006-2024.csv \
  data/raw/outcome_sources/encheres_publiques/tribunaux-judiciaires.csv
```

```bash
.venv/bin/python -m src.official_sources.justice_open_data \
  data/raw/outcome_sources/justice_courts/resource-e2a1941b-observed-competences.csv
.venv/bin/python -m src.official_sources.justice_open_data \
  data/raw/outcome_sources/justice_courts/2026-domaine-juridique-adresse.csv
.venv/bin/python -m src.official_sources.encheres_publiques_open_data \
  data/raw/outcome_sources/encheres_publiques/resultats-vente-2006-2024.csv --kind hearings
.venv/bin/python -m src.official_sources.encheres_publiques_open_data \
  data/raw/outcome_sources/encheres_publiques/tribunaux-judiciaires.csv --kind courts
```

Ces commandes valident les fichiers sans écrire dans Supabase. Le contrôle ciblé du code s'exécute
avec :

```bash
.venv/bin/python -m pytest \
  tests/test_judilibre.py \
  tests/test_judilibre_contract_canary.py \
  tests/test_judilibre_extraction.py \
  tests/test_judilibre_ingestion.py \
  tests/test_dvf_adjudication.py \
  tests/test_justice_open_data.py \
  tests/test_court_competence.py \
  tests/test_encheres_publiques_open_data.py \
  tests/test_outcome_ingestion_adapters.py \
  tests/test_outcome_sources_cli.py \
  tests/test_outcome_ingestion.py -q
```

### CLI Outcome intégrée

La CLI commune découvre son contrat et affiche les portes d'activation sans lire les credentials :

```bash
.venv/bin/python -m src.outcome_sources_cli --help
.venv/bin/python -m src.outcome_sources_cli plan
```

Validation bornée sans écriture :

```bash
.venv/bin/python -m src.outcome_sources_cli validate-local \
  dvf-adjudications data/raw/outcome_sources/dvf/valeursfoncieres-2025.txt.zip --limit 10
.venv/bin/python -m src.outcome_sources_cli validate-local \
  justice data/raw/outcome_sources/justice_courts/2026-domaine-juridique-adresse.csv --limit 10
.venv/bin/python -m src.outcome_sources_cli validate-local \
  encheres-hearings data/raw/outcome_sources/encheres_publiques/resultats-vente-2006-2024.csv --limit 10
.venv/bin/python -m src.outcome_sources_cli validate-local \
  encheres-courts data/raw/outcome_sources/encheres_publiques/tribunaux-judiciaires.csv --limit 10
```

`validate-local` affiche toujours `writes: 0` et `training_eligible: false`. Pour les CSV Justice et
Enchères, le parseur valide le fichier entier avant d'appliquer la limite de sortie ; pour DVF, la
lecture des candidats est streamée.

Après tous les prérequis Storage/base/juridiques, un import réel doit commencer avec une limite
explicite :

```bash
.venv/bin/python -m src.outcome_sources_cli ingest-local \
  justice data/raw/outcome_sources/justice_courts/2026-domaine-juridique-adresse.csv --limit 10
```

Les quatre valeurs de source acceptées sont `dvf-adjudications`, `justice`, `encheres-hearings` et
`encheres-courts`. `ingest-local` exige soit `--limit`, soit `--all` ; `--all` est une reconnaissance
explicite d'un import non borné et ne doit être utilisé qu'après le test borné, la mesure de capacité
et la validation des compteurs. La politique DB est contrôlée avant parsing et avant upload.

## Chaîne de provenance

Pour chaque enregistrement accepté, la chaîne attendue est la suivante :

```text
politique DB → collecte/import → payload source privé → capture typée → extraction versionnée
             → candidat source immuable → candidat de matching → revue → résultat canonique
             → snapshot pré-cutoff → cohorte éligible → entraînement ou prédiction
```

- `data_sources` porte producteur, licence, CGU, revue juridique, politique, indicateur de donnée
  personnelle et état actif.
- `ingestion_jobs` est une file idempotente à leases, retries bornés et dead-letter.
- `raw_artifacts` référence le payload capturé par hash, taille, type MIME, URL canonique et chemin Storage.
- `source_fetches` conserve chaque capture : HTTP réel ou import `local_file` sans méthode ni faux statut HTTP.
- `artifact_extractions` versionne le parseur, le schéma, le résultat et son hash.
- `judicial_source_records` conserve des versions append-only d'un identifiant externe. La contrainte
  SQL force tous ces candidats à rester non entraînables.
- `source_record_matches` conserve les propositions et décisions de matching en append-only.
- `source_sync_checkpoints` conserve le curseur incrémental ; un curseur ne recule pas.
- `source_purge_events` prouve demandes de correction, occultation, suppression et purge.

Les tables d'ingestion ont la RLS active, aucun droit `anon` ou `authenticated`, et des droits
explicites limités au `service_role`. Les nouvelles tables Supabase n'étant plus nécessairement
exposées automatiquement à la Data API, les grants explicites de la migration sont intentionnels ;
ils ne remplacent pas la RLS. La clé `service_role` reste exclusivement côté worker.

### Stockage brut

Le code cible un bucket Supabase Storage privé nommé `outcome-raw-artifacts`. Le chemin déterministe
est :

```text
<source>/<sha256(external_record_id)[0:32]>/<sha256(contenu)>.<extension>
```

L'identifiant externe n'apparaît donc pas en clair dans le chemin. L'upload n'écrase pas un objet
existant (`upsert = false`) ; un doublon de contenu est réutilisé, tandis qu'une nouvelle ligne de
fetch conserve la nouvelle observation.

Pour Judilibre, ce payload est la réponse décisionnelle complète. Pour les imports locaux DVF,
Justice et Enchères, la tranche actuelle stocke un JSON canonique au niveau de l'enregistrement,
dérivé du fichier validé ; elle ne téléverse pas encore l'archive ZIP/CSV entière dans Storage. Le
SHA-256 de ce fichier et ses compteurs restent donc dans le manifeste local ci-dessus. Avant un
import de production, le fichier source complet devra devenir lui-même un artefact gouverné et être
relié à ses extractions afin que la reproductibilité ne dépende pas du cache de travail.

Le fichier de migration d'ingestion crée ce bucket comme privé, limite chaque objet à
100 Mio et de borner les types MIME admis. Il ne crée aucune policy Storage `anon` ou
`authenticated` et accorde au `service_role` seulement les opérations nécessaires à la capture
immuable. Cette migration a été appliquée sur la base de production le 31 juillet 2026; le bucket est
privé et aucun grant direct `anon` ou `authenticated` n'existe sur les tables Outcome. Avant la
première ingestion réelle, tester upload et lecture avec le seul rôle de service. Ne
jamais rendre le texte brut Judilibre public par URL signée longue durée. Le worker
`scripts/run_outcome_retention.py` utilise le seul rôle serveur, traite les suppressions par lots
bornés et conserve une preuve minimale sans recopier le texte ni les chemins Storage dans les logs.

Un échec entre l'upload Storage et le commit de provenance peut laisser un objet privé orphelin. Le
janitor du worker de rétention supprime les objets sans ligne de provenance après 24 heures, ce qui
évite une course avec une transaction active. Le caractère privé du bucket réduit l'exposition ; il
ne remplace ni ce janitor ni la politique de conservation de 24 mois du brut Judilibre.

## Matching et non-entraînement

### DVF `Adjudication`

Le fichier DGFiP n'expose pas d'identifiant durable de mutation dans son export brut. Le connecteur
regroupe les lignes contiguës partageant une signature de mutation et marque l'identité comme
`derived_contiguous_signature`.

Le matching utilise prioritairement parcelle et écart de date. L'adresse peut seulement renforcer une
proposition. Sans parcelle commune, le score est plafonné à `0.49` ; aucun lien automatique n'est
autorisé. Le montant DVF est explicitement exclu des signaux de rapprochement afin d'éviter une
confirmation circulaire du label recherché. Une mutation `Adjudication` est un indice fort de prix,
mais pas la preuve du lot, du round, d'une surenchère ou du caractère définitif.

Les comparables de marché applicatifs filtrent séparément `mutation_nature = Vente`, afin que les
adjudications ne contaminent pas l'estimation du marché libre.

### Enchères Publiques

Le join par `Organisateur_id` enrichit l'audience d'une référence d'organisateur. Cette référence
reste non officielle et `review_required` jusqu'à son rapprochement avec le référentiel du ministère
de la Justice. La date, l'organisateur, la catégorie, l'adresse et l'URL ne permettent jamais de
fabriquer un prix ou un statut d'adjudication absent du fichier.

### Judilibre

La projection normalisée conserve les métadonnées utiles — juridiction, lieu, chambre, formation,
numéros, ECLI, NAC, dates, type, solution, publication et thèmes — ainsi que des **claims candidats**
strictement structurés (événement procédural, mise à prix ou prix d'adjudication) avec grade C et
revue en attente. Le texte, les zones, le sommaire et toute citation restent dans l'artefact brut
privé. La provenance analytique contient seulement le pointeur `/text`, les offsets UTF-8 et des hashes
SHA-256 ; elle ne contient ni extrait, ni nom. Une mise à prix n'est jamais promue comme prix final et
aucun matching automatique entre décision et vente n'est effectué à ce stade.

### Référentiels Justice

Les lignes officielles sont de grade source A pour établir la compétence d'une commune ou identifier
une structure. Elles ne sont pas des preuves A d'un résultat de vente. Téléphone et email peuvent
rester dans le brut privé, mais les adapters les retirent de la projection analytique.

Pour réattribuer le catalogue existant, le worker doit disposer des deux fichiers Justice validés,
relancer le pipeline avec le géocodage BAN actif, puis exécuter le pont catalogue. La réconciliation
est appelée automatiquement après `bridge_auction_sales_to_outcome_graph()` et doit retourner
`complete = true`, `blocked_count = 0` et des compteurs cohérents avant toute purge de catalogue.

Pour un backfill de toutes les annonces déjà stockées, commencer sans écriture, contrôler les
drapeaux `tribunal_competence_unresolved` et `tribunal_competence_unverified`, puis reprendre
exactement le même périmètre avec écriture et réconcilier l'Outcome Graph :

```bash
.venv/bin/python -m src.recompute_scoring --dry-run
.venv/bin/python -m src.recompute_scoring
.venv/bin/python -m src.outcome_ingestion.catalogue_bridge
```

Les annonces sans preuve BAN acceptée doivent d'abord repasser par le pipeline avec
`GEOCODE_ENABLED=true`. Ne pas activer les statistiques tant que le dernier appel ne s'achève pas
avec `complete = true`; une lignée déjà utilisée par une preuve ou un agrégat et réellement à
corriger retourne un blocage au lieu d'être réécrite.

## Activation de Judilibre via PISTE

Judilibre reste fail-closed au runtime : la politique `data_sources` est approuvée et active, mais
`JUDILIBRE_ENABLED` doit valoir exactement `true` et les secrets PISTE doivent être complets pour
autoriser un appel. Des identifiants valides seuls ne suffisent donc pas à déclencher l'ingestion.

### Prérequis avant bascule

1. Créer un compte nominatif sur [PISTE](https://piste.gouv.fr/), accepter les CGU PISTE et Judilibre,
   puis enrôler d'abord l'application sandbox et ensuite, séparément, l'application de production.
2. Faire approuver par le responsable juridique/RGPD la finalité, les CGU en vigueur, la licence,
   l'attribution, la base légale, l'information, la durée de conservation et la procédure de droits.
   Conserver la version/date de cette revue dans le registre de source.
3. Vérifier l'interdiction technique des features et agrégats portant sur les identités de magistrats
   et membres du greffe.
4. Appliquer et tester les migrations sur staging, vérifier le bucket privé provisionné, puis vérifier
   les droits et la RLS avec les rôles `anon`, `authenticated` et `service_role`.
5. Vérifier le worker `scripts/run_outcome_retention.py` : suppression Storage, clôture append-only,
   reprise après échec et janitor des objets sans provenance.
6. Configurer les secrets côté worker uniquement. Ne jamais utiliser un préfixe `NEXT_PUBLIC_`.
7. Tester un petit intervalle en sandbox, vérifier les hashes, versions, compteurs, corrections et
   suppressions, puis seulement faire approuver l'activation automatisée en production.

### Variables serveur

| Variable                                                                                        | Rôle                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `SUPABASE_DB_URL`                                                                               | Écritures transactionnelles directes et lecture de la politique source |
| `SUPABASE_URL`                                                                                  | Endpoint Storage                                                       |
| `SUPABASE_SERVICE_ROLE_KEY`                                                                     | Upload brut privé ; secret serveur uniquement                          |
| `JUDILIBRE_ENABLED`                                                                             | Interrupteur réseau explicite ; laisser `false` avant approbation      |
| `JUDILIBRE_DRY_RUN`                                                                             | Force l'absence de requête réseau                                      |
| `JUDILIBRE_BASE_URL`                                                                            | Endpoint PISTE exact et obligatoire dans le workflow ; sandbox d'abord |
| `JUDILIBRE_AUTH_MODE`                                                                           | `auto`, `keyid`, `oauth2` ou `keyid+oauth2`                            |
| `JUDILIBRE_KEY_ID`                                                                              | Identifiant d'application PISTE lorsque le mode KeyId est utilisé      |
| `JUDILIBRE_OAUTH_TOKEN_URL`                                                                     | Endpoint de jeton PISTE du même environnement                          |
| `JUDILIBRE_OAUTH_CLIENT_ID`, `JUDILIBRE_OAUTH_CLIENT_SECRET`, `JUDILIBRE_OAUTH_SCOPE`           | Client credentials OAuth 2.0 lorsque ce mode est requis                |
| `JUDILIBRE_PAGE_SIZE`, `JUDILIBRE_HISTORY_PAGE_SIZE`                                            | Tailles de page bornées du client                                      |
| `JUDILIBRE_MAX_RESULTS`                                                                         | Plafond absolu client/API, distinct des plafonds du bootstrap          |
| `JUDILIBRE_MAX_RETRIES`, `JUDILIBRE_RETRY_BACKOFF_SECONDS`, `JUDILIBRE_RETRY_MAX_SLEEP_SECONDS` | Reprises bornées et respect de `Retry-After`                           |

Les plafonds du bootstrap sont des paramètres explicites de la CLI et du workflow :
`--max-results-per-window` accepte 1 à 500 résultats et `--max-total-results` 1 à 10 000, le premier
ne pouvant dépasser le second. Les profils autorisés sont exclusivement les six profils v2 :
`saisie_immobiliere_v2`, `vente_forcee_v2`, `adjudication_v2`, `adjuge_v2`,
`mise_a_prix_v2` et `surenchere_v2`.

Le client n'accepte que les origines PISTE sandbox/production prévues, refuse les redirections et
borne les retries sur verrouillage, quota et erreurs serveur. Les erreurs remontées sont nettoyées et
ne contiennent ni headers d'authentification, ni corps de réponse, ni URL complète avec paramètres.

### État attendu de la politique

Avant la première ingestion de production, une migration revue — pas une modification improvisée en
console — doit faire passer `judilibre` à :

```text
legal_review_status = approved
ingestion_policy    = allowed_automated
active              = true
```

Contrôle en lecture :

```sql
select name, official, license, terms_url, terms_version,
       legal_review_status, ingestion_policy, personal_data_possible, active
from public.data_sources
where name in (
  'judilibre',
  'dvf_dgfip',
  'justice_open_data',
  'encheres_publiques_open_data'
)
order by name;
```

Le preflight live sans écriture est :

```bash
.venv/bin/python scripts/check_judilibre_contract.py
```

Il tente au maximum quatre fenêtres historiques contiguës de 31 jours, avec une page d'un résultat
par fenêtre et sans retry HTTP, ignore les réponses relâchées ou vides, puis lit au plus une
décision. Il échoue si aucune réponse exacte exploitable n'est trouvée et ne persiste aucune donnée.

Les commandes d'ingestion live sont :

```bash
.venv/bin/python -m src.outcome_sources_cli judilibre-search-sync \
  --profile adjudication_v2 --date-start 2026-07-01 --date-end 2026-07-07 \
  --max-results-per-window 250 --max-total-results 500
.venv/bin/python -m src.outcome_sources_cli judilibre-fetch '<DECISION_ID>'
.venv/bin/python -m src.outcome_sources_cli judilibre-sync \
  --since '2026-07-01T00:00:00+00:00' --max-pages 1 --max-records 10
```

`--since` est nécessaire seulement à la première synchronisation du `stream-key`; les suivantes
reprennent le checkpoint. Après persistance complète des éléments d'un run borné par `--max-pages`
ou `--max-records`, le checkpoint conserve le prochain curseur avec `scan_complete=false`, mais son
watermark n'est pas promu. Ce curseur est une borne temporelle inclusive ; le `from_id` opaque et
éphémère renvoyé par Judilibre n'est jamais persisté. Les plafonds sont donc des budgets souples qui
peuvent être légèrement dépassés pour ne jamais couper une cohorte de timestamp. Le run suivant reprend exactement ce segment ; un crash antérieur au
checkpoint rejoue les écritures de façon idempotente. Ne lancer aucune de ces commandes tant que
les prérequis précédents ne sont pas satisfaits.

## Corrections, suppressions et synchronisation

Le point d'entrée Judilibre `/transactionalhistory` expose des actions `created`, `updated` et
`deleted`. La synchronisation :

- consomme d'abord rapidement la chaîne de curseurs `next_page`, à durée de vie courte, avant les
  téléchargements `/decision` et les écritures Storage ;
- recharge une création ou mise à jour par `/decision` et insère une nouvelle version si la
  projection analytique ou le hash non réversible de la représentation brute change ;
- transforme `deleted` ou `to_be_deleted` en `source_purge_events.deletion_requested` et en job
  idempotent `source.purge` ;
- conserve le fetch, l'extraction et la version précédente pour l'audit jusqu'à l'exécution de la
  politique de purge applicable ;
- persiste après chaque segment réussi le prochain curseur avec `scan_complete=false`, sans avancer
  le watermark ; seule la page terminale marque le scan complet et promeut le plus ancien
  `query_date` de la chaîne ; un échec ne persiste aucun curseur nouveau.

Les CGU Judilibre imposent de tenir les données à jour et recommandent de ne pas dépasser 72 heures
entre deux synchronisations, sous réserve de la disponibilité du service. L'activation de production
est donc interdite sans supervision du délai, dead-letter, purge et reprise du checkpoint.

Le journal de purge est append-only. Une purge physique doit supprimer ou rendre inaccessible le
contenu visé dans Storage et les projections concernées selon la décision juridique, puis insérer un
événement de clôture avec preuve minimale. L'événement et le job portent toujours
`external_record_id` comme périmètre gouverné ; le lien explicite vers l'artefact correspond à la
dernière version pour la traçabilité. Le worker de purge physique, encore à implémenter, devra
énumérer **toutes** les versions et tous les artefacts de cet identifiant externe : supprimer
uniquement l'artefact référencé par le job serait incomplet. Ne jamais effacer le journal lui-même
sans politique de conservation approuvée ; ne jamais conserver dans cette preuve le texte supprimé.

## Diagnostics d'exploitation

À exécuter avec un rôle serveur autorisé, jamais depuis le navigateur :

```sql
select source.name, fetch.fetch_status, count(*)
from public.source_fetches fetch
join public.data_sources source on source.id = fetch.source_id
where fetch.created_at >= now() - interval '24 hours'
group by source.name, fetch.fetch_status
order by source.name, fetch.fetch_status;
```

```sql
select source.name, record.record_kind,
       count(*) as records,
       count(*) filter (where record.training_eligible) as training_records
from public.judicial_source_records record
join public.data_sources source on source.id = record.source_id
group by source.name, record.record_kind
order by source.name, record.record_kind;
```

Le second compteur doit rester à zéro par contrainte SQL.

```sql
select source.name, job.status, count(*)
from public.ingestion_jobs job
join public.data_sources source on source.id = job.source_id
where job.job_kind = 'source.purge'
group by source.name, job.status
order by source.name, job.status;
```

```sql
select source.name, checkpoint.stream_key, checkpoint.watermark_at,
       checkpoint.revision, checkpoint.updated_at
from public.source_sync_checkpoints checkpoint
join public.data_sources source on source.id = checkpoint.source_id
order by source.name, checkpoint.stream_key;
```

Déclencher une coupure de collecte et une revue si une source non approuvée produit un fetch, si un
objet brut devient lisible par un rôle navigateur, si le délai de synchronisation/purge dépasse le
SLA approuvé, si un compteur `training_records` devient non nul, ou si des identités de magistrat ou
greffe apparaissent dans une projection, un log, une feature ou une restitution.

## Conditions avant réentraînement

Les téléchargements de ce runbook n'autorisent pas un réentraînement. Une ligne ne peut rejoindre une
cohorte que si, au minimum :

- le lot, le dossier et le round sont identifiés sans ambiguïté ;
- le résultat est soutenu par une preuve A/B et une revue, sans conflit bloquant ;
- les corrections et suppressions amont ont été appliquées ;
- `published_at` et `captured_at` réels sont antérieurs ou égaux au cutoff ;
- le snapshot n'est pas rétrospectif, son contrôle anti-fuite est `passed`, et son manifeste est
  complet ;
- aucune donnée personnelle interdite, aucun texte judiciaire brut et aucun prix utilisé pour le
  matching n'entre dans les features ;
- la cohorte, le modèle, les métriques et l'approbation sont versionnés et audités.

À la date de ce document, ces conditions ne sont pas réunies pour un dataset national : le modèle
prédictif de production n'a donc pas été enrichi par ces nouvelles sources.
