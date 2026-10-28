# Import annuel de la carte des loyers ANIL (chaque décembre)

La carte des loyers de l'ANIL est republiée chaque année en décembre, sous **un nouvel identifiant de jeu**
sur data.gouv.fr. Tant que `ANIL_DATASET_ID` n'est pas changé, l'import relit l'ancien millésime sans
erreur. Le contrôle `rents --check-new-vintage` (workflow **Reference data import**, tous les 1er novembre,
décembre et janvier, ou à la demande avec `check_new_vintage`) le signale par un `::warning::` et un échec.
Contexte et gardes : `docs/operations/donnees-de-reference-loyers-et-zonage.md`.

## 1. Constater

Le warning donne le millésime, le titre et l'identifiant du nouveau jeu. Vérifier sur data.gouv.fr que les
quatre fichiers (`pred-app-mef-dhup.csv`, `pred-app12-mef-dhup.csv`, `pred-app3-mef-dhup.csv`,
`pred-mai-mef-dhup.csv`) sont présents et que la mention de crédit n'a pas changé.

## 2. Pull request

- `ANIL_DATASET_ID` dans `services/data-pipeline/src/reference_data/rents.py` (et le texte du module).
- `ANIL_CURRENT_EDITION` dans `src/lib/rent-source-notice.ts` (millésime et date de mise à jour du fichier).
- Les deux tests qui figent l'édition : `services/data-pipeline/tests/test_reference_data.py`
  (`test_the_real_web_edition_matches_the_edition_the_dataset_publishes`) et
  `src/lib/rent-reference.test.ts`. Oublier la constante ne casse aucun test : seul l'import l'attrape.
- Les seuils (`MIN_RENT_COMMUNES`, 34 800) si le nombre de communes a changé de façon durable (fusions au
  1er janvier).

## 3. Essai à blanc

Lancer le workflow avec `dataset=rents` et `dry_run=true`. Lire le résumé : `vintage`, quatre segments à
environ 34 900 lignes, `arrondissements=45`, `updated_on`. Un `web_edition_gap` fait échouer l'étape : la
constante n'est pas à jour.

## 4. Import

Lancer avec `dataset=rents` et `dry_run=false` (écrit en production). L'écriture tient dans une seule
transaction : upsert des quatre segments, purge des communes disparues, contrôle d'un seul millésime. En
cas d'échec, rien n'est modifié et l'ancienne édition reste servie. Le fichier est refusé s'il compte moins
de 99 % des lignes actuelles de la table.

## 5. Contrôler

```sql
select vintage, count(*), max(imported_at) from public.anil_rents group by 1;
```

Attendu : un seul millésime, environ 139 600 lignes. Le cache de lecture de l'application dure 6 heures
(`rent-reference.server.ts`) : les nouveaux loyers apparaissent au plus tard après ce délai.

## 6. Alertes

Poser `ALERT_RENT_BASIS_SWITCH_AT` (date ISO du déploiement, voir `.env.example`) avant le passage de
06 h 15 UTC qui suit, puis la retirer après 48 heures.

## Retour arrière

Relancer l'import du millésime précédent (rétablir l'identifiant et la constante) ou restaurer une
sauvegarde Supabase. Les imports sont idempotents.
