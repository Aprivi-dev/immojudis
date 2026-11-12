# Immojudis Data Pipeline

Dernière revue de ce document : 31/10/2026 (sources actives, Petites Affiches, Licitor). Le reste du texte date de la configuration de production du 10 septembre 2026, complétée au fil des changements ; en cas de doute, le code et `supabase/migrations/` font foi. Voir aussi [le suivi et la reprise des collectes](../../docs/pipeline-reliability.md).

Socle technique minimal pour collecter, normaliser, dédupliquer, exporter et insérer dans Supabase des annonces de ventes aux enchères immobilières judiciaires en France.

La source prioritaire est Avoventes. Licitor est collecté normalement (source de croisement, affichée au catalogue), mais n'est pas la source primaire de vérité. **Petites Affiches a été retirée du catalogue le 30/10/2026** (voir plus bas).

## Périmètre

- Départements : France entière.
- Tribunaux : normalisation explicite quand la source les fournit ; inférence locale conservée quand elle est connue.
- Sources prévues :
  - `src/sources/avoventes.py` : scraper Avoventes.
  - `src/sources/licitor.py` : scraper Licitor, collecté normalement (source de croisement) ; sert aussi au benchmark de couverture.
  - `src/sources/info_encheres.py` : scraper Info Enchères avec fiches détail et PDF publics.
  - `src/sources/vench.py` : scraper Vench pour couverture/listings publics, sans contourner les contenus abonnés.
  - `src/sources/encheres_publiques.py` : scraper Enchères-Publiques.com via les pages SEO publiques.
  - `src/sources/petites_affiches.py` : scraper Petites Affiches, **retiré du catalogue le 30/10/2026** (décision du propriétaire : même catalogue que Vench et fiches illisibles depuis le changement de présentation du site). Le code est conservé, la collecte est arrêtée par l'interrupteur de retrait (migration `20261110093117_withdraw_petites_affiches_source.sql`, réversible) ; ne pas la relancer sans lever ce retrait.
  - `src/sources/cessions_etat.py` : scraper Cessions immobilières de l'Etat via les cartes HTML publiques.
  - `src/sources/agrasc.py` : scraper AGRASC via les cartes immobilières publiques.
    **Repli (01/11/2026, décision du propriétaire)** : si la page 0 d'agrasc.gouv.fr échoue (5xx ou erreur réseau, après
    les réessais de `PoliteHttpClient` ; ni 4xx, ni refus d'accès, ni chaîne TLS invalide), le collecteur lit la page
    vendeur d'Agorastore (`https://www.agorastore-immo.fr/ventes-immobilieres/vendeur/agrascimmo`, URL nue : son
    robots.txt interdit `?sort=` et `?r=`, aucune pagination n'est devinée) et enrichit chaque produit AGRASC par sa
    fiche `.aspx` (`src/sources/agrasc_operators.py`, `discover_agora_seller_products`). Seuls les produits dont
    `sellerName == "AGRASC"` et dont l'URL est une fiche Agorastore sont gardés ; le prix courant de la liste n'est
    jamais une mise à prix (elle vient de la fiche) ; `upcoming` seulement si `saleStatus == 0` et `endDate` future.
    L'erreur d'origine reste dans `errors` et `coverage.fallback.trigger_error` : le run reste en échec (code 1) et les
    ventes trouvées sont publiées. La couverture est explicitement non certifiée (`coverage_complete` et
    `scoped_inventory_complete` faux, `discovery_channel = agorastore_seller`) : le repli ne fait jamais avancer
    `last_inventory_complete_at` ni `last_publication_complete_at` et ne déclenche aucun retrait par absence. Si
    `countTotal` ne correspond pas au nombre de produits lus, l'écart est signalé dans `errors` et
    `coverage.fallback.incomplete_reasons`.
  - `src/sources/encheres_immobilieres.py` : scraper Enchères Immobilières via les données Next publiques.
  - `src/sources/notaires.py` : scraper Immobilier.notaires.fr via l'API publique des annonces VAE/VNI.
  - `src/sources/cabinet_generic.py` : point d'extension pour les pages de cabinets locaux.

## Installation

```bash
cd services/data-pipeline
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

Les workflows GitHub installent des versions figées et vérifiées par hash
(`pip install --require-hashes -r requirements.lock`, `requirements-dev.lock`,
`requirements-valuation.lock`, générés pour CPython 3.12 sous Linux). Après avoir
modifié un `requirements*.txt`, régénérer les lockfiles avec `pip install uv` puis
`bash scripts/compile_locks.sh` ; `tests/test_requirements_locks.py` échoue si un
lockfile n'est plus aligné sur son fichier source.

Pour les audits documentaires ponctuels les plus lourds, installer aussi Docling (après
`requirements.lock`, avec les mêmes versions pour les dépendances communes) :

```bash
pip install --require-hashes -r requirements-docling.lock
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
pip install --require-hashes -r requirements-docling.lock
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

Pour les écritures directes du pipeline, ajouter aussi l'URL Postgres Supabase :

