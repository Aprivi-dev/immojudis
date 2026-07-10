# Immojudis Data Pipeline

Socle technique minimal pour collecter, normaliser, dédupliquer, exporter et insérer dans Supabase des annonces de ventes aux enchères immobilières judiciaires en France.

La source prioritaire est Avoventes. Licitor est disponible comme source optionnelle de benchmark/croisement, pas comme source primaire de vérité.

## Périmètre

- Départements : France entière.
- Tribunaux : normalisation explicite quand la source les fournit ; inférence locale conservée quand elle est connue.
- Sources prévues :
  - `src/sources/avoventes.py` : scraper Avoventes.
  - `src/sources/licitor.py` : scraper Licitor optionnel pour benchmark de couverture.
  - `src/sources/info_encheres.py` : scraper Info Enchères avec fiches détail et PDF publics.
  - `src/sources/vench.py` : scraper Vench pour couverture/listings publics, sans contourner les contenus abonnés.
  - `src/sources/encheres_publiques.py` : scraper Enchères-Publiques.com via les pages SEO publiques.
  - `src/sources/petites_affiches.py` : scraper Petites Affiches via le formulaire public par département.
  - `src/sources/cessions_etat.py` : scraper Cessions immobilières de l'Etat via les cartes HTML publiques.
  - `src/sources/agrasc.py` : scraper AGRASC via les cartes immobilières publiques.
  - `src/sources/encheres_immobilieres.py` : scraper Enchères Immobilières via les données Next publiques.
  - `src/sources/notaires.py` : scraper Immobilier.notaires.fr via l'API publique des annonces VAE/VNI.
  - `src/sources/cabinet_generic.py` : point d'extension pour les pages de cabinets locaux.

## Installation

```bash
cd services/data-pipeline
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

Pour les audits documentaires ponctuels les plus lourds, installer aussi Docling :

```bash
pip install -r requirements-docling.txt
```

Le pipeline de production privilégie un mode rapide par défaut : PyMuPDF, cache,
Docling désactivé et OCR désactivé. Docling/OCR restent disponibles en opt-in
quand un run d'audit documentaire complet est nécessaire.

## Hygiène de dépôt

Avant de pousser le repo :

- ne jamais committer `.env` ;
- ne pas committer les caches et exports dans `data/` ;
- garder seulement les fichiers `.gitkeep` des dossiers de données ;
- configurer les secrets directement dans l'environnement local ou CI.

Vérifier l'installation :

```bash
source .venv/bin/activate
python -m pytest -q
python -m ruff check .
```

Lancer un run :

```bash
python -m src.main
```

Docling reste optionnel. Pour l'activer explicitement :

```bash
source .venv/bin/activate
pip install -r requirements-docling.txt
```

## Configuration Supabase

Copier `.env.example` vers `.env` :

```bash
cp .env.example .env
```

Renseigner si l'insertion Supabase est souhaitée :

```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=...
```

`SUPABASE_PUBLISHABLE_KEY` est utile pour de futurs clients publics, mais l'insertion serveur du pipeline utilise `SUPABASE_SERVICE_ROLE_KEY`.

Si ces variables sont absentes, le pipeline collecte, normalise, déduplique et exporte seulement les fichiers locaux.

Pour appliquer automatiquement le schéma SQL depuis la machine locale, ajouter aussi l'URL Postgres Supabase :

```bash
SUPABASE_DB_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Quand `SUPABASE_DB_URL` est présent, l'upsert principal des ventes passe par
Postgres direct, puis les tables dérivées (`auction_risks`, documents, score
factors, surfaces, etc.) sont synchronisées via l'API REST service-role.

Le pipeline conserve `auction_sales` comme table de compatibilité historique,
mais alimente aussi le modèle produit normalisé demandé pour l'offre Pro :
`properties` décrit le bien immobilier et `judicial_sales` décrit le contexte
de vente judiciaire rattaché. Les contacts avocats trouvés dans les annonces
sont stockés comme `source_lawyer_*` dans `judicial_sales`; ils restent distincts
du futur référencement payant des avocats ImmoJudis.

