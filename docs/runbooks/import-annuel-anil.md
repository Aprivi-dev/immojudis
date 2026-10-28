# Import annuel de la carte des loyers de l'ANIL (checklist de décembre)

La carte des loyers de l'ANIL (table `anil_rents`) est publiée chaque année en décembre (2025 : fichiers du
11/12/2025), sous **un nouvel identifiant de jeu** sur data.gouv.fr. Les rendements affichés, les alertes, les
rapports et les exports la lisent. Ce runbook est la checklist du propriétaire pour la charger. Le contexte
(sources, format, gardes, lecture par l'application) est dans
`docs/operations/donnees-de-reference-loyers-et-zonage.md`.

Public : le propriétaire. L'étape 5 **écrit en production**.

Dernier essai : jamais pour un changement de millésime (les imports de `rents` du 27/10/2026 ont chargé le
millésime 2025). À dater après l'import de décembre 2026.

## 1. Constater la nouvelle édition

Tant que `ANIL_DATASET_ID` n'est pas changé, l'import relit l'ancien millésime sans erreur. Le contrôle
`rents --check-new-vintage` (workflow **Reference data import**, les 1er novembre, décembre et janvier à
07:15 UTC, ou à la demande avec `check_new_vintage`) le signale par un `::warning::` et un échec. Le warning
donne le millésime, le titre et l'identifiant du nouveau jeu.

Vérifier sur data.gouv.fr que les quatre fichiers (`pred-app-mef-dhup.csv`, `pred-app12-mef-dhup.csv`,
`pred-app3-mef-dhup.csv`, `pred-mai-mef-dhup.csv`) sont présents et que la mention de crédit n'a pas changé.

## 2. Pull request : identifiant, constante et tests

À faire et fusionner **avant** l'écriture :

1. `ANIL_DATASET_ID` dans `services/data-pipeline/src/reference_data/rents.py` (et le texte du module).
2. `ANIL_CURRENT_EDITION` dans `src/lib/rent-source-notice.ts` : `{ vintage, sourceUpdatedOn }` du nouveau
   millésime (la date est celle du fichier, `updated_on` dans le résumé).
3. Les deux tests qui figent l'édition :
   - `src/lib/rent-reference.test.ts` (la ligne `expect(ANIL_CURRENT_EDITION).toEqual(...)`) ;
   - `services/data-pipeline/tests/test_reference_data.py`
     (`test_the_real_web_edition_matches_the_edition_the_dataset_publishes`).
4. Les seuils (`MIN_RENT_COMMUNES`, 34 800) si le nombre de communes a changé de façon durable (fusions au
   1er janvier).

Ces tests **ne lisent pas le jeu réel** : ils comparent la constante à une valeur écrite en dur. Oublier la
constante ne casse aucun test ; c'est l'import qui l'attrape (`web_edition_gap`, étape 3).

La constante ne sert qu'aux mentions qui ne portent pas sur une vente (emails d'alerte) ; les écrans d'une vente
affichent le millésime de la ligne réellement utilisée.

## 3. Essai à blanc (dry-run)

Actions (GitHub), workflow **Reference data import**, Run workflow :

- `dataset` : **`rents`** (jamais `all` : il relance aussi les autres jeux, ce qui est inutile et long) ;
- `dry_run` : coché.

Lire le résumé de l'étape « Import reference data » :

- `vintage` : le nouveau millésime ;
- les quatre segments (`apt_all`, `apt_1_2`, `apt_3p`, `house`) : chacun environ 34 900 communes, au moins
  34 800 ;
- `arrondissements=45`, `updated_on` ;
- un `web_edition_gap` fait **échouer** l'étape, même en dry-run : la constante de l'étape 2 n'est pas à jour.

Si le schéma du fichier change (colonnes, encodage, titres de ressources), le dry-run échoue sur les colonnes
attendues ou les segments : corriger `rents.py` avant d'aller plus loin.

## 4. Choisir le moment

Dans l'après-midi ou la soirée (UTC), après les passages d'alertes du matin (06:15 à 09:30).

## 5. Écriture (production)

Workflow **Reference data import** avec `dataset = rents` et `dry_run` décoché.

L'écriture tient dans **une seule transaction** : upsert des quatre segments, purge des communes disparues,
contrôle d'un seul millésime. En cas d'échec, rien n'est modifié et l'ancienne édition reste servie. Le
fichier est refusé s'il compte moins de 99 % des lignes actuelles de la table. En cas d'échec, une étape du
workflow écrit un résumé de l'erreur.

## 6. Vérifier

```sql
select vintage, count(*), max(imported_at) from public.anil_rents group by 1;
```

Attendu : **un seul millésime**, environ 139 600 lignes (34 900 communes × 4 segments). Puis
`select segment, count(*) from public.anil_rents group by 1;` (quatre segments, plus de 34 000 chacun) et un
exemple (`where commune_code = '33063'`). Sur la fiche d'une vente : la mention porte le bon millésime. Le
cache de lecture de l'application dure 6 heures (`rent-reference.server.ts`).

## 7. Alertes : la base silencieuse

Le changement de base de loyers peut faire entrer des ventes dans les alertes « rendement minimal » sans
qu'elles aient changé. Pour éviter une rafale d'emails :

1. Poser `ALERT_RENT_BASIS_SWITCH_AT` (Vercel, Production), en ISO UTC, à l'heure de **l'import** (étape 5),
   **avant le premier passage de `smart-alerts` qui suit** (06:15 UTC le lendemain).
2. Redéployer (Vercel n'applique une variable qu'à un nouveau déploiement).
3. Pendant 48 heures, la première évaluation de chaque alerte à rendement déjà évaluée enregistre les nouvelles
   correspondances **sans notification**.
4. **Retirer la variable après les 48 heures** (et redéployer).

Variable absente ou date invalide : rien n'est tu, sans message.

## 8. Zonage tendu (autre rythme)

Le zonage tendu n'est pas annuel : même workflow avec `dataset = tension`, après chaque décret. Même démarche
(dry-run, puis écriture).

## Retour arrière

- Relancer l'import du millésime précédent : rétablir l'identifiant et la constante, puis relancer. Les imports
  sont idempotents.
- Ou restaurer `anil_rents` depuis une sauvegarde Supabase.
- Sans donnée ANIL pour une commune, l'application retombe sur la médiane du département calculée sur la carte,
  puis sur le loyer départemental codé en dur (`src/lib/rent-reference.server.ts`).
