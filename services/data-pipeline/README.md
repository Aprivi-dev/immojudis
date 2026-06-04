# Auction Data

Socle technique minimal pour collecter, normaliser, dédupliquer, exporter et insérer dans Supabase des annonces de ventes aux enchères immobilières judiciaires en ancienne Aquitaine.

La source prioritaire est Avoventes. Licitor est disponible comme source optionnelle de benchmark/croisement, pas comme source primaire de vérité.

## Périmètre

- Départements : 33, 64, 40, 24, 47.
- Tribunaux cibles : Bordeaux, Libourne, Bayonne, Pau, Dax, Mont-de-Marsan, Périgueux, Bergerac, Agen, Marmande.
- Sources prévues :
  - `src/sources/avoventes.py` : scraper Avoventes.
  - `src/sources/licitor.py` : scraper Licitor optionnel pour benchmark de couverture.
  - `src/sources/info_encheres.py` : scraper Info Enchères avec fiches détail et PDF publics.
  - `src/sources/vench.py` : scraper Vench pour couverture/listings publics, sans contourner les contenus abonnés.
  - `src/sources/encheres_publiques.py` : scraper Enchères-Publiques.com via les pages SEO publiques.
  - `src/sources/cabinet_generic.py` : point d'extension pour les pages de cabinets locaux.

## Installation

```bash
cd auction-data
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Pour l'extraction PDF de meilleure qualite, installer aussi Docling :

```bash
pip install -r requirements-docling.txt
```

Le pipeline est configure en mode Docling-first par defaut (`PDF_EXTRACTOR=docling`). Si Docling n'est pas installe ou echoue sur un fichier, l'extraction retombe sur PyMuPDF/Tesseract pour ne pas bloquer une collecte.

## Firebase Studio

Le projet est prêt pour un import dans Firebase Studio via la configuration `.idx/dev.nix`.

Avant de pousser le repo :

- ne jamais committer `.env` ;
- ne pas committer les caches et exports dans `data/` ;
- garder seulement les fichiers `.gitkeep` des dossiers de données ;
- configurer les secrets directement dans l'environnement Firebase Studio.

Flux recommandé :

```bash
git add auction-data
git commit -m "Prepare auction data for Firebase Studio"
git remote add origin <url-du-repo-github>
git push -u origin main
```

Puis dans Firebase Studio :

1. Importer le repo GitHub.
2. Attendre l'exécution de `.idx/dev.nix`.
3. Créer un fichier `.env` depuis `.env.example` avec les secrets Supabase et Replicate.
4. Vérifier l'installation :

```bash
source .venv/bin/activate
pytest
```

5. Lancer un run :

```bash
python -m src.main
```

Docling reste optionnel dans Firebase Studio. Pour l'activer explicitement :

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
ENCHERES_PUBLIQUES_PLACES=bordeaux-33,libourne-33,bayonne-64,pau-64,dax-40,mont-de-marsan-40,perigueux-24,bergerac-24,agen-47,marmande-47
```

Tous les scrapers respectent `robots.txt`. Si une source refuse une URL ou masque une partie des documents, le pipeline journalise l'erreur et continue avec les autres sources, sans tentative de contournement.

Créer la table dans Supabase automatiquement avec :

```bash
python -m src.storage.setup_supabase
```

Ou manuellement dans le SQL Editor avec :

```sql
-- sql/schema.sql
```