Les enrichissements peuvent être parallélisés et plafonnés par run :

```bash
PIPELINE_ENRICH_WORKERS=2
PIPELINE_PDF_WORKERS=2
PIPELINE_PDF_MAX_TARGETS=10
PIPELINE_LLM_MAX_TARGETS=10
PIPELINE_LLM_BACKFILL_MAX_TARGETS=10
PIPELINE_IDLE_LLM_BACKFILL_ENABLED=false
DEDUPE_RECONCILE_ENABLED=true
DEDUPE_RECONCILE_MAX_ROWS=2000
```

Après les upserts, le pipeline peut relire un lot borné d'annonces
actives/prochaines déjà stockées et réappliquer la fusion multi-sources. Cette
passe corrige les doublons historiques qui ne repassent pas forcément ensemble
dans le scraping du jour, puis supprime les lignes sources secondaires.

Pour résorber progressivement les annonces déjà en base sans synthèse IA
publique, lancer un backfill borné. Il ne relance pas le scraping et cible par
défaut les ventes `active` et `upcoming` :

```bash
python -m src.main --backfill-llm-descriptions
python -m src.main --backfill-llm-descriptions --limit 20 --backfill-statuses active,upcoming
```

Le backfill doit rester un run dédié depuis l'admin ou `workflow_dispatch` :
cela évite que les runs planifiés idle ajoutent des appels Replicate longs à
chaque passage.

En CI, les backfills IA sont volontairement bornés par petits lots et les
prédictions Replicate démarrent avec `REPLICATE_WAIT_SECONDS=1` pour éviter
d'ajouter le temps de génération à l'intervalle minimal entre deux requêtes.
Les runs planifiés font aussi un preflight léger : ils sautent le worker si un
run manuel ou un autre run Supabase récent est déjà actif.

Activer Licitor uniquement pour un benchmark :

```bash
ENABLE_LICITOR_BENCHMARK=true
LICITOR_MAX_PAGES=5
```

Activer les sources de croisement supplémentaires :

```bash
ENABLE_VENCH_BENCHMARK=true
VENCH_MAX_PAGES=1
ENABLE_INFO_ENCHERES_BENCHMARK=true
INFO_ENCHERES_MAX_PAGES=4
ENABLE_ENCHERES_PUBLIQUES_BENCHMARK=true
ENCHERES_PUBLIQUES_MAX_PAGES=10
# Optionnel. Vide = page nationale /ventes/immobilier.
ENCHERES_PUBLIQUES_PLACES=
ENABLE_PETITES_AFFICHES_BENCHMARK=true
ENABLE_CESSIONS_ETAT_BENCHMARK=true
CESSIONS_ETAT_MAX_PAGES=3
ENABLE_AGRASC_BENCHMARK=true
ENABLE_ENCHERES_IMMOBILIERES_BENCHMARK=true
ENCHERES_IMMOBILIERES_MAX_PAGES=1
ENABLE_NOTAIRES_BENCHMARK=true
NOTAIRES_MAX_PAGES=2
```

Tous les scrapers respectent `robots.txt`. Si une source refuse une URL ou masque une partie des documents, le pipeline journalise l'erreur et continue avec les autres sources, sans tentative de contournement.
`encheres-domaine.gouv.fr` et `immonotairesencheres.com` ne sont pas intégrés tant qu'ils ne publient pas de page/API de listings exploitable sans session JS/cookies.

Créer la table dans Supabase automatiquement avec :

```bash
python -m src.storage.setup_supabase
```

Ou manuellement dans le SQL Editor avec :

```sql
-- sql/schema.sql
```

Le fichier active `pgcrypto`, crée `auction_sales`, les index demandés, active RLS et donne les droits nécessaires au rôle `service_role`.

## Import DVF semestriel