```bash
SUPABASE_DB_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Quand `SUPABASE_DB_URL` est présent, l'upsert principal des ventes passe par
Postgres direct, puis les tables dérivées (`auction_risks`, documents, score
factors, surfaces, etc.) sont synchronisées via l'API REST service-role.

Le port 6543 (pooler en mode transaction) convient aux écritures, mais pas au
verrou d'écriture du catalogue (`src/catalogue_lock.py`), qui est un verrou
consultatif de session : en mode transaction, chaque transaction peut changer de
session serveur et le verrou ne tient pas. La connexion du verrou passe donc
d'elle-même au port 5432 (pooler en mode session) quand l'hôte est
`*.pooler.supabase.com`, et refuse le port 6543 sur tout autre hôte. Une URL
directe (`db.<project-ref>.supabase.co:5432`) reste inchangée.

#### Chiffrement de la connexion Postgres

La connexion directe est chiffrée : si l'URL ne porte pas de `sslmode`, le
pipeline ajoute `sslmode=require` (`src/storage/connection_guards.py`,
`postgres_ssl_options`). Sans cela, libpq retombe sur `prefer` et accepte un
serveur non chiffré.

- Une URL qui porte son propre `sslmode` (`?sslmode=verify-full`), ou la variable
  d'environnement libpq `PGSSLMODE`, garde la main : rien n'est ajouté.
- `POSTGRES_SSL` (même nom que pour les scripts de migration) choisit le mode :
  non définie ou `require` (défaut), `verify-ca`, `verify-full`, ou `disable`.
  Toute autre valeur est refusée.
- Exception pour le Postgres local de la CI : une base locale (`localhost`,
  `127.0.0.1`, `::1`, socket Unix) n'est pas forcée en `require`, car le service
  Postgres de la CI n'a pas de TLS. `POSTGRES_SSL=disable` désactive le
  chiffrement explicitement, **uniquement** pour une base locale ; sur un autre
  hôte (par exemple un service Docker nommé `postgres`), le pipeline refuse de se
  connecter plutôt que d'envoyer des données en clair.
- La même règle s'applique à l'audit (`src.storage.audit_database`) et au
  rafraîchissement de l'historique Licitor.

#### Contrat entre le pipeline et le schéma migré

`tests/test_schema_contract.py` (marqueur `schema_contract`) vérifie que chaque
colonne écrite par le pipeline (`src/storage/column_sets.py` et constructeurs de
ligne) existe dans la base rejouée depuis zéro, avec un type compatible. Il
n'est pas lancé par `pytest` seul : le job « Supabase migrations + pgTAP » de la CI
l'exécute sur la base Supabase locale.

```bash
SCHEMA_CONTRACT_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  python -m pytest -m schema_contract tests/test_schema_contract.py
```

Le test ne lit que `information_schema` et refuse une base qui n'est pas locale.

#### Valeur relue en base : la garde d'écho

La collecte recopie dans une vente des valeurs qu'elle n'a fait que relire en base
(annonce inchangée, fiche en échec, valeur établie par un document, page Vench
restreinte, colonne remplie par la ligne stockée lors d'une fusion). Si la base
change entre cette lecture et l'écriture, réécrire la valeur lue défait le
changement. `src/base_reads.py` l'empêche : un groupe de colonnes seulement relu
n'est pas réécrit si la base a bougé depuis (surface à cinq colonnes, terrain,
nombre de pièces, occupation, dates de visite). Quand la base n'a pas bougé,
l'écriture est celle d'avant.

Trois conditions, par groupe :

1. **La base a bougé.** Seule une lecture sous le verrou de publication le dit :
   la ligne n'est plus dans l'état de référence (première lecture du passage, puis
   ce que la base a gardé de chaque écriture validée de ce processus). Une lecture
   sans verrou (`fetch_known_sale_details`) alimente les valeurs lues et ne pose la
   référence que si elle manque : elle a pu être lue avant une écriture d'un autre
   fil et notée après.
2. **La vente n'apporte rien** : chaque colonne de valeur est vide ou égale à une
   valeur lue en base. Pour une fiche non relue, une valeur lue dans une colonne
   voisine suffit (la surface affichée se déduit de l'habitable, de la Carrez ou du
   terrain). Pour une fiche réellement relue, seule compte la valeur lue dans la
   **même colonne** : un terrain de 65 m² lu en base ne dit rien d'une surface de
   65 m² que la page vient de donner. Une valeur vide passe toujours (un garde-fou
   de normalisation doit pouvoir vider une valeur).
3. **La source ne vient pas de la publier** : une fiche réellement relue qui donne
   la valeur n'est jamais retenue, même si la base a déjà rendu la même valeur.
   « Ce que la source publie » se lit par la règle de la restauration des pièces
   (`pdf_fact_scope._pdf_source_reader` : l'instantané `source_factual_snapshot` et
   son contexte, relus par `normalize_sale`). La valeur peut donc venir d'une clé de
   l'instantané comme du texte de la page (surface, pièces ou occupation lues dans
   la description, visites lues dans un bloc de la source).

Un faux écho fige une donnée périmée : dans le doute, la garde laisse écrire.

Ce que la garde note d'une écriture :

- l'écriture de `auction_sales` relit par `returning` les colonnes des groupes : la
  référence est ce que la base a **gardé**, pas ce qui a été envoyé (la base peut
  retenir une valeur) ;
- cette lecture est notée en attente dans la portée de la transaction (propre au
  fil qui écrit), sous l'identifiant que la base rend (une vente nouvelle n'en a pas
  encore en mémoire), et ne devient la référence qu'après validation ; une
  transaction annulée ne laisse aucune trace, et n'efface pas les notes d'un autre
  fil ;
- une portée ouverte dans une autre lui verse ses notes : c'est la portée
  extérieure, celle de la transaction, qui confirme ou jette ;
- les écritures en attente de toutes les portées ouvertes sont visibles des lectures
  sous verrou : un autre fil qui relit une ligne entre la validation en base et la
  sortie de la portée n'y voit pas un mouvement ;
- c'est celui qui valide ou annule la transaction qui ouvre la portée
  (`base_reads.written_scope()`, autour de la transaction) : `upsert_sales_to_supabase`
  pour sa propre transaction, `source_detail.publish_source_revision`,
  `verify_publication` (toujours annulée). Une écriture faite dans la transaction
  d'un appelant ne confirme rien elle-même ;
- si la base ne rend pas une ligne par ligne envoyée, rien n'est noté pour le lot et
  une ligne de journal le dit ;
- le repli REST (hors production) n'a ni verrou ni lecture sous verrou : la garde
  n'y agit pas et rien n'y est noté.

Quand un groupe est repris de la base, ce qui décrit la même valeur le suit : pour
la surface, `habitable_surface_m2`, `carrez_surface_m2`, `surface_scope`,
`surface_evidence` ; dans `raw_payload`, la trace de la pièce lue
(`pdf_fact_provenance` du champ et les clés qu'elle nomme, `surface_extraction`,
`land_surface_extraction`). Exception : une colonne voisine que la fiche relue vient
de publier elle-même (son instantané la porte) reste celle de la source. Les copies
de la valeur retenue prennent la valeur écrite : le premier niveau du `raw_payload`
de la ligne, et l'observation embarquée de la source soumise. L'observation d'une
autre source n'est jamais touchée, ni une copie dont la source a réellement publié
la valeur.

Hors périmètre de la garde, à connaître :

- **colonnes calculées** : quand un groupe est repris de la base, les colonnes
  calculées plus tôt sur la valeur en mémoire sont écrites à côté de la valeur de la
  base. Vérifié par l'exécution : `investment_score` et `score_factors` (73,0 écrit
  pour une surface et une occupation dont le recalcul donne 60,0), et la synthèse
  `investment_summary` qui a pu citer l'ancienne valeur. La complétude
  (`premium_readiness_*`) est recalculée à l'écriture, elle suit. L'écart dure
  jusqu'au passage suivant, qui relit la valeur de la base et recalcule ;
- **annonce Licitor à plusieurs lots dont le lot n'est plus désigné** : la lecture de
  la source s'y limite à la clé de l'instantané (règle de `_pdf_source_reader`). Une
  valeur que la page ne donne que dans son texte n'y est pas reconnue comme publiée
  et peut être retenue à tort si la base a porté la même valeur dans la même
  colonne pendant le passage ;
- `reconcile_duplicate_sales_in_supabase` réécrit des lignes entières sans passer
  par la garde ;
- la mémoire de la garde n'est remise à zéro que par `main._open_run`. Les traitements
  qui n'ouvrent pas de passage (relecture de fiche, lecture des pièces, vérification)
  gardent celle de leur processus ;
- le repli REST (hors production) écrit sans transaction, sans verrou et sans garde ;
  une ligne de journal (`REST fallback wrote … sales …`) le dit quand il sert ;

- `lawyer_contact` repris de la ligne connue (carte notaires inchangée) n'est pas un
  groupe de la garde : il est réécrit tel que lu ;
- une valeur sortante vide n'est jamais retenue : si la base a reçu une valeur
  pendant le passage et que la vente en mémoire n'en a pas, l'écriture la vide (hors
  champ tenu, que la base retient) ;
- au recalcul, `visit_dates` est repris brut de l'instantané
  (`recompute_scoring._sale_from_storage_row`) : pour un instantané Licitor à
  plusieurs lots pris avant le 03/11/2026, ce sont les visites de la page entière.

Limite connue : après une fusion entre sources, la vente en mémoire porte le
`raw_payload` stocké de la ligne canonique, sans marqueur « non relue ». À la
publication suivante du même passage, la garde peut ne pas retenir une valeur que la
base a changée entre-temps. La retenue côté base est alors le filet : une pièce posée
pendant l'import n'est pas écrasée (scénario D de
`tests/test_base_echo_registry_postgres.py`).

Restes de rangement pour la refonte de la zone collecte (rien n'est déplacé dans ce
lot) : `source_checkpoint.py` garde sa propre expression de « fiche relue »
(`_known_unchanged`, `_detail_fetch_failed`) à côté de `base_reads.was_reread` ; et
six modules importent `base_reads` pour la seule clé `SOURCE_SNAPSHOT_KEY`, qui est
une clé de `raw_payload` et non une affaire de la garde.

Compteur et journal :

- `timings.base_echo_suppressed` du passage compte les couples (vente, groupe) dont
  une valeur relue et périmée n'a pas été réécrite. Chaque cas est journalisé sans
  valeur (`Base echo suppressed sale_id=… group=…`). Une reprise des seuls libellés
  (même valeur) n'est pas comptée et a sa propre ligne (`Base labels kept …`). Le
  résumé du passage nomme les 50 premiers couples (`base_echo_suppressed_sample` :
  identifiant de vente et groupe, jamais de valeur). Le compteur est alimenté à la
  fusion, avant l'écriture : une transaction annulée et jamais rejouée y reste
  comptée. Il peut surestimer, jamais sous-estimer.
- **Ce compteur peut être supérieur à zéro sans aucun champ tenu** : il suffit qu'un
  autre traitement du pipeline (lecture des pièces, recalcul) ait écrit la vente
  pendant le passage. Ce n'est pas l'indicateur d'un chemin oublié : celui-là est
  l'évènement `echo_suppressed` de la base (mémoire d'écho, alerte du contrôle
  quotidien, `docs/architecture/registre-des-pieces.md`). Il doit rester à zéro :
  les scénarios A, B et C l'affirment avec la garde, et leurs témoins sans la garde
  montrent que la base l'émet alors.
- Les lectures de la ligne entière sont remplacées par des listes de colonnes
  (`LOCKED_SALE_SELECT`, `RECOMPUTE_SALE_SELECT`) : une colonne interne de la
  table ne sort pas de la base et ne finit pas dans `raw_payload`.

Vench, page restreinte ou pauvre : les champs que le collecteur reprend de la ligne
stockée restent dans la vente, mais leur clé est absente de l'instantané de la
fiche, qui en garde la liste (`fields_from_stored_row`), et ils n'entrent pas dans
l'empreinte de fraîcheur. Une restauration « valeur de la source » (pièce modifiée)
ne remet donc pas à vide un champ que la page n'a jamais donné. Cette règle est la
même pour une projection tracée, une ancienne liste de candidats et une pièce
remplacée (`pdf_fact_scope._pdf_restore_value_before_document`). **Vague acceptée** :
l'empreinte de ces pages change une fois. À la première relecture de chacune, la
collecte y voit un changement de la source et réécrit une seule fois
`source_content_changed_at`, avec les marqueurs d'invalidation de l'analyse ; les
relectures suivantes n'y touchent plus. Aucun code de transition. Voir « Effets à la
mise en ligne » pour le nombre de ventes et le coût.

Au recalcul (`recompute_scoring`), une colonne `visit_dates` vide se reprend dans
l'instantané de la fiche quand il existe ; sans instantané, dans la clé de premier
niveau de `raw_payload`, comme avant. Une colonne déjà remplie n'est jamais
remplacée, et une copie de premier niveau n'est jamais réécrite vide par une colonne
que le recalcul laisse vide. Pour ce qui est affiché, une date de visite ne peut
donc **ni disparaître ni changer** au premier recalcul ; seule une **apparition** est
possible (colonne vide, instantané qui porte des visites). Par rapport à l'ancien
code, une colonne vide n'est en revanche plus remplie depuis la copie de premier
niveau quand l'instantané existe et n'en donne pas (deuxième compte ci-dessous).

À compter en production avant le premier recalcul (lecture seule, comptages
seulement) :

```sql
select
  count(*) filter (where column_empty and snapshot_visits) as visites_qui_apparaissent,
  count(*) filter (where column_empty and has_snapshot and not snapshot_visits and copy_visits)
    as copies_non_rejouees,
  count(*) filter (where column_empty and not has_snapshot and copy_visits)
    as repli_d_origine_sans_instantane
