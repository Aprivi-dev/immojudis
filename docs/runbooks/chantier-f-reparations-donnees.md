# Chantier F : réparer les données déjà collectées

Ce document accompagne les corrections du chantier F (exactitude des données collectées, points 11
à 18 du compte-rendu `docs/equipe/2026-10-13-premiere-session.md`). Le code corrige les nouvelles
collectes. Les lignes déjà en base se réparent par trois **réparations de données** (SQL lancé à
la main avec `psql`), par le recalcul existant (`recompute-existing-sales`) et, pour les doublons,
par le balayage existant de la collecte.

Les trois réparations ne sont **pas** des migrations de schéma : elles vivent dans
`supabase/repairs/` (voir son `README.md`), pas dans `supabase/migrations/`. Le workflow « Apply
Supabase Migrations » applique tout ce qui est en attente dans `supabase/migrations/` sans essai ;
une réparation placée là partirait en production avec la prochaine migration de schéma. Rien ici ne
s'exécute tout seul : les réparations se lancent avec `psql`, le recalcul est un `workflow_dispatch`.

Chaque réparation a un **mode comptage par défaut** (aucune écriture, transaction annulée) et un
mode application (`-v apply=1`). Elles ont été testées avec `psql` sur une base PostgreSQL jetable
(`services/data-pipeline/tests/test_chantier_f_repairs_sql.py`) mais jamais exécutées sur la base de
production. Les rejouer d'abord sur une copie.

## Ordre conseillé

1. Fusionner le code du chantier F. Aucune migration de schéma n'est nécessaire pour ce chantier.
2. Pour chaque réparation, dans l'ordre `20261020130001`, `20261020130002`, `20261020130003` :
   lancer d'abord le **comptage**, relire les chiffres, puis **appliquer** (voir ci-dessous).
3. Lancer le recalcul en `dry_run=true`, relire le résumé, puis en `dry_run=false`.
4. Laisser tourner la collecte normale (doublons) ou la lancer.
5. Vérifier avec les requêtes ci-dessous.

Les réparations passent avant le recalcul : celle du point 15 retire le point fantôme que le recalcul
géocode ensuite, et celle du point 11 recopie les géocodages déjà acceptés sans appel réseau.

## Commandes des réparations