Les comparables DVF détaillés s'appuient sur les fichiers officiels
`Demandes de valeurs foncières` publiés sur data.gouv.fr. L'import accepte les
fichiers `.txt`/`.csv` bruts et les archives `.zip`, avec séparateur `|`, `;`,
`,` ou tabulation.

Le workflow GitHub Actions `Immojudis DVF Import` est planifié le 10 avril et
le 10 octobre. Il lit l'API officielle data.gouv.fr, récupère les ressources
principales DVF disponibles, vérifie les checksums SHA-1 quand ils sont fournis,
puis appelle `python -m src.dvf_import`. Le workflow peut aussi être lancé
manuellement avec `dry_run=true`, une `resource_url` précise ou une limite de
lignes pour tester un millésime avant import complet.

Valider un fichier sans écrire en base :

```bash
python -m src.dvf_import data/raw/dvf/valeursfoncieres-2024.txt --dry-run --limit 10000
```

Importer dans Supabase/Postgres :

```bash
python -m src.dvf_import data/raw/dvf/valeursfoncieres-2024.txt \
  --source-url "https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres"
```

Cette commande requiert `SUPABASE_DB_URL` et écrit dans `dvf_import_batches` et
`dvf_transactions`. Les données brutes restent derrière les API ImmoJudis
plan-gatées ; elles ne doivent pas être ré-exposées directement ni indexées par
des moteurs externes.

## Enrichissement cadastre

Après le géocodage final, le pipeline peut rattacher chaque vente géocodée à
une ou plusieurs parcelles via API Carto Cadastre (`geom` GeoJSON en WGS84).
Les résultats normalisés sont écrits dans `auction_cadastre_parcels` avec
section, numéro, code INSEE, contenance, centroïde et payload source. Cette
table reste privée côté client ; les rapports d'opportunité la consomment côté
serveur pour renforcer l'analyse cadastrale.

Variables utiles :

```bash
CADASTRE_ENRICH_ENABLED=true
CADASTRE_API_URL=https://apicarto.ign.fr/api/cadastre/parcelle
CADASTRE_SOURCE_IGN=PCI
CADASTRE_MAX_PARCELS=4
CADASTRE_TIMEOUT_SECONDS=10
```

## Enrichissement DPE ADEME

Après le géocodage final, le pipeline peut interroger l'open data ADEME DPE
logements existants par distance géographique (`geo_distance`) ou, à défaut de
coordonnées, par recherche d'adresse. Les diagnostics normalisés sont écrits
dans `auction_dpe_diagnostics` avec numéro DPE, classes DPE/GES, dates,
surface, consommation, émissions, score BAN et payload ADEME. Cette table reste
privée côté client ; l'explorateur DPE et les rapports y accèdent côté serveur
via les API ImmoJudis plan-gatées.

Variables utiles :

```bash
DPE_ENRICH_ENABLED=true
DPE_API_URL=https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines
DPE_GEO_RADIUS_M=120
DPE_MAX_RESULTS=5
DPE_TIMEOUT_SECONDS=12
```

L'API publique ADEME/Data Fair impose des limites d'appels ; gardez un rayon et
un nombre de résultats raisonnables, et évitez les rafraîchissements massifs non
nécessaires.

## Refresh DPE/cadastre à la demande

L'application peut créer une demande utilisateur dans `data_refresh_requests`
via l'API `/api/data-refresh`. Le worker `python -m src.queued_runner` traite
d'abord les runs complets `auction_runs`, puis consomme une demande de refresh
ciblée s'il n'y a pas de run global en attente.

Scopes supportés :

- `cadastre` : relance uniquement la jointure parcellaire de la vente.
- `dpe` : relance uniquement la recherche ADEME DPE de la vente.
- `full` : relance cadastre puis DPE.

Chaque demande est verrouillée en `running`, puis terminée en `completed` ou
`failed` avec un `result_summary` indiquant les lignes enrichies et upsertées.
Les demandes sont possédées par l'utilisateur côté app ; le pipeline les traite
avec le rôle service Supabase.