from (
  select
    coalesce(visit_dates, '[]'::jsonb) = '[]'::jsonb as column_empty,
    jsonb_typeof(raw_payload -> 'source_factual_snapshot') = 'object'
      and raw_payload -> 'source_factual_snapshot' <> '{}'::jsonb as has_snapshot,
    coalesce(raw_payload -> 'source_factual_snapshot' -> 'visit_dates', 'null'::jsonb)
      not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb) as snapshot_visits,
    coalesce(raw_payload -> 'visit_dates', 'null'::jsonb)
      not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb) as copy_visits
  from public.auction_sales
  where status in ('upcoming', 'active', 'quarantined')
) sales;
```

Les deux premiers comptes sont des majorants : la normalisation repasse ses
garde-fous sur la valeur reprise et peut l'écarter.

#### Effets à la mise en ligne

Ce lot n'est pas sans effet tant qu'aucune vente n'est tenue. Dès sa mise en ligne :

1. **La garde d'écho agit dès le premier jour.** La file de lecture des documents
   écrit les ventes en parallèle de la collecte : une valeur seulement relue par la
   collecte n'écrase plus ce que la file vient d'écrire. Un compteur
   `base_echo_suppressed` supérieur à zéro est attendu, sans aucun champ tenu.
2. **Observations en version 3.** À la première écriture de chaque vente, par
   n'importe quel écrivain (collecte, relecture de fiche, lecture des documents,
   recalcul), ses observations reçoivent un jumeau `auction_fact_claims_v3`. Il n'y a
   pas de doublement : le plafond est d'environ 13 000 lignes rattachées en plus (27 à
   33 % des lignes de la collecte, mesure du 12/11/2026). La table est immuable et
   sans purge : ces lignes restent.
3. **Vench.** 81 ventes (au 11/11/2026) est un plancher. L'empreinte de fraîcheur de
   ces pages change à leur première relecture, et l'empreinte « major » peut changer
   elle aussi : la lecture des pièces et le modèle sont alors relancés pour ces
   ventes. Budget à prévoir à la reprise de Vench ; sans effet tant que Vench ne
   tourne pas (aucun passage depuis le 29/10/2026). Les instantanés Vench déjà
   stockés contiennent encore des valeurs reprises de la ligne (ils ne listent pas
   `fields_from_stored_row`) : ils restent pollués jusqu'à la relecture de la page, et
   leurs observations de version 3 en héritent d'ici là.
4. **`visit_dates` au premier recalcul.** Voir ci-dessus : une apparition possible,
   jamais une disparition ni un changement d'une date affichée.
5. **Questions à l'avocat, brouillons, pilote.** La vue
   `v_auction_fact_claims_read_model` alimente les questions à l'avocat de la fiche
   (`src/app/api/sales/[id]/lawyer-questions/route.ts`), les brouillons de l'agent
   d'information et le pilote. Dès qu'une vente porte une observation de version 3,
   ses candidates de version 2 sont masquées. Quand la version 3 n'émet plus le seul
   `source_field` d'un champ (vente sans instantané, instantané d'une autre source,
   surface venue d'un document et non de la page), ce champ n'a plus d'observation
   visible. Effet sur le site et sur l'outil de sollicitation
   (`src/lib/fact-reliability.ts`) : un fait clé sans observation visible retombe sur
   l'ancien contrôle ; des libellés passent de « Non vérifié » à « Documenté » et la
   question de confirmation correspondante disparaît. Il n'y a jamais de question
   nouvelle sur un champ rempli. Côté pilote : moins de lacunes signalées, jamais
   plus.
6. **Perte connue : vente sans instantané, jamais relue, dont l'annonce publiait la
   valeur.** La version 2 en tirait ses `source_field` (jusqu'à quatre) ; la version 3
   n'en tire plus que les observations de ses blocs de source. Sans instantané, rien
   ne distingue ce que l'annonce a publié de ce que la collecte a relu en base : ces
   observations ne reviennent qu'à la prochaine relecture de la fiche. Ligne
   « 1. vente sans instantané » de la requête ci-dessous.

Comptage du 12/11/2026 en production, par la première version de cette requête : 953
ventes à venir avec des observations de version 2, 209 avec au moins un champ sans
observation de version 3 (302 champs), 35 avec un champ non évalué, 15 qui gardent
leurs observations de version 2.

À relancer avant la fusion (une seule instruction `select`, lecture seule). Elle se
limite aux quatre faits que l'application lit (date, mise à prix, surface regroupée,
occupation) et dit pourquoi le fait n'a plus d'observation, par source :

```sql
with claims as (
  select
    claim.auction_sale_id,
    claim.source_url,
    claim.evidence_locator ->> 'kind' as kind,
    claim.evidence_locator ->> 'field' as value_key,
    case
      when claim.field_key = 'sale.sale_date' then 'date'
      when claim.field_key = 'sale.starting_price_eur' then 'mise_a_prix'
      when claim.field_key = 'property.occupancy_status' then 'occupation'
      when claim.field_key in (
        'property.surface_m2', 'property.habitable_surface_m2',
        'property.carrez_surface_m2', 'property.land_surface_m2'
      ) then 'surface'
    end as fait
  from public.auction_fact_claims claim
  where claim.extractor_name = 'immojudis.pipeline.fact_claims'
    and claim.extractor_version = 'auction_fact_claims_v2'
    and claim.claim_status = 'candidate'
    and claim.auction_sale_id is not null
),
judged as (
  select
    sale.id,
    sale.source_name,
    claims.fait,
    coalesce(sale.raw_payload -> 'source_factual_snapshot', 'null'::jsonb)
      in ('null'::jsonb, '{}'::jsonb) as no_snapshot,
    coalesce(sale.raw_payload -> 'source_factual_snapshot' ->> 'source_url', sale.source_url)
      <> sale.source_url as foreign_snapshot,
    coalesce(sale.raw_payload -> 'source_blocks', 'null'::jsonb)
      not in ('null'::jsonb, '{}'::jsonb) as has_source_blocks,
    case
      when claims.kind is distinct from 'source_field' then true
      when claims.source_url is distinct from sale.source_url then null
      else coalesce(sale.raw_payload -> 'source_factual_snapshot' ->> 'source_url', sale.source_url)
             = sale.source_url
           and coalesce(sale.raw_payload -> 'source_factual_snapshot' -> claims.value_key, 'null'::jsonb)
             not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb)
    end as kept
  from claims
  join public.auction_sales sale on sale.id = claims.auction_sale_id
  where sale.status in ('upcoming', 'active')
),
per_sale as (
  select id, coalesce(bool_or(kept), false) as emits_v3
  from judged
  group by id
),
per_fact as (
  select
    judged.id,
    judged.source_name,
    judged.fait,
    bool_or(judged.no_snapshot) as no_snapshot,
    bool_or(judged.foreign_snapshot) as foreign_snapshot,
    bool_or(judged.has_source_blocks) as has_source_blocks,
    coalesce(bool_or(judged.kept), false) as fact_kept,
    coalesce(bool_or(judged.kept is null), false) as fact_not_evaluated
  from judged
  where judged.fait is not null
  group by judged.id, judged.source_name, judged.fait
)
select
  per_fact.source_name,
  per_fact.fait,
  case
    when per_fact.fact_not_evaluated then '4. observation d''une autre source de la vente, non évaluée'
    when per_fact.no_snapshot then '1. vente sans instantané'
    when per_fact.foreign_snapshot then '2. instantané d''une autre URL'
    else '3. instantané présent, champ vide'
  end as raison,
  count(*) as ventes,
  count(*) filter (where per_fact.has_source_blocks) as dont_ventes_avec_blocs_de_source
from per_fact
join per_sale on per_sale.id = per_fact.id
where per_sale.emits_v3
  and not per_fact.fact_kept
group by 1, 2, 3
order by 1, 2, 3;
```

Lecture :

- une ligne par source, fait et raison ; `ventes` compte les ventes qui émettront au
  moins une observation de version 3 (leurs candidates de version 2 seront masquées)
  et dont ce fait n'avait que des `source_field` que la version 3 n'émet plus ;
- les raisons 1 et 2 sont la perte (aucun instantané de cette source à lire) ; la
  raison 3 est l'effet voulu (la source ne publie pas ce champ : la valeur venait de
  la base, d'un document ou du texte) ; la raison 4 n'est pas évaluée (l'instantané
  d'une source secondaire est dans `observations`, hors de portée d'une requête
  simple) ;
- **majorant** : la version 2 gardait une seule observation par champ, valeur et URL,
  le `source_field` masquant son jumeau lu dans un bloc de la source
  (`fact_claims._deduplicate_candidates`). En version 3 ce jumeau réapparaît et le
  fait garde une observation. Le SQL ne peut pas rejouer la lecture des blocs (clés
  normalisées, valeurs relues) : `dont_ventes_avec_blocs_de_source` donne seulement
  les ventes qui ont des blocs, donc où ce jumeau est possible.

**Condition vérifiée le 12/11/2026.** Une observation de version 2 déjà rejetée
aurait pu revenir sous son jumeau de version 3. En production, les 40 201
observations de la collecte étaient toutes `candidate` (aucune acceptée, aucune
rejetée) : le cas ne se présente pas à la bascule. Requête de contrôle, à relancer
si la fusion tarde :

```sql
select claim_status, count(*)
from public.auction_fact_claims
where extractor_name = 'immojudis.pipeline.fact_claims'
group by claim_status
order by claim_status;
```

Tests : `tests/test_base_echo_guard.py` (table de vérité),
`tests/test_base_echo_publication.py` (chemin d'écriture, base simulée, dont la
preuve d'écriture identique quand rien ne bouge), `tests/test_base_echo_postgres.py`
(`PIPELINE_TEST_DB_URL`). Les scénarios de bout en bout avec le registre des pièces
(retrait ou remplacement d'une pièce pendant un import, surface tenue face à une
fiche relue) demandent une base locale jetable où toutes les migrations sont
rejouées ; ils écrivent dans cette base et refusent toute base non locale. Le job
« Supabase migrations + pgTAP » de la CI les lance sur sa base locale, avec
`PIPELINE_REGISTRY_DB_REQUIRED=1` : l'absence de base y est un échec, pas un saut.

```bash
PIPELINE_REGISTRY_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  python -m pytest -s tests/test_base_echo_registry_postgres.py
```

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
PIPELINE_LLM_MAX_TARGETS=0
DEDUPE_RECONCILE_ENABLED=false
DEDUPE_RECONCILE_MAX_ROWS=20000
DEDUPE_RECONCILE_MAX_MERGES=100
DEDUPE_RECONCILE_MODE=apply
```

