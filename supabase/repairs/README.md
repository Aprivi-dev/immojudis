# Réparations de données (hors migrations de schéma)

Ces fichiers corrigent des **données** déjà en base (chantier F, exactitude des données collectées).
Ils ne sont **pas** des migrations : `.github/workflows/apply-supabase-migrations.yml` applique tout ce
qui est en attente dans `supabase/migrations/`, sans essai préalable. Une réparation qui y serait
placée partirait en production avec la prochaine migration de schéma. Ils vivent donc ici, et rien
ne les exécute automatiquement (ni `npm run db:migrate`, ni la CI, ni le workflow de migrations).

Compte-rendu d'origine : `docs/equipe/2026-10-13-premiere-session.md`. Procédure complète, dont le
recalcul des ventes : `docs/runbooks/chantier-f-reparations-donnees.md`.

## Comment exécuter un fichier

Un client `psql` 13 ou plus est nécessaire (les fichiers utilisent `\if :{?apply}`). Depuis la
racine du dépôt :

```bash
# 1. Comptage seulement (mode par défaut) : aucune écriture, la transaction est annulée.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/repairs/20261020130001_repair_sale_department_and_coordinates.sql

# 2. Application : même fichier, avec -v apply=1 (une seule transaction, tout ou rien).
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 \
  -f supabase/repairs/20261020130001_repair_sale_department_and_coordinates.sql
```

Le mode comptage calcule le même plan que l'application et affiche ce qui serait modifié ; il ne
crée aucune table de sauvegarde. Chaque fichier est idempotent : une seconde application ne trouve
plus rien à réparer. Avant l'application, les valeurs d'origine sont copiées dans une table
`app_private.*_backup_20261020` (ces copies servent au retour arrière ci-dessous).

Essayer d'abord sur une copie de la base (restauration d'une sauvegarde, ou branche Supabase), puis
en production seulement après avoir relu le comptage.

## Ordre

| Ordre | Fichier | Point | Effet |
| --- | --- | --- | --- |
| 1 | `20261020130001_repair_sale_department_and_coordinates.sql` | 11 | Département absent (code postal, puis code INSEE d'un géocodage accepté ; jamais le tribunal) et coordonnées d'un géocodage accepté, ventes à venir seulement. |
| 2 | `20261020130002_clear_info_encheres_phantom_point.sql` | 15 | Retire le point fantôme Info-Enchères (44.40655, 6.061187) et les parcelles trouvées sous ce point. |
| 3 | `20261020130003_quarantine_licitor_multi_lot_annonces.sql` | 16 | Met 9 annonces Licitor multi-lots en quarantaine durable. |
| 4 | `20261025100001_repair_doubled_tribunal_names.sql` | 26 | Corrige les noms canoniques de `public.tribunals` au préfixe double (« TJ Tribunal judiciaire du Mans » -> « TJ Le Mans »), avec le texte tribunal des ventes et les preuves de rattachement qui doivent leur rester égaux. |
| 5 | `20261029100200_recompute_past_quarantined_deadlines.sql` | 6 (W1) | Recalcule `retention_deadline` et `catalogue_expiry_deadline` des ventes `past` et `quarantined` avec les fonctions corrigées par la migration `20261029100200_retention_past_quarantined_sales.sql` (à appliquer d'abord). Comptage par défaut ; les déclencheurs sont suspendus le temps de l'écriture. Sauvegarde : `app_private.retention_deadline_repair_backup_20261029`. |
| 6 | `20261030100001_count_workspace_status_not_in_dossier.sql` | 36 (V2a) | **Comptage seulement, sans mode application** : statuts et plafonds saisis dans l'ancien dossier de travail Analyse qui n'ont pas leur pendant dans « Mon dossier » (`user_favorites`). Aucun rattrapage n'est décidé. |

Les quatre premières sont indépendantes les unes des autres, mais l'ordre 1, 2, 3, 4 est conseillé : le point 15
retire le point fantôme avant que le recalcul ne géocode de nouveau les ventes concernées, et le
point 11 recopie d'abord les géocodages déjà acceptés sans appel réseau. Le recalcul
(`recompute-existing-sales`) vient après les quatre, voir le runbook.

## Requêtes de contrôle (lecture seule)

Point 11, avant et après (périmètre : ventes `active`, `upcoming`, `unknown`) :

```sql
select count(*) filter (where department is null or department = '') as sans_departement,
       count(*) filter (where latitude is null or longitude is null) as sans_coordonnees,
       count(*) filter (where quality_flags ? 'missing_gps' and latitude is not null
                          and longitude is not null) as drapeau_perime
  from public.auction_sales
 where status in ('active', 'upcoming', 'unknown');
-- Constat du 2026-10-13 sur les ventes à venir visibles : 410, 790 et environ 90.
-- Après : sans_departement et sans_coordonnees baissent (le reste n'a ni code postal ni géocodage
-- accepté : il reste absent, c'est voulu) ; drapeau_perime tombe à 0.
```

Point 15, avant (environ 5 lignes) et après (0 ligne) :

```sql
select id, status, latitude, longitude
  from public.auction_sales
 where source_name = 'info_encheres'
   and abs(latitude - 44.40655) < 0.000005 and abs(longitude - 6.061187) < 0.0000005;
```

Point 16, avant (jusqu'à 9 lignes, `en_quarantaine` faux) et après (`en_quarantaine` vrai, statut
`quarantined`) :

```sql
select id, status, city, starting_price_eur,
       quality_flags ? 'property_identity_conflict' as en_quarantaine
  from public.auction_sales
 where source_name = 'licitor'
   and substring(source_url from '/([0-9]+)\.html') in
       ('109863','109968','110081','110098','110145','110156','110160','110164','110177');
```

Point 26, avant (jusqu'à 4 lignes) et après (0 ligne) :

```sql
select code, canonical_name from public.tribunals where canonical_name ~* '^TJ Tribunal judiciaire';
```

## Retour arrière

Chaque fichier se termine par la requête de retour arrière correspondante (en commentaire), à
exécuter à la main avec `psql` à partir de la table de sauvegarde :

| Fichier | Table de sauvegarde |
| --- | --- |
| `…130001_…` | `app_private.location_repair_backup_20261020` |
| `…130002_…` | `app_private.info_encheres_phantom_point_backup_20261020` et `app_private.info_encheres_phantom_parcels_backup_20261020` |
| `…130003_…` | `app_private.licitor_multi_lot_quarantine_backup_20261020` |
| `…20261025100001_…` | `app_private.tribunal_name_repair_backup_20261025` et `app_private.tribunal_name_repair_sales_backup_20261025` |

Les tables de sauvegarde ne sont lisibles ni par `anon` ni par `authenticated`. Les supprimer
(`drop table`) une fois la réparation validée, pas avant.

## Vérification automatique

`services/data-pipeline/tests/test_chantier_f_repairs_sql.py` exécute les quatre fichiers avec `psql`
sur une base jetable (`PIPELINE_TEST_DB_URL`, test ignoré sans base ni client `psql`) : le mode par
défaut ne change rien, `-v apply=1` répare, une seconde application ne change rien.