## Lancement

```bash
python -m src.main
```

Options utiles :

```bash
python -m src.main --source avoventes
python -m src.main --source licitor --no-upsert
python -m src.main --source info_encheres --no-upsert
python -m src.main --source vench --no-upsert
python -m src.main --source encheres_publiques --no-upsert
python -m src.main --no-llm
python -m src.main --limit 5
python -m src.main --run-id <auction_runs_id>
python -m src.queued_runner
```

`--run-id` permet de reprendre une demande créée depuis le dashboard admin
(`auction_runs.status = queued`) et de la passer en `running`, puis `succeeded`
ou `failed`.

`python -m src.queued_runner` récupère le plus ancien run `queued` dans
Supabase et lance le pipeline avec ses paramètres. C'est la commande utilisée
par le workflow GitHub Actions planifié.

Le pipeline :

1. collecte Avoventes sur la liste nationale ;
2. collecte Licitor, Info Enchères, Vench, Enchères-Publiques et les sources publiques complémentaires si elles sont activées ;
3. inspecte les fiches détail publiques disponibles pour enrichir les champs et les documents autorisés ;
4. normalise légèrement chaque observation source ;
5. calcule un hash de contenu indépendant de la source ;
6. déduplique et fusionne les doublons inter-sources en une vente canonique ;
7. télécharge les PDF, extrait leur texte page par page et enrichit surface, occupation, type, description et risques ;
8. enrichit via Replicate si `REPLICATE_API_TOKEN` est configuré et si le cache LLM n'est pas déjà valide ;
9. géocode via BAN si les coordonnées sont absentes ;
10. remplit ou revalide `tribunal` depuis information explicite, ville, département ou texte brut enrichi ;
11. normalise les actifs immobiliers en surfaces, équipements, risques et score investisseur ;
12. marque automatiquement `past` les ventes dont `sale_date` est dépassée, sans écraser les ventes `adjudicated` ;
13. exporte :

- `data/processed/auction_sales.json`
- `data/processed/auction_sales.csv`

14. insère ou met à jour Supabase si `.env` est configuré, avec une table canonique et les observations source ;
15. nettoie aussi Supabase en marquant `past` les lignes déjà stockées dont la date est dépassée ;
16. affiche un rapport qualité.

## Enrichissement PDF

Le module [pdf_enrichment.py](src/pdf_enrichment.py) :

- télécharge les PDF listés dans `documents` sans retélécharger ceux déjà présents ;
- stocke les fichiers dans `data/documents/{sale_id}/` ;
- extrait le texte avec PyMuPDF par défaut pour garder les runs rapides ;
- peut utiliser Docling en opt-in pour les audits documentaires complets ;
- met en cache le texte Docling dans `data/raw/docling_texts/` pour eviter de reconvertir les memes fichiers ;
- retombe sur PyMuPDF/Tesseract si Docling est actif mais ne retourne pas de texte ;
- stocke les textes dans `data/raw/pdf_texts/{sale_id}.json` ;
- classe les documents prioritaires : PV descriptif, cahier des conditions, diagnostics, avis simplifié ;
- enrichit `surface_m2`, `rooms_count`, `bedrooms_count`, `occupancy_status`, `property_type`, `description`, `risk_notes` et `raw_text`.

Configuration utile :

```bash
PDF_EXTRACTOR=auto
PDF_DOCLING_ENABLED=false
PDF_DOCLING_THRESHOLD_CHARS=1200
PDF_DOCLING_TIMEOUT_SECONDS=180
PDF_DOCLING_OCR_MODE=auto
PDF_DOCLING_OCR_MAX_PAGES=25
PDF_DOCLING_OCR_MAX_SIZE_MB=15
PDF_DOCLING_CHUNK_PAGES=10
PDF_DOCLING_OCR_CHUNK_PAGES=2
PDF_OCR_ENABLED=false
PDF_OCR_LANGUAGE=fra+eng
```