Après les upserts d'une collecte complète, le pipeline peut relire toutes les annonces
actives/prochaines/inconnues déjà stockées (pagination, jusqu'à `DEDUPE_RECONCILE_MAX_ROWS` lignes lues)
et réappliquer la fusion multi-sources. Cette passe corrige les doublons historiques qui ne repassent pas
forcément ensemble dans le scraping du jour, puis supprime les lignes sources secondaires. Elle est
coupée par défaut (`DEDUPE_RECONCILE_ENABLED=false`) ; garde-fou d'écriture : au plus
`DEDUPE_RECONCILE_MAX_MERGES` lignes supprimées par passage, par groupes entiers.

Mode candidats, sans aucune écriture, à lancer avant d'activer la passe :
`python -m src.dedupe_candidates [--output rapport.json]`, ou le workflow GitHub « Dedupe candidates
report » (lecture seule), ou la variable de dépôt `DEDUPE_RECONCILE_MODE=candidates` pendant une collecte
complète. Il journalise chaque paire conservée / supprimée (identifiant, source, commune, date, mise à prix, raison)
et écrit le même tableau dans le résumé du job.

La collecte planifiée lance une seule source à la fois ; or la passe ci-dessus n'est appelée par
`src.main` que pour `--source all` sans limite, donc jamais en collecte planifiée. Le point d'entrée
`python -m src.dedupe_apply` (workflow GitHub « Dedupe sweep », manuel, groupe de concurrence
`immojudis-data-pipeline`, environnement Production) l'exécute à part : passerelle du catalogue, puis
fusion et suppression, au plus 100 lignes par passage et seulement si `DEDUPE_RECONCILE_ENABLED=true`
ou si le workflow est lancé avec `apply` coché et `confirm_target` = `production` (pour ce lancement
seulement) ; sinon rien n'est écrit, et le mode candidats reste en lecture seule. La lecture se fait par
pages de `DEDUPE_RECONCILE_PAGE_SIZE` lignes (100 par défaut), curseur sur `id`, et réduit la page quand
un délai SQL est dépassé. Dans ce balayage, la clé de repli
stricte (tribunal, jour, mise à prix, bien) est permise hors Vench / Petites Affiches, et un (jour, prix)
partagé par plus de 5 annonces ou un groupe de plus de 5 lignes n'est jamais fusionné. Les données des
comptes (favoris, notes, alertes, rapports…) des lignes supprimées passent à la fiche conservée dans la
base (migration `20261028110000`), qui garde aussi la correspondance ancien identifiant → fiche conservée
(redirection 308 de `/sales/<ancien id>`).

La file documentaire est consommée uniquement sur lancement manuel.

### Backfill des claims historiques

La migration `auction_fact_claims` ne convertit pas les anciennes colonnes
aplaties en claims : elles ne portent pas une preuve au niveau du champ. Le
backfill opérateur lit uniquement `raw_payload`, `observations` et les lignes
persistées de `auction_observations`. Il conserve un curseur local par
`(auction_sales.updated_at, auction_sales.id)`, reprend après chaque lot
committed et ignore les ventes sans preuve avec un compteur explicite.

Depuis `auction_fact_claims_v3`, une observation de nature `source_field` ne se
lit que dans `raw_payload.source_factual_snapshot` (ce que la source a publié à la
dernière lecture de sa fiche), pour la vente comme pour chaque observation d'une
autre source. Les clés de premier niveau de `raw_payload` portent aussi les
colonnes que la collecte a relues en base : elles ne font plus une observation.
Sans instantané, pas d'observation. Un instantané qui nomme une autre source que
celle de l'observation est ignoré : une carte secondaire non relue d'une vente
fusionnée reçoit l'instantané de la ligne canonique, qui n'est pas ce que sa source
a publié. Les lignes `auction_fact_claims_v2` déjà écrites restent en base ; un
lecteur peut les écarter par leur version. Une file de reprise écrit ses lignes
sous la version courante (`FACT_CLAIMS_VERSION`), celle de leur identifiant.

**Ordre de mise en ligne.** La version entre dans l'identifiant d'une observation :
à la première écriture de chaque vente, chaque observation existante reçoit un
jumeau `auction_fact_claims_v3` (une vente relue ou dotée d'un instantané en émet
autant qu'avant ; une vente sans instantané n'émet plus ses `source_field`). Volume
et conséquences : « Effets à la mise en ligne », plus haut. La vue `v_auction_fact_claims_read_model`, lue par
l'application sans filtre de version, montrerait chaque fait en double sans la
migration `20261117100700`, qui ne montre que la dernière génération par vente
(appliquée en production le 12/11/2026). Ce que cette vue attend de la collecte :

- la version reste sous le plafond `app_private.fact_claims_generation_ceiling()`
  (3). Au-dessus, les observations seraient masquées : une version 4 demande
  d'abord une migration qui relève le plafond (invariant
  `fact-claims-generation-pattern`) ;
- dès qu'une vente porte une observation de version 3, toutes ses candidates de
  version 2 sont masquées, quel que soit leur champ. Une vente sans instantané qui
  émet encore d'autres observations perd donc à l'affichage ses anciens
  `source_field` ; une vente qui n'émet plus rien garde ceux de la version 2 ;
- les observations d'une vente partent dans la transaction de sa publication, en
  une fois (le repli REST, hors production, écrit par lots).

Le mode par défaut est une lecture sans écriture Supabase :

```bash
python scripts/backfill_fact_claims.py --limit 100 --batch-size 25
```