Le fichier active `pgcrypto`, crée `auction_sales`, les index demandés, active RLS et donne les droits nécessaires au rôle `service_role`.

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
```

Le pipeline :

1. collecte Avoventes pour les départements Aquitaine ;
2. collecte Licitor, Info Enchères, Vench et Enchères-Publiques si les sources de croisement sont activées ;
3. inspecte les fiches détail publiques Avoventes, Info Enchères et Vench pour enrichir les champs et les documents autorisés ;
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
- extrait le texte avec Docling en priorite ;
- met en cache le texte Docling dans `data/raw/docling_texts/` pour eviter de reconvertir les memes fichiers ;
- retombe sur PyMuPDF/Tesseract si Docling n'est pas disponible ou ne retourne pas de texte ;
- stocke les textes dans `data/raw/pdf_texts/{sale_id}.json` ;
- classe les documents prioritaires : PV descriptif, cahier des conditions, diagnostics, avis simplifié ;
- enrichit `surface_m2`, `rooms_count`, `bedrooms_count`, `occupancy_status`, `property_type`, `description`, `risk_notes` et `raw_text`.

Configuration utile :

```bash
PDF_EXTRACTOR=docling
PDF_DOCLING_ENABLED=true
PDF_DOCLING_THRESHOLD_CHARS=1200
PDF_DOCLING_TIMEOUT_SECONDS=180
PDF_DOCLING_OCR_MODE=auto
PDF_DOCLING_OCR_MAX_PAGES=25
PDF_DOCLING_OCR_MAX_SIZE_MB=15
PDF_DOCLING_CHUNK_PAGES=10
PDF_DOCLING_OCR_CHUNK_PAGES=2
PDF_OCR_ENABLED=true
PDF_OCR_LANGUAGE=fra+eng
```

## Enrichissement LLM Replicate

Le module `src/enrichment/` utilise Replicate pour extraire une lecture structurée des textes PDF.
Le modèle par défaut est `google/gemini-2.5-flash`, choisi pour le rapport qualité/prix.

Configuration :

```bash
LLM_ENABLED=true
LLM_PROVIDER=replicate
REPLICATE_API_TOKEN=r8_...
REPLICATE_MODEL=google/gemini-2.5-flash
REPLICATE_TEMPERATURE=0
REPLICATE_MAX_TOKENS=8192
REPLICATE_TIMEOUT_SECONDS=180
REPLICATE_WAIT_SECONDS=60
REPLICATE_CANCEL_AFTER=5m
REPLICATE_MAX_RETRIES=5
REPLICATE_RETRY_BACKOFF_SECONDS=20
REPLICATE_RETRY_MAX_SLEEP_SECONDS=180
REPLICATE_MIN_INTERVAL_SECONDS=10
REPLICATE_THINKING_BUDGET=0
REPLICATE_DYNAMIC_THINKING=false
LLM_PROMPT_VERSION=auction_llm_v2
LLM_PDF_MAX_CHARS=12000
INCREMENTAL_ENRICHMENT=true
PDF_DOCLING_FAST_TIMEOUT_SECONDS=60
PDF_MAX_DOCUMENTS_PER_SALE=4
```

Le provider Replicate appelle l'API HTTP officielle avec `Authorization: Bearer $REPLICATE_API_TOKEN` et l'endpoint `/v1/models/{owner}/{model}/predictions`.
Pour Gemini via Replicate, le client envoie le prompt système dans `system_instruction` et limite la réponse à du JSON validé ensuite par Pydantic.
Les erreurs temporaires Replicate, dont `429 Too Many Requests`, sont retentées avec backoff exponentiel et un délai minimal entre appels pour éviter les rafales en fin de run.
Les textes PDF et les extractions LLM sont mis en cache par empreinte de document/contexte. Le run suivant réutilise les résultats inchangés, limite les documents transmis aux plus utiles et applique un timeout Docling plus court sur les PDF signés ou très lourds avant fallback.

Le pipeline tente systématiquement l'enrichissement LLM pour chaque annonce canonique disposant d'un texte exploitable, sauf option `--no-llm`. Il utilise d'abord le contexte PDF réduit, puis retombe sur `raw_text` si aucun texte PDF n'est disponible. Il continue sans LLM si le provider configuré n'est pas disponible. Les réponses doivent être du JSON valide, validé par Pydantic, puis sauvegardé dans `data/processed/llm_extractions/{sale_id}.json`.

Un cache évite de rappeler Replicate quand le couple `modèle + contexte réduit` n'a pas changé. Cela limite le coût, accélère les relances et stabilise les extractions.

Avant l'appel LLM, le contexte PDF est réduit à environ 8 000-12 000 caractères : premières sections des PV descriptifs et cahiers des conditions, puis fenêtres autour des mots-clés utiles comme surface, pièces, chambres, occupation, bail, servitude, diagnostics, amiante, plomb, DPE, travaux, désignation, lots et mise à prix.

Règle de sûreté : le LLM ne remplace pas une valeur déterministe déjà fiable. Il complète surtout les champs absents : `surface_m2`, `rooms_count`, `bedrooms_count`, `occupancy_status`, certains risques, `summary` et `raw_payload.llm_extraction`.

## Source Licitor

Le scraper [licitor.py](src/sources/licitor.py) collecte systématiquement la page publique
`Sud-Ouest, Pyrénées` filtrée sur `Aquitaine`, puis suit les pages détail des annonces.

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
AUCTION_USER_AGENT=auction-data/0.1 (+contact@example.com)
REQUEST_DELAY_SECONDS=1.5
REQUEST_TIMEOUT_SECONDS=20
GEOCODE_ENABLED=true
GEOCODE_API_URL=https://api-adresse.data.gouv.fr/search/
GEOCODE_MIN_SCORE=0.45
ENABLE_LICITOR_BENCHMARK=false
LICITOR_MAX_PAGES=5
```

Le géocodage n'est pas appelé si `latitude` et `longitude` sont déjà présents.

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