## Enrichissement LLM Replicate

Le module `src/enrichment/` utilise Replicate pour extraire une lecture structurée des textes PDF.
Le modèle par défaut est `google/gemini-2.5-flash`, choisi pour le rapport qualité/prix.

Configuration :

```bash
LLM_ENABLED=true
LLM_PROVIDER=replicate
REPLICATE_API_TOKEN=your-replicate-token
REPLICATE_MODEL=google/gemini-2.5-flash
REPLICATE_TEMPERATURE=0
REPLICATE_MAX_TOKENS=1024
REPLICATE_TIMEOUT_SECONDS=180
REPLICATE_WAIT_SECONDS=60
REPLICATE_CANCEL_AFTER=5m
REPLICATE_MAX_RETRIES=4
REPLICATE_RETRY_BACKOFF_SECONDS=30
REPLICATE_RETRY_MAX_SLEEP_SECONDS=60
REPLICATE_MIN_INTERVAL_SECONDS=5
REPLICATE_THINKING_BUDGET=0
REPLICATE_DYNAMIC_THINKING=false
LLM_PROMPT_VERSION=auction_llm_v6_display
LLM_EXTRACTION_MODE=display_description
LLM_PDF_MAX_CHARS=6000
INCREMENTAL_ENRICHMENT=true
PDF_DOCLING_FAST_TIMEOUT_SECONDS=60
PDF_MAX_DOCUMENTS_PER_SALE=2
PIPELINE_PDF_MAX_TARGETS=10
PIPELINE_LLM_MAX_TARGETS=10
PIPELINE_LLM_BACKFILL_MAX_TARGETS=20
PIPELINE_IDLE_LLM_BACKFILL_ENABLED=false
```

Le provider Replicate appelle l'API HTTP officielle avec `Authorization: Bearer $REPLICATE_API_TOKEN` et l'endpoint `/v1/models/{owner}/{model}/predictions`.
Pour Gemini via Replicate, le client envoie le prompt système dans `system_instruction` et limite la réponse à du JSON validé ensuite par Pydantic.
Les erreurs temporaires Replicate, dont `429 Too Many Requests`, sont retentées avec backoff exponentiel et un délai minimal entre appels pour éviter les rafales en fin de run.
Les textes PDF et les extractions LLM sont mis en cache par empreinte de document/contexte. Le run suivant réutilise les résultats inchangés, limite les documents transmis aux plus utiles et applique un timeout Docling plus court sur les PDF signés ou très lourds avant fallback.

Le pipeline tente l'enrichissement LLM sur les annonces sélectionnées par les
garde-fous `PIPELINE_LLM_MAX_TARGETS` et le cache incrémental. Il conserve le
descriptif source dans `raw_payload.source_description`, puis demande au LLM une
version d'affichage uniforme `display_description` stockée en
`raw_payload.llm_display_description`. En mode courant
`LLM_EXTRACTION_MODE=display_description`, le prompt est volontairement plus
court et centré sur cette synthèse publique. Il continue sans LLM si le provider
configuré n'est pas disponible. Les réponses doivent être du JSON valide,
validé par Pydantic, puis sauvegardé dans
`data/processed/llm_extractions/{sale_id}.json`.

Le mode `--backfill-llm-descriptions` traite les annonces déjà présentes dans
Supabase qui n'ont pas encore de synthèse publique courante. Il est séparé du
scrape principal pour éviter d'allonger les runs planifiés ; son volume est
borné par `PIPELINE_LLM_BACKFILL_MAX_TARGETS` ou `--limit`. En CI, il doit être
déclenché explicitement afin de garder les schedules courts et prévisibles.