Pour insérer les seuls claims `candidate`, il faut demander explicitement le
mode d'application. Une reprise d'un état `dry-run` exige `--restart` (ou un
nouveau fichier d'état) afin de relire toute la fenêtre inspectée :

```bash
python scripts/backfill_fact_claims.py \
  --limit 100 --batch-size 25 --apply --restart
```

Le curseur suit uniquement `auction_sales.updated_at`. Si des preuves sont
ajoutées ou corrigées plus tard dans `auction_observations`, elles ne déplacent
pas ce curseur : relancer avec `--restart` (ou un nouveau fichier d'état) pour
rejouer le périmètre concerné, avec le même mode d'exécution.

Le fichier d'état par défaut est ignoré par git dans `data/processed/`. Les
UUID de claims sont déterministes et l'insert utilise `ON CONFLICT (id) DO
NOTHING`; un rerun est donc idempotent et ne résout jamais un claim.

En CI, les backfills IA sont volontairement bornés par petits lots et les
prédictions Replicate démarrent avec `REPLICATE_WAIT_SECONDS=1` pour éviter
d'ajouter le temps de génération à l'intervalle minimal entre deux requêtes.

Réglages de la collecte Licitor (la source est collectée normalement ; ces variables bornent le benchmark de couverture) :

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
# Petites Affiches est retirée du catalogue depuis le 30/10/2026 : ne pas l'activer (voir plus haut).
ENABLE_PETITES_AFFICHES_BENCHMARK=false
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

Initialisation du schéma :

`python -m src.storage.setup_supabase` et `sql/schema.sql` sont réservés aux bases
locales jetables. Une base Supabase hébergée doit être créée et mise à jour
exclusivement par les migrations versionnées du dossier `supabase/migrations`,
afin que le contrôle de dérive de la phase 3 reste fiable.

## Import DVF semestriel

Les comparables DVF détaillés s'appuient sur le jeu certifié `Demandes de
valeurs foncières géolocalisées` publié sur data.gouv.fr. L'import accepte les
fichiers `.txt`/`.csv`, les flux `.csv.gz` et les archives `.zip`, avec
séparateur `|`, `;`, `,` ou tabulation. Les codes DGFiP des maisons,
appartements et locaux sont normalisés vers le contrat DVF+ interne ; les
dépendances sans surface exploitable sont ignorées.

Le workflow GitHub Actions `Immojudis DVF Import` est planifié le 10 avril et
le 10 octobre. Il lit l'API officielle data.gouv.fr, récupère les ressources
principales DVF géolocalisées, vérifie les checksums SHA-1 quand ils sont fournis,
puis appelle `python -m src.dvf_import`. Le workflow peut aussi être lancé
manuellement avec `dry_run=true`, une `resource_url` précise ou une limite de
lignes pour tester un millésime avant import complet.

Valider un fichier sans écrire en base :

```bash
python -m src.dvf_import data/raw/dvf/valeursfoncieres-2024.txt --dry-run --limit 10000
```

Importer dans Supabase/Postgres :

```bash
python -m src.dvf_import data/raw/dvf/dvf.csv.gz \
  --source-url "https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres-geolocalisees"
```

Remplacement complet (`replace_existing=true` dans le workflow) : chaque fichier
est chargé dans `dvf_transactions_staging` (`--stage`, avec `--reset-staging` pour
le premier), puis un seul `python -m src.dvf_import --swap-staging` construit les
index sur la table de staging et l'échange avec `dvf_transactions` dans une seule
transaction. Un import interrompu laisse `dvf_transactions` intact ; `--replace-existing`
reste disponible pour un fichier unique (chargement et échange dans le même appel).
Les téléchargements ont un délai de 120 s et n'acceptent que `data.gouv.fr`,
`www.data.gouv.fr`, `files.data.gouv.fr` et `static.data.gouv.fr` (redirections comprises).

Le calcul backend tente d’abord les ventes détaillées normalisées en base, puis
les fichiers officiels DVF par commune publiés sur data.gouv.fr. Quand cet
échantillon local reste insuffisant, il utilise les médianes officielles par
commune, intercommunalité ou département comme estimation indicative de repli.
Cette dernière conserve une fourchette volontairement large et n’alimente pas
automatiquement la mise plafond tant qu’elle n’est pas confirmée.

Importer ou rafraîchir ces statistiques agrégées :

```bash
python -m src.dvf_statistics_import data/raw/dvf/stats_whole_period.csv \
  --source-url "https://www.data.gouv.fr/datasets/statistiques-dvf" \
  --source-updated-at 2026-04-27
```

Cette commande requiert `SUPABASE_DB_URL` et écrit dans `dvf_import_batches` et
`dvf_transactions`. Les données brutes restent derrière les API ImmoJudis
plan-gatées ; elles ne doivent pas être ré-exposées directement ni indexées par
des moteurs externes.

## Données de référence (`reference_data`)

Jeux ouverts qui alimentent les blocs « Risques environnementaux » et « Historique météo » d'une annonce, les
rendements (carte des loyers) et, à venir, le zonage tendu. Import manuel, jamais planifié :

```bash
cd services/data-pipeline
python -m src.reference_data {communes,risks,climate,rents,tension,all} [--dry-run] [--work-dir DIR]
```

- **Sans `--dry-run`, l'import écrit en production** : `SUPABASE_DB_URL` est obligatoire (l'import s'arrête sans
  elle). Avec `--dry-run`, il télécharge et analyse sans rien écrire et affiche le résumé (par exemple
  `web_edition_gap` pour `rents`).
- Jeux et tables : `communes` (geo.api.gouv.fr, `reference_communes`), `risks` (GASPAR, `commune_risk_profiles`),
  `climate` (Météo-France, `climate_stations` et `climate_station_months`), `rents` (carte des loyers de l'ANIL,
  `anil_rents`) et `tension` (zonage TLV, `commune_housing_tension`). `all` les relance **tous les cinq**, dans cet
  ordre.
- Gardes contre une source tronquée : au moins 30 000 communes pour `communes` et `risks`, au moins 90
  départements de fichiers pour `climate`, au moins 34 000 communes par segment pour `rents` et au total pour
  `tension` ; pour `rents` et `tension`, au plus 0,5 % de lignes rejetées. Un refus lève une erreur avant toute
  écriture.
- L'écriture se fait par paquets de 1 000 lignes, avec un commit par paquet : elle n'est **pas atomique**. Pour
  `rents` et `tension`, l'import purge ensuite les lignes non touchées puis contrôle la table (un seul millésime
  et le bon nombre de lignes pour `anil_rents`) ; un échec laisse un mélange, que le même import relancé répare
  (il est idempotent).
- Dans GitHub Actions : workflow **Reference data import** (manuel, entrées `dataset` et `dry_run`, 90 minutes au
  plus, secret `SUPABASE_DB_URL`).
- Rythme : `rents` chaque décembre (checklist : `docs/runbooks/import-annuel-anil.md`), `tension` après un décret,
  `communes`, `risks` et `climate` rarement (les sources se renouvellent au plus tous les mois), `all` à éviter
  pour une mise à jour ciblée.
- Détail des sources, des formats et de la lecture par l'application :
  `docs/operations/donnees-de-reference-loyers-et-zonage.md` et
  `docs/operations/donnees-de-reference-environnement.md`.

## Entraînement de l'estimation immobilière

Le modèle de valorisation est entraîné hors ligne à partir de la table DVF
normalisée. Il utilise trois modèles LightGBM quantiles (P10, P50 et P90), puis
MAPIE pour conformaliser l'intervalle sur un jeu de calibration chronologique.
La séparation train/calibration/test respecte l'ordre des dates afin d'éviter
de faire fuiter des ventes futures dans les métriques.

Le modèle est d'abord validé sur ce découpage (70 % / 15 % / 15 %), puis le
modèle publié est réentraîné sur train + calibration et ses intervalles sont
recalibrés sur la fenêtre la plus récente (les métriques publiées décrivent le
modèle de validation). Les variables de marché local (`local_median_log`,
`local_spread_log`, `local_sample_size_log`) d'une vente ne s'appuient que sur
les ventes qui la précèdent, par cellule H3 (`resolve_local_market`). Les
statistiques de cellules sont exportées dans l'artefact (`localMarket`) pour que
la production recalcule exactement ces variables ; l'implémentation de référence
est `lookup_exported_local_market`.

Chaque entraînement écrit `<segment>-<version>.report.json`, qui compare le
nouveau modèle, le modèle actif et deux références naïves (moyenne géométrique
locale passée et médiane des ventes d'entraînement de la cellule) sur les ventes
les plus récentes ; le même tableau est ajouté au résumé du run GitHub.

Installer les dépendances optionnelles :

```bash
pip install -r requirements-valuation.txt
```

Entraîner et écrire les artefacts localement :

```bash
python -m src.valuation_training --segment apartment --segment house
```

Publier une version en brouillon, puis l'activer après contrôle :

```bash
python -m src.valuation_training --segment apartment --publish
python -m src.valuation_training --segment apartment --activate
```

Le modèle est refusé si le jeu de test contient moins de 50 ventes, si
l'erreur absolue médiane dépasse 30 %, si la MAPE dépasse 40 %, si la couverture
P10-P90 est inférieure à 72 % ou si la largeur moyenne de l'intervalle dépasse
110 %. `--force` contourne ces seuils absolus pour les essais contrôlés, pas
pour les runs planifiés. L'activation exige en plus au moins 300 ventes de test
chronologiques (en dessous, le modèle reste un brouillon), une erreur absolue
médiane strictement meilleure que celle du modèle actif (évalué sur les mêmes
ventes, avec ses propres variables de marché local lues dans l'export de son
artefact) et que celle de la référence naïve la plus forte, un intervalle
bootstrap apparié à 95 % de chacun de ces écarts entièrement sous zéro
(`error_gap` du rapport), et au moins 70 % des ventes de
validation (les plus récentes, jamais vues par l'apprentissage ni par la
calibration) dans l'intervalle tel que l'application le sert : les quantiles
P10 et P90 bruts décalés des corrections exportées dans l'artefact, comme le fait
`predictLightGbmQuantiles`, et non l'intervalle MAPIE. Le niveau nominal est de
80 % ; le seuil de 70 % tolère la dérive attendue entre la fenêtre de calibration
et les ventes les plus récentes, mais pas un intervalle qui manque plus de trois
ventes sur dix. La couverture est mesurée par segment (un modèle par segment) et
écrite dans `coverage` du rapport (part dedans, au-dessous et au-dessus), dans
`served_interval_coverage_pct` des métriques et dans le résumé du run. Elle ne
mesure que l'intervalle du modèle, avant son mélange avec les comparables locaux.
`--force` ne contourne jamais ces tests, et un modèle qui ne les passe pas est
publié en brouillon. Les variables de marché local servies par l'API sont lues
dans l'export `localMarket` de l'artefact (`src/lib/local-market-features.ts`, port
de `lookup_exported_local_market`) ; `tests/fixtures/local_market_parity.json` est
le jeu de référence commun des tests Python et TypeScript.
L'API mélange le modèle actif avec les comparables locaux et revient
automatiquement au moteur comparable si l'artefact est absent ou invalide.
La valeur de marché ainsi produite reste distincte du calcul de mise plafond,
qui retire ensuite travaux, frais et marge de sécurité.

Le workflow GitHub Actions `Immojudis Valuation Model Training` est uniquement
déclenché manuellement. Il entraîne chaque segment séparément sur au plus
750 000 ventes récentes, applique les mêmes seuils de promotion et conserve le
bundle JSON et le rapport de comparaison pendant 30 jours pour audit. Il publie
des brouillons par défaut (`activate: false`) ; une activation exige la
confirmation explicite de la cible `production`.

`scripts/publish-valuation-models.mjs` n'active un bundle que si son rapport
(`<segment>-<version>.report.json`, à garder à côté du bundle) déclare la porte
franchie et que ses chiffres la respectent (`scripts/lib/valuation-promotion-gate.mjs`).
Retour à la version précédente : `docs/runbooks/modeles-valorisation-retour-arriere.md`.

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
Supabase et lance le pipeline avec ses paramètres. La variante `--enrichment-only` doit être lancée manuellement. La collecte nationale reste exclusivement manuelle, via `workflow_dispatch` ou l’admin.

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
PDF_OCR_ENABLED=true
PDF_OCR_LANGUAGE=fra+eng
# Délai minimal entre deux requêtes de pièces jointes vers un même hôte
# (plancher 1 s ; un Crawl-delay de robots.txt l'augmente).
PDF_HOST_MIN_DELAY_SECONDS=2
```

Les cahiers des charges et règlements de consultation alimentent aussi la
date limite de remise des offres (`pdf_offer_deadline_extraction`) ; pour les
appels d'offres (Cessions de l'État, AGRASC, notaires) sans échéance connue,
elle devient `sale_date` si elle est unique et à venir.

### Vider le stock de pièces jointes

Le mode manuel « documents*backlog » du workflow \_Immojudis Data Pipeline*
(`workflow_dispatch`) ne fait que la lecture des pièces jointes :

```bash
python -m src.document_backlog --max-sales 200 --budget-minutes 120 --max-passes 4
```

- ventes actionnables (à venir, inconnues, reportées) dont des pièces ne sont
  pas lues, la plus proche échéance d'abord, puis celles qui ont des pièces
  utiles (cahier des conditions, PV descriptif, diagnostics, cadastre,
  urbanisme) ;
- la génération PDF courante de chaque vente est remise en file (y compris un
  job terminé, annulé ou à court d'essais), réservée seule et traitée par le
  code normal de la file (robots.txt, délai par hôte, OCR, points de reprise) ;
- six documents par passage (et 120 s d’OCR par document), passages enchaînés
  jusqu’à `--max-passes` (4 par défaut) par vente ;
- une passe qui réécrit la vente (point d'étape durable, manifeste re-clé) voit
  sa tâche remplacée par une nouvelle génération (« Superseded by a newer input
  revision » ou « superseded after durable PDF checkpoint ») : le vidage remet
  en file cette génération et la suit, dans la limite de `--max-passes`. Une
  annulation pour une autre raison (annonce retirée) termine la vente ;
- une vente pour laquelle le vidage a déjà demandé 2 lectures pdf terminées en
  24 heures n'est pas choisie, quelle que soit l'empreinte de ses tâches
  (plafond de relecture du 11/11/2026) ; sa tâche en file reste servie par la
  voie générale ;
- une tâche qui attend une échéance (« PDF pass deferred » : rien à revalider
  sur un manifeste complet qui contient une URL écartée) termine la visite de
  la vente, sans passe de plus ;
- une tâche pdf annulée « review_required » (écriture de fin de passe refusée à
  l'admission quatre fois de suite) n'est pas réveillée pendant 7 jours si
  l'audience est à plus de 7 jours, pendant 1 jour sinon ; l'attente tombe si
  les règles de lecture changent ou si une génération plus récente, non
  annulée, existe ;
- une valeur de pièce effacée laisse la place à la valeur que la collecte a
  écrite, jamais à une autre : l'instantané de la source est relu avec le
  contexte de la collecte (lot de l'annonce compris) ; sans lot désigné sur une
  annonce Licitor à plusieurs lots, seul ce que l'instantané porte pour le
  champ est remis, sinon rien (`src/pdf_fact_scope.py`) ;
- les erreurs restent sur le job et le manifeste documentaire de la vente ;
- une pièce trop lourde au téléchargement (au-delà de `PDF_MAX_DOWNLOAD_MB`,
  50 Mo dans le workflow) est un échec définitif (`document_too_large`), comme
  une 404 : elle est consignée inutilisable et n'empêche plus la vente d'être
  lue ;
- une vente dont les documents sont déjà à jour voit seulement sa projection
  `auction_documents` réécrite.

Le verrou d'écriture du catalogue est pris **vente par vente**, et seulement
pour les passes qui publient. Pendant ce temps, les ventes suivantes sont
**lues en avance, hors du verrou** (`src/document_prefetch.py`) : des processus
à part téléchargent leurs pièces dans le cache local et lisent leurs pages,
sans aucune écriture en base. La passe sous verrou reste seule à écrire et
trouve les pages déjà lues. Quatre ventes d'avance par processus ; une vente
n'est jamais préparée et traitée en même temps ; chaque processus multiplie le
délai par hôte par le nombre de processus. La préparation ne restaure que le
cache de pages, jamais le manifeste local de la vente.

```bash
# Nombre de processus de lecture en avance : 3 par défaut, 0 la coupe, 6 au plus.
DOCUMENT_BACKLOG_PREFETCH_WORKERS=3
```

Dans le workflow, la valeur vient de la variable de dépôt
`DOCUMENT_BACKLOG_PREFETCH_WORKERS` (3 si elle est absente, `0` pour couper sans
commit). Les tests la mettent à 0.

En fin de vidage, le résumé d'étape et le journal donnent le bilan de
rendement : ventes lues (`sales_read`), passes et passes partielles
(`partial_passes`, `partial_pass_share`), points d'étape refusés
(`refused_checkpoints`), durée, et chiffres de la lecture en avance
(`prefetch`, dont `deferred_exhausted` et `errors`). Un vidage de plus de
30 minutes (attente du verrou du catalogue retranchée) qui a lu moins de
4 ventes par heure, ou dont plus de 30 % des passes sont partielles, ouvre
l'alerte `pipeline.documents_backlog.low_yield`
(`src/document_backlog_yield.py`, migration `20261111131500`).

Symptômes, interrupteur et retour arrière :
[`docs/runbooks/vidage-des-pieces.md`](../../docs/runbooks/vidage-des-pieces.md).
Incident du 04/11/2026 (boucle « manifest is partial ») :
[post-mortem](../../docs/audits/2026-11-04-post-mortem-vidage-pieces.md).

`auction_documents` reprend désormais document par document le texte déjà
persisté dans `auction_extractions` (statut `verified`) quand le cache local
du runner est absent, au lieu de repasser ces pièces en `unknown`.

### Copier la photo principale des ventes

Étape séparée de la collecte (jamais dans `_finalize_sale_for_app`, aucune écriture dans
`auction_sales`). Tant que `PHOTO_MIRROR_ENABLED` ne vaut pas `true`, aucune photo n'est
téléchargée ni copiée, mais les retraits s'appliquent quand même (un retrait n'attend pas la
réactivation) :

```bash
PHOTO_MIRROR_ENABLED=true python -m src.photo_mirror --max-photos 400 --budget-minutes 15
```

- ventes du catalogue public dont `catalogue_thumbnail_url` n'a pas de ligne `sale_photos` (ou dont
  la ligne est `failed`, moins de 3 essais, dernier essai de plus de 12 h), la plus proche date
  d'abord ; plafonds `PHOTO_MIRROR_MAX_PHOTOS` (400) et `PHOTO_MIRROR_BUDGET_MINUTES` (15, jusqu'à 150) ;
  l'option `--automatic` (étape planifiée de `data-pipeline.yml`) ramène le budget à 20 minutes au
  plus, sous le `timeout-minutes` de 25 de l'étape ;
- les ventes Enchères Publiques sont exclues tant que l'accès n'est pas autorisé (source de la vente
  comme hôte de la photo) ;
- même garde anti-SSRF, même robots.txt, même délai par hôte (2 s au moins) et même User-Agent que
  les pièces jointes ; 15 s par requête, 2 reprises sur erreur réseau, 5xx ou 429 seulement ; lecture
  coupée à 8 Mo ; type contrôlé sur les premiers octets (jpeg, png, webp) ;
- deux WebP sans EXIF (640 px et 1600 px, jamais agrandis) dans le bucket `sale-photos` ;
- au début de chaque passage, les copies d'une source retirée passent en `withdrawn` et leurs
  fichiers sont supprimés ;
- interrupteur allumé, chaque passage supprime aussi (300 lignes au plus) les copies `stored` dont
  l'URL n'est plus la `catalogue_thumbnail_url` de leur vente ; un fichier encore utilisé par une
  autre copie de la vente est conservé ;
- un chemin encore dans `sale_retention_storage_queue` n'est pas réutilisé : la photo est reportée
  au passage suivant ;
- JPEG multi-images (`MPO`) acceptés ; profil ICC converti en sRGB puis supprimé ;
- un JSON par photo, puis un résumé final ; le workflow manuel « Photo Mirror Backfill »
  (`.github/workflows/photo-mirror-backfill.yml`) rattrape le stock (60 min et 3 000 photos par défaut). Retrait : `docs/runbooks/retrait-photos.md`.

### Ajouter à la galerie les photos des pièces jointes

Le cahier des charges ou le procès-verbal descriptif contient souvent bien plus de photos du bien que la
page de l'annonce. Le lanceur automatique exécute après chaque `enrichment-queue` réussi un passage borné
(3 ventes, 180 s, délai de 6 min ; son code de sortie est noté dans le résumé et ne change jamais le statut
du run) ; à la main :

```bash
python -m src.pdf_photos --max-sales 4 --budget-seconds 300
```

- interrupteur `PDF_PHOTOS_ENABLED`, allumé par défaut (`false`, `0`, `no` ou `off` l'éteignent : seuls les
  retraits s'appliquent alors) ;
- ventes du catalogue public ayant une pièce jointe `pv_huissier`, `cahier_conditions_vente`,
  `proces_verbal` ou `conditions_vente` (jamais les diagnostics) pas encore lue
  (`sale_document_photo_scans` ; échecs retentés 3 fois au plus, à 12 h d'écart) et moins de 12 photos de
  documents ; la plus proche date d'abord, une vente sans date compte comme se terminant dans une semaine ;
  Enchères Publiques exclue tant que l'accès n'est pas autorisé ;
- téléchargement de `photo_mirror` (anti-SSRF, robots.txt, 2 s par hôte), PDF de 40 Mo au plus ;
- le PDF n'est ouvert que par `src/pdf_photo_extract.py`, dans un sous-processus sans secret : images
  dédoublonnées par `xref` et par empreinte, règle « photo du bien » (taille, part de blanc, contraste,
  nombre de couleurs : cartes, logos, schémas et pages scannées écartés), WebP 640 px et 1600 px ;
- 12 photos par vente au plus, dans le bucket `sale-photos` sous `documents/{sale_id}/`, lignes dans
  `public.sale_document_photos` ; la galerie (`media` des vues de la fiche) les ajoute après les photos
  des sources ;
- retraits : photos d'une source retirée et photos passées à la main en `withdrawn` supprimées au début de
  chaque passage, fichiers mis en file de purge (`sale_retention_storage_queue`).

### Invalider le cache public après un retrait

Un déclencheur de `public.auction_sales` note dans `app_private.catalogue_invalidations` chaque vente qui
quitte le catalogue public (statut, quarantaine, date, ou ligne visible supprimée). L'étape
« Invalidate public cache » de `data-pipeline.yml` (après « Finalize unfinished run », `if: always()`)
envoie ces identifiants au site :

```bash
SUPABASE_DB_URL=… SITE_URL=https://immojudis.com CRON_SECRET=… python -m src.cache_invalidation --flush
```

- au plus 100 identifiants par appel (`for update skip locked`), `POST {SITE_URL}/api/pipeline/revalidate-sale`
  avec `Authorization: Bearer $CRON_SECRET`, 10 s au plus, aucune redirection suivie ;
- les lignes ne sont supprimées que sur une réponse 2xx ; au premier échec le passage s'arrête et le
  suivant reprend ; 20 lots au plus (2 000 lignes) par passage ;
- ne lève jamais et sort toujours avec 0 : un compteur JSON par passage, et une annotation
  `::warning::` du workflow si rien n'a pu être envoyé ;
- `CRON_SECRET` (secret de dépôt) et `SITE_URL` (variable de dépôt) ne sont vus que par cette étape.
  Suivi et retour arrière : `docs/runbooks/catalogue-visibility-projection.md`.

## Enrichissement LLM Replicate

Le module `src/enrichment/` utilise Replicate pour extraire les faits des annonces
et de leurs pièces. La synthèse rédigée par le modèle (`llm_display_description`)
a été retirée : la fiche affiche une description construite à partir des faits
vérifiés. Les textes déjà en base restent lus, aucun n'est plus produit. Le modèle par défaut est
`qwen/qwen3-7-plus`. Il a réussi les six cas synthétiques du comparatif du
21 septembre 2026 avec un coût estimé inférieur à celui de l'ancien Qwen2.
Les plafonds du pipeline réservent le coût maximal avant chaque appel autonome.
Pour revenir à l'ancien modèle, définir explicitement `REPLICATE_MODEL` à sa
version épinglée.

Configuration :

```bash
LLM_ENABLED=true
LLM_PROVIDER=replicate
REPLICATE_API_TOKEN=your-replicate-token
REPLICATE_MODEL=qwen/qwen3-7-plus
REPLICATE_TEMPERATURE=0.1
REPLICATE_MAX_TOKENS=512
REPLICATE_TIMEOUT_SECONDS=180
REPLICATE_WAIT_SECONDS=60
REPLICATE_CANCEL_AFTER=5m
REPLICATE_MAX_RETRIES=4
REPLICATE_MAX_TOKENS=512
REPLICATE_FACT_MAX_TOKENS=4096
REPLICATE_RETRY_BACKOFF_SECONDS=30
REPLICATE_RETRY_MAX_SLEEP_SECONDS=60
REPLICATE_MIN_INTERVAL_SECONDS=11
# Contrôles utilisés uniquement si REPLICATE_MODEL désigne un modèle Gemini
REPLICATE_THINKING_BUDGET=0
REPLICATE_DYNAMIC_THINKING=false
REPLICATE_THINKING_LEVEL=low
LLM_PROMPT_VERSION=auction_llm_v10_structured_display
LLM_FACT_PROMPT_VERSION=auction_facts_v1
LLM_FACT_CHUNK_CHARS=12000
LLM_FACT_MAX_CHUNKS=0
INCREMENTAL_ENRICHMENT=true
PDF_DOCLING_FAST_TIMEOUT_SECONDS=60
PDF_MAX_DOCUMENTS_PER_SALE=6
PIPELINE_PDF_MAX_TARGETS=10
PIPELINE_LLM_MAX_TARGETS=0
```

Le worker manuel utilise `python -m src.queued_runner --enrichment-only`.

Le provider Replicate appelle l'API HTTP officielle avec `Authorization: Bearer $REPLICATE_API_TOKEN` et l'endpoint `/v1/models/{owner}/{model}/predictions`.
Pour Gemini via Replicate, le client envoie le prompt système dans `system_instruction` et limite la réponse à du JSON validé ensuite par Pydantic.
Les erreurs temporaires Replicate, dont `429 Too Many Requests`, sont retentées avec backoff exponentiel et un délai minimal entre appels pour éviter les rafales en fin de run.
Les textes PDF et les extractions LLM sont mis en cache par empreinte de document/contexte. Le run suivant réutilise les résultats inchangés, limite les documents transmis aux plus utiles et applique un timeout Docling plus court sur les PDF signés ou très lourds avant fallback.

L'extraction des faits analyse les blocs et pages en segments traçables.
`PIPELINE_LLM_MAX_TARGETS=0` désactive le plafond de sélection d'une collecte ;
`--no-llm` désactive l'étape.

Le budget `LLM_FACT_MAX_CHUNKS` limite désormais les **nouveaux blocs** analysés
par passage. Les blocs déjà analysés sont réutilisés et les suivants sont repris
au passage suivant, sans consommer les tentatives d'échec de la file. Les faits
ne sont appliqués qu'après une couverture complète. Une information absente dans un
document analysé reste inconnue ; elle ne justifie pas une nouvelle analyse du
même contenu.

Les résultats validés sont conservés dans `llm_analysis_cache` sur Supabase,
par empreinte de contenu et par étape, en complément du cache local. Une panne
du cache distant reporte le travail au lieu de provoquer de nouveaux appels IA.
Les réservations de budget sont atomiques et les appels sont rattachés à leur
annonce, étape et motif. Une réponse réseau ambiguë ne déclenche pas une nouvelle
prédiction immédiatement. L'extraction structurée dispose d'un plafond de
4096 tokens afin de pouvoir terminer son JSON.

Chaque pièce ou lot est extrait séparément avec valeur, catégorie, document,
page et citation. Le LLM ne réalise pas l'addition : le module déterministe
`surface_reasoning_v1` vérifie que chaque valeur figure dans sa preuve, exclut
les garages, caves, balcons, terrasses et terrains de la surface habitable,
additionne les pièces avec une arithmétique décimale, puis rapproche le résultat
des surfaces Carrez, habitables ou totales explicitement annoncées. Une somme
incomplète reste marquée `partial` et les contradictions sont conservées au
lieu d'être masquées.

Le résultat détaillé est stocké dans `raw_payload.surface_analysis`, puis dans
`auction_surface_measurements` et `auction_surface_derivations`. Les réponses LLM
doivent être du JSON validé par Pydantic, puis sont sauvegardées dans
`data/processed/llm_extractions/{sale_id}.json`.

La file `auction_enrichment_jobs` est consommée uniquement sur lancement manuel.
Une tâche `display_description` restée en file se termine sans appel au modèle.

Les migrations `20260819105011_add_structured_surface_reasoning_queue.sql` et
`20260820144541_use_qwen2_7b_scan_descriptions.sql` doivent être appliquées
avant de déployer le worker. Les trois nouvelles tables activent
RLS explicitement : seules les lectures abonnées passent par
`has_analysis_access()`, tandis que la file et sa fonction de claim restent
réservées au `service_role`.

Un cache évite de rappeler Replicate quand le triplet `modèle + versions de prompts + contexte factuel complet` n'a pas changé. Cela limite le coût, accélère les relances et stabilise les extractions.

Dans le mode factuel optionnel, la passe couvre toutes les pages extraites. `LLM_FACT_CHUNK_CHARS`
limite la taille d'un segment, tandis que `LLM_FACT_MAX_CHUNKS=0` signifie
qu'aucune page n'est volontairement écartée. Les métriques `llm_fact_context_coverage` et
`llm_fact_coverage` signalent explicitement toute troncature ou tout segment en
échec. L'empreinte des faits d'une vente (`llm_fact_input_key`) est calculée sur un découpage fixe de
10 000 caractères (`FACT_FINGERPRINT_CHUNK_CHARS`), quelle que soit `LLM_FACT_CHUNK_CHARS` : changer la
taille des segments ne rend pas périmées les ventes déjà extraites (seuls les segments en cache changent de
clé). `REPLICATE_FACT_MAX_TOKENS` plafonne la sortie d'un segment ; il doit monter (8192) avec des segments
plus longs. Avant de changer la taille en production, le workflow « Fact chunk trial »
(`scripts/fact_chunk_trial.py`, lecture seule) compare une autre taille aux faits stockés.

Règle de sûreté : le LLM ne remplace pas une valeur déterministe déjà fiable. Il complète surtout les champs absents : `surface_m2`, `rooms_count`, `bedrooms_count`, `occupancy_status`, certains risques, `summary` et `raw_payload.llm_extraction`.

## Source Licitor

> **Décodage des adresses email masquées par Cloudflare (usage interne).** Dans le code,
> `LICITOR_DECODE_PROTECTED_EMAILS` est **désactivé par défaut** ; pour l'activer, mettre `true` (toute autre valeur
> le laisse désactivé, une valeur non reconnue est signalée par un avertissement). Désactivé, les éléments masqués
> sont toujours retirés de la page (jamais publiés) mais aucune adresse n'est décodée ni écrite au registre de
> l'agent. En production, depuis la décision du propriétaire du 11/11/2026 (accord de Licitor déclaré par le
> propriétaire ; pièce à verser au dossier), le workflow de collecte l'active quand la variable de dépôt GitHub
> `LICITOR_DECODE_PROTECTED_EMAILS` est absente ; posée à `false`, elle le coupe sans commit. Procédure complète :
> `docs/runbooks/information-agent.md`.

> **Licitor est collecté et affiché normalement.** Une seule source est retirée du catalogue à ce jour :
> Petites Affiches (30/10/2026, migration `20261110093117_withdraw_petites_affiches_source.sql`). Le dépôt
> garde l'**interrupteur de retrait** pour d'autres usages (par exemple si une source devait être retirée pour
> un motif juridique).
>
> **Un seul interrupteur**, en base : `auction_source_state.catalogue_withdrawn`, posé et levé par la fonction
> `public.set_catalogue_source_withdrawal` (service_role, une transaction, rien n'est supprimé).
> Migration : `supabase/migrations/20261021110000_licitor_source_withdrawal.sql` (livrée sans aucune source
> retirée : l'appliquer ne change rien au catalogue ni à la collecte).
>
> ```sql
> -- état actuel
> select source_name, catalogue_withdrawn, enabled, withdrawn_reason, withdrawn_at
>   from public.auction_source_state where source_name = 'licitor';
> -- retirer une source : coupe la collecte ET masque les ventes dont c'est la seule source
> select public.set_catalogue_source_withdrawal('licitor', true, 'raison');
> -- lever le retrait : remet le catalogue ET la collecte
> select public.set_catalogue_source_withdrawal('licitor', false);
> ```
>
> Effets d'un retrait (quand il est posé) : le planificateur ne lance plus la source (`enabled = false`, imposé
> par une contrainte : l'écran d'administration ne peut pas la réactiver) ; la file d'enrichissement ne rouvre
> plus ses fiches détail ; l'observateur ferme l'alerte `pipeline.source.licitor.missed` au lieu de la rouvrir ;
> `python -m src.main --source licitor` sort proprement (code 0, sans créer de run) ; `--source all` l'ignore ;
> le tick de l'historique des adjudications (`licitor_history_refresh`) est sauté et le dit dans le résumé du
> run (`licitor_history_skipped`) ; la file d'enrichissement diffère (24 h, sans consommer d'essai) les ventes
> dont toutes les sources sont retirées ; les pièces hébergées par `licitor.com` d'une vente fusionnée ne sont
> pas téléchargées. Module : [source_withdrawal.py](src/source_withdrawal.py).
>
> **Par défaut, aucune source n'est retirée** : si la base est injoignable, si la colonne n'existe pas encore
> (migration non appliquée) ou si `SUPABASE_DB_URL` est absent, `DEFAULT_WITHDRAWN` (vide) s'applique, donc
> Licitor est collecté. Contrepartie : tant que l'interrupteur est illisible (panne, `SUPABASE_DB_URL` absent
> d'un lancement local ou de l'audit manuel `source_coverage_audit`), un retrait posé n'est pas vu.
> `ENABLE_LICITOR_BENCHMARK` et `LICITOR_HISTORICAL_AUTHORIZED` restent des réglages secondaires : ils ne
> lèvent jamais un retrait.

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
AUCTION_USER_AGENT=ImmojudisBot/1.0 (+https://immojudis.com/contact)
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

## Règle « minimum d'une annonce »

Une annonce n'est écrite dans `auction_sales` que si elle a **une voie ou un lieu-dit** dans son adresse, **ou une adresse
email de contact** (avocat, cabinet, notaire ou étude : l'agent d'information ne travaille que par email, un nom ou un
téléphone seul ne compte pas), **ou, pour une vente au tribunal sans email de contact, l'email de son tribunal** (voir
ci-dessous), **ou une ou plusieurs parcelles cadastrales lisibles**, **ou au moins une pièce**, **ou un rattachement à une autre source**. La règle est écrite
une seule fois, dans `src/listing_minimum.py` (`src/information_sufficiency.py` n'en est que l'accès : interrupteur
d'urgence, registre de refus de l'agent). Elle s'applique à l'écriture, après la lecture de la fiche de détail, dans
`publication_identity.resolve_publication_identities` : c'est là qu'on sait si l'annonce se rattache à une ligne
existante. Une annonce déjà en base n'est jamais refusée ni supprimée par cette règle (un email retiré de la fiche ne la
fait pas disparaître).