Depuis la racine du dépôt, avec `SUPABASE_DB_URL` pointant sur la base voulue (copie d'abord) et un
client `psql` 13 ou plus :

```bash
f=supabase/repairs/20261020130001_repair_sale_department_and_coordinates.sql   # puis ...0002_..., ...0003_...

# Comptage seulement (défaut) : affiche ce qui serait modifié, n'écrit rien.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"

# Application : une seule transaction, avec copie des valeurs d'origine dans app_private.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f "$f"
```

Les noms complets, les requêtes de contrôle et les tables de sauvegarde pour le retour arrière sont
dans `supabase/repairs/README.md`.

## Commandes du recalcul

Le recalcul relit chaque vente stockée (`raw_payload` et colonnes), la renormalise avec le code
corrigé et la réécrit. Il géocode les ventes sans coordonnées (BAN, 4 appels en parallèle).

```bash
# Essai sans écriture, toutes les sources :
gh workflow run recompute-existing-sales.yml --ref main \
  -f confirm_target=production -f source=all -f dry_run=true

# Écriture, par source (une commande par source) :
gh workflow run recompute-existing-sales.yml --ref main \
  -f confirm_target=production -f source=licitor -f dry_run=false
gh workflow run recompute-existing-sales.yml --ref main \
  -f confirm_target=production -f source=info_encheres -f dry_run=false
gh workflow run recompute-existing-sales.yml --ref main \
  -f confirm_target=production -f source=petites_affiches -f dry_run=false
```

`source=all` fait la même chose en une fois ; lancer les sources une par une garde les temps courts
et limite le périmètre d'une éventuelle erreur. Les sources concernées par chaque point sont
indiquées ci-dessous.

## Point par point

### 11. Département et coordonnées

- Code : le département se déduit du code postal, puis du code INSEE d'un géocodage BAN accepté
  (`normalize_sale`, `fill_tribunal`, source écrite dans `raw_payload.department_inference`). Le
  **tribunal n'est jamais une source de département** : il peut couvrir une commune d'un département
  voisin, et une valeur déduite de lui serait écrite comme un fait. Sans code postal ni géocodage
  accepté, le département reste absent. Un géocodage accepté, centre de commune compris, est recopié
  dans `latitude` et `longitude` avec `raw_payload.geo_precision` (`geocode.restore_accepted_geocode`).
  Le drapeau `missing_gps` disparaît quand les coordonnées existent.
- Réparation : `supabase/repairs/20261020130001_repair_sale_department_and_coordinates.sql`.
  Elle fait la même chose en SQL, sans réseau, uniquement sur les valeurs absentes et sur les ventes
  `active`, `upcoming`, `unknown`, avec copie des valeurs d'origine dans
  `app_private.location_repair_backup_20261020`. La recopie des coordonnées est plus stricte que le
  code : elle exige que le département de la vente soit celui du code INSEE du géocodage (et du code
  postal quand il existe), en plus du rectangle connu des départements 24, 33, 40, 47, 64 ; le
  recalcul complète ensuite les cas écartés. Retour arrière à la fin du fichier.
- Recalcul : `source=petites_affiches` (76 % des ventes sans département) puis `all`.
- Avant / après :

```sql
select count(*) filter (where department is null or department = '') as sans_departement,
       count(*) filter (where latitude is null or longitude is null) as sans_coordonnees,
       count(*) filter (where quality_flags ? 'missing_gps' and latitude is not null
                          and longitude is not null) as drapeau_perime
  from public.auction_sales
 where status in ('active', 'upcoming', 'unknown');
-- Constat du 2026-10-13 sur les ventes à venir visibles : 410, 790 et environ 90.
```

### 12. Doublons entre sources

- Code : (1) fusion par identifiant d'annonce commun Vench / Petites Affiches (`vench.fr/vente-166526-…`
  et `…-166526.html`), refusée si le jour d'audience ou la mise à prix se contredisent ; (2) clé de
  repli stricte, dans la collecte uniquement : même tribunal (ou code INSEE), même jour civil à Paris,
  même mise à prix à l'euro, et un signal fort (surface à ±5 % ou même type de bien et même commune),
  jamais entre deux lots d'une même source ni d'une annonce multi-lots, et jamais si une annonce a
  deux partenaires possibles. La persistance (`resolve_publication_identities`) reconnaît aussi
  l'identifiant commun.