Un cache évite de rappeler Replicate quand le triplet `modèle + version de prompt + contexte réduit` n'a pas changé. Cela limite le coût, accélère les relances et stabilise les extractions. Une annonce déjà publiée avec une ancienne version de prompt est réenrichie afin de régénérer la description d'affichage. À chaque scroll avec LLM actif, le skip incrémental exige désormais `raw_payload.llm_display_description` et `raw_payload.llm_prompt_version = LLM_PROMPT_VERSION` : une annonce scorée mais sans synthèse IA publique repasse donc automatiquement dans l'enrichissement.

Avant l'appel LLM, le contexte PDF est réduit à environ 6 000 caractères par
défaut : premières sections des PV descriptifs et cahiers des conditions, puis
fenêtres autour des mots-clés utiles comme surface, pièces, chambres,
occupation, bail, servitude, diagnostics, amiante, plomb, DPE, travaux,
désignation, lots et mise à prix.

Règle de sûreté : le LLM ne remplace pas une valeur déterministe déjà fiable. Il complète surtout les champs absents : `surface_m2`, `rooms_count`, `bedrooms_count`, `occupancy_status`, certains risques, `summary` et `raw_payload.llm_extraction`.

## Source Licitor

Le scraper [licitor.py](src/sources/licitor.py) collecte les six zones publiques Licitor, puis suit les pages détail des annonces.

Champs exploités :

- identifiant Licitor, URL source, titre, ville, département ;
- tribunal, date de vente, mise à prix, visites ;
- description, type de bien, occupation, avocat/contact ;
- coordonnées GPS quand Licitor les expose via le lien de carte.

Le scraper lit `robots.txt` avec le User-Agent configuré, ajoute le délai global entre requêtes, et ne télécharge pas les documents placés dans les chemins interdits par `robots.txt` comme `/data/pub/doc/`.

Configuration :

```bash
ENABLE_LICITOR_BENCHMARK=true
LICITOR_MAX_PAGES=5
```

## Normalisation Des Actifs

Le module [asset_normalization.py](src/asset_normalization.py) transforme les annonces enrichies en champs directement filtrables :

- surfaces : `habitable_surface_m2`, `land_surface_m2`, `carrez_surface_m2` ;
- surface applicative : `app_surface_m2` et `app_surface_kind`, à utiliser à la place de `surface_m2` ;
- preuve surface : `surface_source`, `surface_confidence`, `surface_evidence` ;
- volumes : `rooms_count`, `bedrooms_count`, `bathrooms_count`, `parking_count` ;
- équipements : jardin, terrasse, garage, piscine, climatisation, double vitrage ;
- risques : occupation problématique, servitude, copropriété, amiante, plomb, termites, DPE, travaux ;
- scoring : `investment_score` et `investment_summary`.

Règle surface : l'app ne doit pas utiliser `surface_m2` directement. Elle doit utiliser `app_surface_m2`, qui choisit `carrez_surface_m2` pour les appartements, `habitable_surface_m2` pour les maisons/immeubles, et `land_surface_m2` uniquement pour les terrains.

Les anomalies de qualité sont exposées dans `quality_flags` : `source_not_allowed`, `tribunal_inconsistent`, `missing_gps`, `ambiguous_surface`, `low_confidence_extraction`.

Le score reste explicable : il additionne des composants lisibles autour de l'occupation, l'état général, le type de bien, la localisation, la surface, la mise à prix estimée au m², les atouts jardin/garage/terrasse/piscine et les risques détectés. Le détail est stocké dans `investment_summary`.

Les coefficients du score sont configurables dans `config/scoring.json`. La version actuelle garde tous les poids à `1` et une base de `50`, ce qui reproduit le comportement simple tout en préparant les futurs ajustements.

Supabase reçoit aussi quatre tables thématiques :

- `auction_observations` pour conserver chaque observation source Avoventes/Licitor et son rattachement canonique ;
- `auction_features` pour les équipements et le score ;
- `auction_surfaces` pour les surfaces et volumes ;
- `auction_risks` pour les risques individualisés avec type, label, sévérité et extrait justificatif.

## Comparaison Avoventes / Licitor

Pour produire un benchmark de couverture entre Avoventes et Licitor :