**Contact de secours : l'email du tribunal (preuve `court_email`).** Pour une vente au tribunal (saisie immobilière ou autre
vente judiciaire, confirmée par l'annonce : `sale_venue_type = tribunal` et `sale_verification_status` `verified` ou
`cross_checked`, sans `tribunal_inconsistent` ; jamais notaires, cessions de l'État ni AGRASC) qui n'a aucun email de
contact exploitable, l'email de SON tribunal dans `court_registry_contacts` (fichier du propriétaire du 01/11/2026,
`docs/reference/tribunaux-judiciaires-emails-2026-11-01.md`) fait preuve : l'annonce n'est plus écartée faute d'email.
Le référentiel est chargé une fois par passage (`information_sufficiency.load_court_registry`, comme le registre de refus ;
sans lui, ou en cas d'erreur, la règle d'avant s'applique). Une vente sans tribunal reconnu, ou dont le tribunal n'a pas
d'email, ne change pas ; une adresse `@justice.fr` lue dans une annonce reste exclue (seule celle du référentiel sert de
secours) ; une adresse du référentiel refusée par le registre (opposition, rebond permanent) ne compte pas. La règle SQL
(`app_private.sale_has_listing_minimum`, migration `20261110190100`) garde aussi ces ventes. Le résumé du passage compte
les annonces écrites grâce à ce seul secours (`court_email_fallback`). L'agent d'information peut alors écrire au greffe,
dans ce seul cas (`docs/runbooks/information-agent.md`, « Greffe de secours »).