- L'identifiant commun seul ne suffit plus (le balayage supprime la ligne secondaire, et deux
  annonces de villes différentes, Ondres 40440 et Lyon 69003, partageaient un numéro). Il faut, en
  plus : le même code postal ou la même commune normalisée, connus des deux côtés (un lieu inconnu
  d'un côté refuse la paire), et au moins un fait corroborant connu des deux côtés (même jour civil
  à Paris ou même mise à prix à l'euro près), sans contradiction sur ces faits. Une paire qui ne
  remplit pas ces conditions reste en deux lignes, à traiter à la main.
- Quand le run fusionne en mémoire deux annonces déjà enregistrées à part, la persistance choisit la
  ligne primaire de façon déterministe (priorité de source, Vench avant Petites Affiches, puis URL)
  au lieu de mettre les trois lignes en quarantaine ; l'autre ligne reste visible jusqu'au balayage.
- Réparation de l'existant : uniquement par identifiant commun. Le balayage
  `reconcile_duplicate_sales_in_supabase` (`DEDUPE_RECONCILE_ENABLED`, coupé par défaut ; il lit
  toutes les pages jusqu'à `DEDUPE_RECONCILE_MAX_ROWS` = 20 000 lignes et supprime au plus
  `DEDUPE_RECONCILE_MAX_MERGES` = 100 lignes par passage), fusionne les deux lignes puis supprime la
  ligne secondaire. Il ne tournait jamais en collecte planifiée (une seule source par passage) : il se
  lance à part, avec le workflow manuel « Dedupe sweep » (`python -m src.dedupe_apply`), après la
  migration `20261028110000` (les favoris, notes, alertes et rapports des lignes supprimées passent à la
  fiche conservée). La clé de repli stricte y est permise hors Vench / Petites Affiches, et un groupe de
  plus de 5 lignes n'est jamais fusionné.
  Relecture avant activation, sans écriture : lancer le workflow « Dedupe candidates report »
  (ou `python -m src.dedupe_candidates`) ; le journal et le résumé du job
  listent chaque paire (conservée / supprimée : id, source, commune, date, prix, raison).
  Le workflow `data-pipeline.yml` le laisse coupé tant que la variable de dépôt GitHub
  `DEDUPE_RECONCILE_ENABLED` (Settings → Secrets and variables → Actions → Variables) ne vaut pas
  `true` : la créer avec `true` après avoir relu la liste ci-dessous.
  Sans toucher à la variable, le workflow manuel « Dedupe sweep » écrit pour UN lancement quand il est
  démarré avec l'entrée `apply` cochée et `confirm_target` égal à `production` (exactement) : le passage
  s'exécute comme si la variable valait `true`, toujours à 100 suppressions au plus. `apply` seul, ou une
  autre valeur de `confirm_target`, arrête le job avant toute lecture. Sans ces entrées, rien ne change.
  Lecture du balayage (rapport et écriture, même chemin) : pages de 100 lignes
  (`DEDUPE_RECONCILE_PAGE_SIZE`, 10 à 1 000), curseur sur `id`. Un délai SQL dépassé (57014, 408, 504, délai
  réseau) divise la page par deux et relit la même page, jusqu'à 10 lignes ; au-delà le balayage est partiel
  (`fetch_error`). Les lignes sont lues avec toutes leurs colonnes : la fusion réécrit la ligne entière.
- Avant (lecture seule) : les paires de même identifiant. Ce sont des candidates : seules celles dont
  le lieu et un fait (jour ou mise à prix) concordent seront fusionnées ; vérifier à la main les
  autres, qui resteront en deux lignes.

```sql
with annonces as (
  select id, source_name, source_url, status,
         case source_name
           when 'vench' then substring(source_url from '/vente-([0-9]+)-')
           when 'petites_affiches' then substring(source_url from '-([0-9]+)\.html')
         end as listing_id
    from public.auction_sales
   where source_name in ('vench', 'petites_affiches')
)
select listing_id, array_agg(source_name || ' ' || id::text order by source_name) as lignes
  from annonces
 where listing_id is not null
 group by listing_id
having count(distinct source_name) = 2
 order by listing_id;
-- Attendu avant : au moins 166526, 166431, 166115, 163035. Après la collecte : aucune ligne.
```

### 13. Licitor : département par sous-chaîne

- Code : URL de l'annonce (`…/isere/109863.html`), puis code postal, puis département de l'en-tête
  (`(Isère)`), puis nom entier dans le texte, et seulement s'il est seul. « Orglandes » ne donne plus
  les Landes, « Tribunal de Vienne (Isère) » ne donne plus la Vienne.
- Réparation : le recalcul `source=licitor` relit l'URL et le texte stockés (`refresh_licitor_raw_sale`)
  et remplace le département. Ventes à contrôler : `a523e55d`, `91d90d56`, `27008c6f`, `c1c62d33`.
- Après :

```sql
select left(id::text, 8) as id, city, postal_code, department, source_url
  from public.auction_sales
 where source_name = 'licitor' and left(id::text, 8) in ('a523e55d', '91d90d56', '27008c6f', 'c1c62d33');
```

### 14. Surfaces

- Code : une valeur « hors Carrez » n'est jamais une Carrez ; une Carrez sous 20 % de la surface
  habitable est écartée (la valeur écartée reste dans `raw_payload.carrez_surface_reconciliation`) ;
  moins de 9 m² n'est pas la surface d'un appartement ou d'une maison.
- Réparation : recalcul `source=all`. Ventes à contrôler : `6d4e4095` (63,83 m² attendus),
  `b1220a90`, `db26a41e`, `0e09aa58`.

### 15. Point fantôme Info-Enchères

- Réparation : `supabase/repairs/20261020130002_clear_info_encheres_phantom_point.sql`. Elle met à
  NULL les coordonnées au point (44.40655, 6.061187), retire ce point du `raw_payload` et supprime les
  parcelles trouvées sous ce point (copies dans `app_private`). Retour arrière à la fin du fichier.
- Recalcul : `source=info_encheres` (nouveau géocodage des ventes sans point).
- Avant / après : la requête de l'en-tête du fichier (5 lignes environ, puis 0).

### 16. Licitor multi-lots

- Cause confirmée dans le code : une annonce n'a qu'une ligne, avec une adresse, une mise à prix et un
  point, ceux du premier lot (`parse_licitor_detail_html`). La lecture lot par lot
  (`licitor_extraction.extract_licitor_fields`) est correcte, mais ses résultats ne servent qu'aux
  caractéristiques détaillées. Le remède demande un choix de produit (une ligne par lot, ou un
  agrégat) : il n'a pas été deviné.
- Mesure d'attente : `supabase/repairs/20261020130003_quarantine_licitor_multi_lot_annonces.sql`
  met les 9 annonces (109863, 109968, 110081, 110098, 110145, 110156, 110160, 110164, 110177) en
  quarantaine durable. Retour arrière à la fin du fichier.

### 17. Dates invraisemblables

- Code : une date de vente à plus de 12 mois de la publication de l'annonce, ou à plus de 12 mois
  d'aujourd'hui, n'est plus présentée comme certaine : la vente n'a plus de date (le site affiche
  « Date à confirmer » et ne la compte plus parmi les ventes à venir), la valeur lue est gardée dans
  `raw_payload.sale_date_unverified`, drapeau `sale_date_implausible`.
- Réparation : recalcul `source=all`. Concerne 11 ventes visibles (jusqu'en 2044) ; `774a1109` perd
  sa date future.
- Avant (les ventes que la règle va toucher, d'après la seule limite « aujourd'hui + 12 mois » ; la
  limite « publication + 12 mois » ne se lit que dans le recalcul) :

```sql
select left(id::text, 8) as id, source_name, status, sale_date
  from public.auction_sales
 where sale_date > now() + interval '12 months'
 order by sale_date desc;
```

- Après :

```sql
select count(*) from public.auction_sales
 where raw_payload ? 'sale_date_unverified';
```

### 18. Libellés pollués

- Code : un tribunal pollué (« TJ Tribunal Judiciaire de NANCY le », « TJ Béziers Suite À Des
  Poursuites… ») est rattaché au référentiel national des tribunaux ; le texte brut reste dans la
  preuve (`tribunal_label_assignment.raw_source_label`). Un libellé pollué qui ne se rattache à rien
  est absent (`raw_payload.tribunal_label_rejected`). Une ville comme « USAGE D'HABITATION à Chanteheux »
  est coupée avant « à » quand le préfixe est un descriptif de bien ; un descriptif seul n'est pas une ville.
- Réparation : recalcul `source=all`. Le référentiel des tribunaux doit être disponible (le workflow
  le synchronise avant le recalcul).

## Session du 2026-10-15 (données, branche `equipe/2026-10-15-p1-donnees`)

Rien de ce qui suit n'est appliqué : le code est livré, la production n'est pas touchée.

### 23. Doublons : activer le balayage après relecture

1. Lancer le workflow « Dedupe candidates report » (lecture seule) et relire la liste des paires.
2. Si elle convient, soit lancer « Dedupe sweep » avec `apply` coché et `confirm_target` = `production`
   (écriture pour ce lancement seulement, sans variable), soit créer la variable de dépôt
   `DEDUPE_RECONCILE_ENABLED=true` (au plus
   `DEDUPE_RECONCILE_MAX_MERGES` = 100 lignes supprimées par collecte complète : il en faudra
   plusieurs pour les ~439 paires Vench / Petites Affiches).

### 24. Licitor multi-lots

Quarantaine automatique (`publication_quarantine = licitor_multi_lot_first_lot_values`) à la
prochaine collecte ou au recalcul `source=licitor`. Elle se lève d'elle-même si la source ne montre
plus qu'un lot. Le fichier `20261020130003_…` reste utile pour les 9 annonces déjà identifiées.

### 25. Surfaces aberrantes

Recalcul `source=all` : les surfaces d'appartement au-dessus de 500 m² et de maison au-dessus de
1 000 m² quittent la surface affichée (trace : `raw_payload.implausible_surface_reconciliation`) ; un
immeuble de plusieurs logements ou une annonce multi-lots sans surface totale explicite n'affiche
plus la surface d'un lot.

### 26. Tribunaux

1. `supabase/repairs/20261025100001_repair_doubled_tribunal_names.sql` (comptage, puis `-v apply=1`)
   pour les noms canoniques au préfixe double ;
2. recalcul `source=all` pour rattacher les libellés (« (Département) », « St Gaudens », « Briey »,
   « Les Sables D Olonne ») et vider le tribunal des ventes notariales Vench (« En l'étude du Notaire »).

### 28. Heure Petites Affiches

Le marqueur `date_precision = "day"` est posé par la normalisation depuis le 2026-10-10 ; les lignes
plus anciennes sont lues comme « date seule » d'après `raw_payload.sale_date`. Recalcul
`source=petites_affiches` pour poser le marqueur partout.