```bash
python -m src.compare_sources
```

Cette commande :

- collecte Avoventes ;
- collecte Licitor en respectant `robots.txt` ;
- normalise les deux sources ;
- rapproche les annonces par `content_hash`, puis par clé souple ville/date/prix/type ;
- exporte :
  - `data/processed/source_comparison.json`
  - `data/processed/source_comparison.csv`

Le rapport contient `matched`, `avoventes_only`, `licitor_only` et les erreurs par source. Si Licitor refuse l'accès via `robots.txt`, le rapport garde Avoventes et indique l'erreur Licitor sans contournement.

## Politesse de scraping

Le scraper :

- lit `robots.txt` ;
- utilise un User-Agent explicite ;
- applique un délai entre requêtes ;
- ne contourne aucune protection technique ;
- utilise uniquement du HTML public statique.

Variables optionnelles :

```bash
AUCTION_USER_AGENT=immojudis-data-pipeline/1.0 (+https://immojudis-dezt.vercel.app/contact)
AUCTION_BROWSER_USER_AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
REQUEST_DELAY_SECONDS=1.5
REQUEST_TIMEOUT_SECONDS=20
GEOCODE_ENABLED=true
GEOCODE_API_URL=https://data.geopf.fr/geocodage/search/
GEOCODE_MIN_SCORE=0.45
CADASTRE_ENRICH_ENABLED=true
CADASTRE_API_URL=https://apicarto.ign.fr/api/cadastre/parcelle
DPE_ENRICH_ENABLED=true
DPE_API_URL=https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines
ENABLE_LICITOR_BENCHMARK=false
LICITOR_MAX_PAGES=5
```

Le géocodage n'est pas appelé si `latitude` et `longitude` sont déjà présents
et plausibles pour le département de la vente. Les résultats BAN/Géoplateforme
acceptés ou rejetés sont conservés dans `raw_payload.geocode` avec le score,
le libellé retourné, le type de résultat, le code commune et la décision
`accepted`. L'enrichissement cadastre est ensuite sauté si la vente n'a pas de
coordonnées. L'enrichissement DPE utilise les coordonnées quand elles existent,
sinon une recherche textuelle d'adresse.

## Rapport Qualité

Chaque run affiche :

- pourcentage avec tribunal ;
- pourcentage avec coordonnées GPS ;
- pourcentage avec surface ;
- pourcentage avec statut d'occupation ;
- pourcentage avec texte enrichi par PDF ;
- pourcentage avec documents ;
- pourcentage avec date de visite.
- nombre de PDF téléchargés ;
- nombre de PDF en erreur.
- nombre de ventes analysées par LLM ;
- nombre de JSON LLM valides ;
- pourcentage de valeurs détectées par LLM ;
- pourcentage de surface extraite par LLM ;
- pourcentage d'occupation extraite par LLM ;
- pourcentage de risques détectés par LLM ;
- erreurs LLM.

## Tests

```bash
pytest
```

Les tests couvrent les conversions de prix, dates françaises, type de bien, extraction de département, inférence de tribunal, géocodage, parsing Avoventes/Licitor, documents, extraction PDF, enrichissement LLM, hash stable, rapport qualité et déduplication, y compris les doublons inter-sources.

## Modèle de données

Le modèle Pydantic `AuctionSale` suit le schéma PostgreSQL `auction_sales`. Les champs peu fiables selon les sources peuvent rester `null`, afin de conserver une donnée brute exploitable dans `raw_text` et `raw_payload`.

## Extension cabinets locaux

Ajouter un scraper dédié par cabinet, avec la même forme de dictionnaire brut que le scraper Avoventes :

```python
{
    "source_name": "cabinet_x",
    "source_url": "...",
    "title": "...",
    "address": "...",
    "starting_price_eur": "...",
    "sale_date": "...",
    "raw_text": "...",
}
```

Puis passer chaque résultat dans `normalize_sale()`.