Le run compte les refus dans son résumé (`rejected_insufficient_listing` : total, par source, quelques URL d'exemple,
`detail_unread_not_written` pour les fiches non lues, et `court_email_fallback` pour les annonces écrites grâce à l'email
de leur tribunal). L'annonce refusée reste comptée dans l'inventaire de sa
source (décision `excluded` dans `auction_collection_items`) : la santé de la source, le ratio de fraîcheur et l'alerte
de baisse d'inventaire ne bougent pas. **Cache de refus** (`src/rejected_listings.py`, table `app_private.rejected_listings`, migration `20261108202200`) : une
annonce refusée après lecture de sa fiche est mémorisée ; absente de la base, refusée depuis moins de 7 jours et dont la
vignette (date, prix, statut) n'a pas changé, sa fiche n'est pas relue (`skipped_recently_rejected` dans le résumé). Elle
reste découverte et garde la décision `excluded` : inventaire et santé de la source inchangés. Après 7 jours elle est
relue. Conservation 30 jours (purge au chargement du cache). Actif pour un passage autonome, ou avec
`IMMOJUDIS_REJECTED_LISTING_CACHE=on` ; `off` le coupe. Sans table ni base, les fiches sont relues comme avant.

- `IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE=off` coupe la règle (défaut : active).
- Le miroir Python du résolveur de contacts (`src/information_sufficiency.py`) est gardé identique au résolveur
  TypeScript par `tests/fixtures/information_agent_contact_cases.json`, exécuté par pytest et par vitest. Il en va de même
  du contact de secours du tribunal (`is_court_sale`, `court_registry_fallback_emails`) avec
  `tests/fixtures/court_registry_fallback_cases.json`.
