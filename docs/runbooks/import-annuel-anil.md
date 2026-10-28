# Import annuel de la carte des loyers de l'ANIL (checklist de décembre)

La carte des loyers de l'ANIL (table `anil_rents`) est publiée chaque année en décembre (2025 : fichiers du
11/12/2025). Les rendements affichés, les alertes, les rapports et les exports la lisent. Ce runbook est la
checklist du propriétaire pour la charger. Le contexte (sources, format, gardes, lecture par l'application) est
dans `docs/operations/donnees-de-reference-loyers-et-zonage.md`.

Public : le propriétaire. L'étape d'écriture **écrit en production** et n'est pas atomique (voir plus bas).

Dernier essai : jamais pour un changement de millésime (les imports de `rents` du 27/10/2026 ont chargé le
millésime 2025). À dater après l'import de décembre 2026.

## 1. Repérer la nouvelle édition

Sur data.gouv.fr, le jeu `693aa2feed1bf4da603faa49` s'intitule « … par commune en 20XX ». Le millésime est lu
dans ce titre. Vérifier en décembre que le jeu porte bien l'année attendue et que ses quatre fichiers sont
là (appartement, 1 ou 2 pièces, 3 pièces ou plus, maison).

Point non vérifié : si l'édition suivante est publiée sous **un autre jeu** (autre identifiant), l'import
rejouerait l'édition précédente sans erreur. Contrôler le millésime affiché dans le résumé de l'étape 2 ;
si le jeu a changé, adapter `ANIL_DATASET_ID` dans `services/data-pipeline/src/reference_data/rents.py` dans la
pull request de l'étape 3.

## 2. Essai à blanc (dry-run)

Actions (GitHub), workflow **Reference data import**, Run workflow :

- `dataset` : **`rents`** (jamais `all` : il relance aussi `communes`, `risks` et `climate`, ce qui est inutile et
  long : le workflow prévoit jusqu'à 90 minutes) ;
- `dry_run` : coché.

Lire le résumé de l'étape « Import reference data » :

- `vintage` : le nouveau millésime ;
- les quatre segments (`apt_all`, `apt_1_2`, `apt_3p`, `house`) : chacun au moins 34 000 communes ;
- aucun refus de l'import (au plus 0,5 % de lignes rejetées) ;
- `web_edition_gap` : s'il apparaît, la constante de l'application ne suit pas (étape 3). C'est attendu à ce
  stade.

Si le schéma du fichier change (colonnes, encodage, titres de ressources), le dry-run échoue sur les colonnes
attendues ou les segments : corriger `rents.py` avant d'aller plus loin.

## 3. Pull request : la constante et les deux tests

À faire et fusionner **avant** l'écriture :

1. `ANIL_CURRENT_EDITION` dans `src/lib/rent-source-notice.ts` : `{ vintage, sourceUpdatedOn }` du nouveau
   millésime (la date est celle du fichier, `updated_on` dans le résumé).
2. Les deux tests qui figent l'édition 2025 :
   - `src/lib/rent-reference.test.ts` (la ligne `expect(ANIL_CURRENT_EDITION).toEqual(...)`) ;
   - `services/data-pipeline/tests/test_reference_data.py`
     (`test_the_real_web_edition_matches_the_edition_the_dataset_publishes`).

Ces tests **ne lisent pas le jeu réel** : ils comparent la constante à une valeur écrite en dur. Le changement
de constante les fait échouer tant qu'ils ne sont pas édités, mais **oublier la constante ne casse rien** : le
seul signal est `web_edition_gap` dans le résumé de l'import. Relancer le dry-run après la fusion : le champ
doit avoir disparu.

La constante ne sert qu'aux mentions qui ne portent pas sur une vente (emails d'alerte) ; les écrans d'une vente
affichent le millésime de la ligne réellement utilisée.

## 4. Écriture (production)

Dans l'après-midi ou la soirée (UTC), après les passages d'alertes du matin (06:15 à 09:30), workflow
**Reference data import** avec `dataset = rents` et `dry_run` décoché.

L'écriture n'est **pas atomique** : l'analyse et les contrôles se font avant la première écriture, mais l'écriture
se fait par paquets de 1 000 lignes, un commit chacun, puis une purge des lignes non touchées, puis un contrôle
final (un seul millésime, bon nombre de lignes). Un échec en cours de route laisse un mélange de millésimes, déjà
lisible par l'application (cache de 6 h). Si cela arrive : **relancer le même import**, il est idempotent.

## 5. Vérifier

```sql
select vintage, count(*), max(imported_at) from public.anil_rents group by 1;
```

Attendu : **un seul millésime**, environ 139 600 lignes (34 900 communes × 4 segments). Puis
`select segment, count(*) from public.anil_rents group by 1;` (quatre segments, plus de 34 000 chacun) et un
exemple (`where commune_code = '33063'`). Sur la fiche d'une vente : la mention porte le bon millésime (après le
cache de 6 h).

## 6. Alertes : la base silencieuse

Le changement de base de loyers peut faire entrer des ventes dans les alertes « rendement minimal » sans
qu'elles aient changé. Pour éviter une rafale d'emails :

1. Poser `ALERT_RENT_BASIS_SWITCH_AT` (Vercel, Production), en ISO UTC, à l'heure de **l'import** (étape 4),
   **avant le premier passage de `smart-alerts` qui suit** (06:15 UTC le lendemain).
2. Redéployer (Vercel n'applique une variable qu'à un nouveau déploiement).
3. Pendant 48 heures, la première évaluation de chaque alerte à rendement déjà évaluée enregistre les nouvelles
   correspondances **sans notification**.
4. **Retirer la variable après les 48 heures** (et redéployer).

La variable est lue par `process.env` (pas par `serverEnv`), dans `src/lib/alert-matches.ts`. Variable absente
ou date invalide : rien n'est tu, sans message.

## 7. Zonage tendu (autre rythme)

Le zonage tendu n'est pas annuel : même workflow avec `dataset = tension`, après chaque décret. Même démarche
(dry-run, puis écriture).

## Retour arrière

- Relancer l'import du millésime précédent **n'est pas prévu** : l'import lit le jeu courant.
- Restaurer `anil_rents` depuis une sauvegarde Supabase (demande au propriétaire du projet).
- Sans donnée ANIL pour une commune, l'application retombe sur le loyer départemental
  (`src/lib/rent-reference.server.ts`).