- Existant : `supabase/repairs/20261108202100_delete_empty_listings.sql` (comptage par défaut, jamais une vente qui a une
  trace utilisateur, un prix d'adjudication ou une issue connue) après la migration `20261108202000_…`. **À lancer APRÈS le
  balayage de dédoublonnage** (`python -m src.dedupe_candidates`, rapport relu, puis `python -m src.dedupe_apply`) : une
  annonce Vench ou Petites Affiches dont la vente jumelle est en base se rattache à elle au lieu d'être supprimée. `python -m src.recompute_scoring --drop-insufficient` rend le même constat en Python (rapport sans suppression) ;
  `--execute-drop` n'a pas de suppression propre : il appelle `app_private.delete_empty_listings` (comptage, puis application, plafond
  `--max-deletions`) sur tout le catalogue (`--source` et `--limit` refusés), sans liste de protection figée.

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

## Données personnelles dans les textes

Les annonces nomment parfois un occupant, un locataire, un propriétaire ou un créancier particulier. Un compte
connecté lit `description`, `raw_payload` (`source_description`, `source_blocks`, `llm_display_description`…),
`observations` et `risks` directement dans la base : le texte stocké doit donc être propre.

- `src/personal_data.py` remplace le nom d'une personne physique par un rôle (« occupés par un locataire »,
  « À la requête du créancier poursuivant »), retire la date et le lieu de naissance et l'adresse « demeurant… »,
  sans toucher aux communes, rues, tribunaux, études ni sociétés. Son miroir TypeScript est
  `src/lib/personal-data-filter.ts` ; les deux sont gardés identiques par
  `tests/fixtures/personal_data_filter_cases.json`, exécuté par pytest et par vitest.
- La collecte l'applique à l'écriture (`redact_storage_row` dans `supabase_client.py` et `sale_row_builders.py`,
  extraits des risques compris) : le texte en mémoire, les empreintes et l'extraction restent ceux de la source.
  Les prompts (`prompts.py`) interdisent en plus au modèle de reproduire ces données.
- Réparer les lignes écrites avant (ventes à venir) : `python -m src.redact_personal_data` compte seulement (lecture
  seule, ni texte ni nom dans la sortie) ; `--check` sort en code 1 s'il reste des lignes ; `--apply` écrit sous le
  verrou d'écriture du catalogue. Le workflow « Recompute Existing Sales » les rattraperait aussi, mais refait
  toute la normalisation.

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
