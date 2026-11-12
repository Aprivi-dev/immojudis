# Registre des pièces : appliquer le lot R2a (durcissement, inerte)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md`, section 10. Architecture :
`docs/architecture/registre-des-pieces.md`. Ce lot ne change aucune fiche : aucun champ n'est tenu, aucune décision
n'est écrite, rien n'appelle la projection.

## Ce qui est appliqué

| Ordre | Migration                                                 | Contenu                                                                                                                                              | Verrou le plus fort                                                                                                                                          | Pendant un lot de publication |
| ----- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| A1    | `20261117100000_fact_registry_common_sequence`            | Séquence commune aux deux journaux                                                                                                                   | ACCESS EXCLUSIVE sur les deux journaux (vides), première application seulement                                                                               | Possible, déconseillé         |
| A2    | `20261117100100_fact_registry_guards`                     | Gardes par rôle en liste blanche, garde d'origine étendue, garde du marqueur (fonction), contrôle des déclencheurs, `echo_suppressed`, format du lot | ACCESS EXCLUSIVE bref sur la file d'évènements et le journal des décisions (vides), première application ; **SHARE ROW EXCLUSIVE sur `auction_fact_claims`** | **Non**                       |
| A3    | `20261117100200_field_hold_and_projection_v2`             | Retenue et projection en version 2, déclencheur de la garde du marqueur                                                                              | **SHARE ROW EXCLUSIVE sur `auction_sales`** (jamais ACCESS EXCLUSIVE)                                                                                        | **Non**                       |
| A4    | `20261117100300_sale_history_skips_held_fields`           | L'historique des ventes ignore `held_fields`                                                                                                         | Aucun                                                                                                                                                        | Oui                           |
| A5    | `20261117100400_readiness_override_rpcs_summary`          | Les deux RPC de dérogation rendent six clés                                                                                                          | Aucun                                                                                                                                                        | Oui                           |
| A6    | `20261117100450_fact_registry_concurrent_indexes`         | Enregistre deux index, construits ensuite hors transaction                                                                                           | Aucun dans la migration ; SHARE UPDATE EXCLUSIVE pendant la construction                                                                                     | Possible, plus lent           |
| A7    | `20261117100500_fact_registry_baselines_and_check`        | Valeurs d'annonce pour la fusion, contrôle quotidien, alertes                                                                                        | Aucun                                                                                                                                                        | Oui                           |
| A8    | `20261117100600_cron_stale_fact_registry_check`           | La tâche `fact-registry-check` entre dans la liste de `cron.stale` (27 h)                                                                            | Aucun                                                                                                                                                        | Oui                           |
| A9    | `20261117100700_fact_claims_read_model_latest_generation` | La vue des observations ne montre que la dernière génération de la collecte                                                                          | ACCESS EXCLUSIVE bref sur la vue seulement                                                                                                                   | Oui                           |

Le workflow « Apply Supabase Migrations » applique tout ce qui est en attente, dans l'ordre, puis construit les
index (« Apply reviewed concurrent index operations ») et contrôle la dérive de schéma. **À lancer entre deux lots
de publication de la collecte**, à cause de A2 et de A3. Chaque migration est sa propre transaction. `lock_timeout`
vaut 5 s, ramené à **2 s** là où A2 et A3 attendent une table écrite par la collecte : dès le début de A2, qui
verrouille `auction_fact_claims` en premier (avant les deux journaux, pour ne pas croiser la suppression d'une
observation), et dans A3 avant le commentaire de la colonne `held_fields` et les deux déclencheurs. Le verrou est
libre, ou pris pour une vingtaine de secondes par un lot de la collecte, et attendre plus ne ferait que mettre en
attente tous les autres écrivains de la table derrière la migration. Deux secondes et non une : PostgreSQL
n'annule un autovacuum qui gêne qu'après `deadlock_timeout` (1 s). Si un verrou n'est pas obtenu, cette migration
échoue sans effet, les précédentes restent appliquées, et il suffit de relancer le workflow. Chaque migration se
rejoue sans dommage (seconde application vérifiée : aucun ACCESS EXCLUSIVE sur une table).

Entre A2 et A3, `app_private.assert_fact_registry_triggers()` lève `registry_unavailable` (la garde du marqueur
est attendue, son déclencheur n'est créé que par A3). Rien ne l'appelle avant A7 : sans conséquence, sauf à lancer
à la main le rattrapage `20261029100200` ou le fichier de maintenance dans cet intervalle.

**A9 doit être appliquée avant le lot « collecte » qui passe les observations à la version 3.** Tant que la
collecte écrit une seule version, elle ne masque rien. Elle fixe un **plafond de génération** à 3
(`app_private.fact_claims_generation_ceiling()`) : une observation candidate de la collecte d'une génération plus
haute est masquée et ne masque rien. Avant de déployer une collecte qui écrirait une version 4, une migration
relève le plafond (la CI échoue sinon, invariant `fact-claims-generation-pattern`). Pour revenir de la version 3 à
la version 2, une migration ramène le plafond à 2 : les observations de la version 3 cessent de masquer et sont
masquées, sans rien nettoyer.

**Conséquence du plafond à 3, dès l'application de A9.** La génération 3 compte déjà, avant même le lot
« collecte » : une seule observation `auction_fact_claims_v3` de l'extracteur de la collecte sur une vente masque
les candidates version 2 de cette vente dans la file de relecture. Seul le détenteur de la clé serveur peut
l'écrire, rien n'est effacé, et une migration qui ramène le plafond à 2 les fait revenir. À savoir pour un essai
de la version 3 : il masque pour de bon, sur les ventes qu'il touche.

## Ordre de déploiement (sans manipuler de secret)

1. **Fusionner**, attendre le déploiement Vercel et la CI verte du commit.
2. **Attendre un passage planifié** de la tâche (05:28 UTC, jusqu'à 59 minutes de retard). La route est en ligne,
   les fonctions n'existent pas encore : la tâche répond `skipped: migration_pending`, ce qui compte comme un
   succès. Le vérifier (mesure 3 ci-dessous).
3. **Appliquer les migrations** entre deux lots de publication (mesure 2 ci-dessous), par le workflow « Apply
   Supabase Migrations » (`confirm_target: production`). `cron.stale` attend désormais la tâche toutes les
   27 heures : le succès de l'étape 2 a moins de 24 heures, le passage du lendemain tombe donc avant l'échéance.
4. **Au passage suivant**, la réponse de la tâche doit porter `counts` (les dix contrôles), **pas `skipped`**. Une
   réponse `skipped` après les migrations veut dire que PostgREST ne voit pas la fonction (cache de schéma non
   rechargé, signature différente) : la tâche « réussit » sans rien contrôler. Recharger le schéma
   (`notify pgrst, 'reload schema';`), puis vérifier le passage suivant.

Personne n'appelle la route à la main et personne ne lit `CRON_SECRET`. Ne pas insérer de faux succès dans
`operational_job_runs`.

## Avant

1. **Observation du lot R1 terminée** (pas avant le 12/11/2026 à 11:45 UTC) et propre.
2. **Un succès de la tâche de moins de 27 heures** (étape 2 de l'ordre de déploiement) :

   ```sql
   select status, finished_at from public.operational_job_runs
   where job_name = 'fact-registry-check' order by started_at desc limit 3;
   ```

3. **Mesures préalables P1 à P8**, en lecture seule, à confier à `qualite-donnees`. Elles n'emploient que des
   tables et des colonnes du catalogue : ni `pg_get_userbyid`, ni `pg_get_triggerdef`, ni `pg_get_expr`, que
   l'outil de lecture seule refuse. **Si une mesure ne donne pas le résultat attendu, ne pas appliquer et revenir
   vers le plan.** P3 se refait au moment de lancer le workflow.

### P1. Journaux vides, rien de tenu, aucun libellé de lot hors du motif

Attendu : 0, 0, 0, 0. Si un journal n'est pas vide, A1 refuse de s'appliquer (erreur `55000`, « fact registry
journals are not empty ») : ne pas forcer. Un `lot_ref` hors du motif ferait échouer A2.

```sql
select
  (select count(*) from public.auction_fact_claim_decisions) as decisions,
  (select count(*) from public.auction_sale_field_hold_events) as evenements,
  (select count(*) from public.auction_sales where held_fields is not null) as ventes_du_registre,
  (select count(*) from public.auction_fact_claim_decisions
    where lot_ref is not null
      and lot_ref !~* '^((lots? )?(n[°º] ?)?[1-9][0-9]{0,2}[a-z]?( ?(et|,|-|à) ?[1-9][0-9]{0,2}[a-z]?){0,3}|[1-9][0-9]{0,2}(er|e|ème|eme|nd)? lot)$'
  ) as lot_ref_hors_motif;
```

### P2. Nom et validité des deux contraintes recréées par A2

Attendu : deux lignes, `convalidated` à `true`. Un autre nom veut dire que A2 laisserait l'ancienne contrainte en
place à côté de la nouvelle.

```sql
select relation.relname, constraint_row.conname, constraint_row.convalidated
from pg_constraint constraint_row
join pg_class relation on relation.oid = constraint_row.conrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and constraint_row.contype = 'c'
  and constraint_row.conname in (
    'auction_sale_field_hold_events_event_check', 'auction_fact_claim_decisions_lot_ref_check');
```

### P3. Fenêtre libre, juste avant de lancer le workflow

Attendu : aucune ligne. Aucun lot de publication, aucune autre écriture ni aucun autovacuum sur les DEUX tables
dont A2 et A3 attendent le verrou.

```sql
select relation.relname, held.mode, activity.pid, activity.backend_type, activity.application_name,
       now() - activity.xact_start as depuis
from pg_locks held
join pg_class relation on relation.oid = held.relation
join pg_namespace namespace on namespace.oid = relation.relnamespace
join pg_stat_activity activity on activity.pid = held.pid
where namespace.nspname = 'public'
  and relation.relname in ('auction_sales', 'auction_fact_claims')
  and held.granted
  and held.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock',
                    'ExclusiveLock', 'AccessExclusiveLock');
```

### P4. Un seul propriétaire : le pont, la projection et les six tables

Attendu : huit lignes (deux fonctions, six tables), le même `proprietaire` partout. Sinon, après A2 :
l'acceptation d'un fait de l'agent d'information échouerait en `42501` (la garde d'origine n'accepte que le
propriétaire de la projection), et le contrôle des déclencheurs signalerait `<table>.owner`, donc une alerte
critique dès le premier passage.

```sql
select 'fonction' as objet, routine.proname as nom, owner_role.rolname as proprietaire
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
join pg_roles owner_role on owner_role.oid = routine.proowner
where namespace.nspname = 'app_private'
  and routine.proname in ('bridge_accepted_information_agent_fact_claim', 'project_sale_fields')
union all
select 'table', relation.relname, owner_role.rolname
from pg_class relation
join pg_namespace namespace on namespace.oid = relation.relnamespace
join pg_roles owner_role on owner_role.oid = relation.relowner
where namespace.nspname = 'public'
  and relation.relname in (
    'auction_sales', 'auction_fact_claims', 'auction_fact_fields', 'auction_fact_source_precedence',
    'auction_fact_claim_decisions', 'auction_sale_field_hold_events')
order by 1, 2;
```

### P5. Trois états qui rendraient le lot actif dès son application

Attendu : 0 ; aucune ligne ; aucune ligne.

```sql
-- Aucune vente ne porte déjà le libellé réservé. Sinon la retenue serait appelée à chaque écriture de ces
-- ventes et l'alerte critique fact_registry.registry_label se lèverait au premier passage.
select count(*) from public.auction_sales where surface_source like 'fact_registry%';

-- Aucune vente ne porte deux générations de l'extracteur de la collecte. Sinon ne pas appliquer A9 : elle
-- masquerait des observations dès son application.
select auction_sale_id, array_agg(distinct extractor_version) from public.auction_fact_claims
where auction_sale_id is not null and extractor_name = 'immojudis.pipeline.fact_claims'
group by 1 having count(distinct extractor_version) > 1 limit 20;

-- Aucun doublon d'identifiant de fait, sur TOUTES les observations (y compris celles qui ne sont plus
-- rattachées à une vente). Sinon l'index unique de A6 ne se construit pas.
select evidence_locator->>'information_agent_fact_id', count(*) from public.auction_fact_claims
where evidence_locator ? 'information_agent_fact_id' group by 1 having count(*) > 1;
```

### P6. Ancre de A8 dans la liste de `cron.stale`

Attendu : une ligne, `taches_presentes` à 13, `ancre_presente` à `true`, `tache_absente` à `true`. Sinon A8 refuse
de s'appliquer (« Operational health expected-jobs list changed ») : relire la définition en place et adapter la
migration, sans retirer d'entrée.

```sql
select
  (select count(*) from unnest(array[
     'operational-health', 'smart-alerts', 'alert-notifications', 'sale-change-monitor', 'data-retention',
     'sale-retention', 'information-agent-inbound', 'listing-completeness', 'sale-reminders', 'sale-pepites',
     'sale-flood-risk', 'sale-results', 'weekly-digest']) as job(name)
    where position('(''' || job.name || ''', interval ''' in routine.prosrc) > 0) as taches_presentes,
  position('(''weekly-digest'', interval ''8 days'')' in routine.prosrc) > 0 as ancre_presente,
  position('fact-registry-check' in routine.prosrc) = 0 as tache_absente
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where namespace.nspname = 'app_private' and routine.proname = 'evaluate_operational_health';
```

### P7. Volumes réels, par extracteur et par version

Sert à A9 (quelles versions existent) et à lire le banc de la section suivante : le rapport entre le banc local
et la production se calcule sur ces chiffres, pas sur une estimation.

```sql
select extractor_name, extractor_version, claim_status, count(*) as observations,
       count(*) filter (where auction_sale_id is not null) as rattachees_a_une_vente
from public.auction_fact_claims
group by 1, 2, 3 order by 1, 2, 3;

select count(*) as ventes from public.auction_sales;
```

### P8. Version du serveur et réglages par rôle

Le lot a été essayé sous PostgreSQL 16 (base locale) ; la CI le rejoue sous 17.6 à l'ouverture de la PR, et la
production est en 17 : relever la version exacte. Les réglages par rôle disent sous quel `statement_timeout`
tournera le contrôle quotidien (rôle serveur, par PostgREST).

```sql
show server_version;

select coalesce(database_row.datname, '(toutes les bases)') as base,
       coalesce(role_row.rolname, '(tous les rôles)') as role, setting.setconfig
from pg_db_role_setting setting
left join pg_database database_row on database_row.oid = setting.setdatabase
left join pg_roles role_row on role_row.oid = setting.setrole
order by 1, 2;
```

Avant d'appliquer, relever aussi les deux plans du contrôle A4 ci-dessous : ils servent de point de comparaison.

## Vérifier après (lecture seule)

Contrôles A1 à A5, dans cet ordre, **juste après l'application et avant tout rattrapage ou fichier de
maintenance**. Mêmes règles que les mesures préalables : aucune fonction que l'outil de lecture seule refuse.

### A1. Douze déclencheurs en mode `always`

Attendu : douze lignes, `tgenabled` à `A` partout.

```sql
select relation.relname, trigger_row.tgname, trigger_row.tgenabled
from pg_trigger trigger_row
join pg_class relation on relation.oid = trigger_row.tgrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and not trigger_row.tgisinternal
  and trigger_row.tgname in (
    'aaab_auction_sales_held_fields_insert_guard', 'aaab_auction_sales_held_fields_marker_guard',
    'aaab_auction_sales_held_fields_role_guard', 'aaab_auction_sales_hold_projected_fields',
    'auction_fact_claim_decisions_append_only', 'auction_fact_claim_decisions_no_truncate',
    'auction_fact_claim_decisions_validate', 'auction_fact_claims_no_truncate',
    'auction_fact_claims_registry_origin_guard', 'auction_sale_field_hold_events_append_only',
    'auction_sale_field_hold_events_no_truncate', 'auction_sale_field_hold_events_stamp')
order by 1, 2;
```

### A2. La fonction de contrôle des déclencheurs rend un tableau vide

Attendu : `{}`. **C'est la première exécution de cette fonction sous PostgreSQL 17 en production** : elle compare
deux textes tels que le serveur les imprime, et tous deux dépendent de sa version. Le premier est la clause
`WHEN` de chaque déclencheur. Le second est `proconfig`, les réglages de chaque fonction de déclencheur, attendus
sous la forme exacte `search_path=""`. Si A1 est bon (douze lignes en `A`) et que cette fonction nomme pourtant un
déclencheur, ne rien réparer : la cause la plus probable est une forme imprimée que la comparaison ne prévoit pas
(clause `WHEN` ou `proconfig`), pas un déclencheur abîmé. Même conduite dans les deux cas : relever le tableau
rendu et revenir vers le plan ; le fichier de maintenance ne corrige que le mode. Une entrée `<table>.owner`
renvoie à la mesure P4.

```sql
select app_private.fact_registry_triggers_not_always();
```

### A3. Les dix contrôles à `false`, rien de tenu

Attendu : dix lignes, `leve` à `false` partout ; puis 0, 0, 0.

```sql
select key, value ->> 'active' as leve, value ->> 'count' as compte
from jsonb_each(public.check_fact_registry_consistency() -> 'checks');

select (select count(*) from public.auction_sales where held_fields is not null) as ventes_du_registre,
       (select count(*) from public.auction_sale_field_hold_events) as evenements,
       (select count(*) from public.auction_fact_claim_decisions) as decisions;
```

### A4. Plans de la vue des observations, avant et après A9

Les deux lectures de l'application, par `explain` sans `analyze` (rien n'est exécuté). À relever **avant**
d'appliquer (avec les mesures préalables) et **après**. Attendu après : aucun parcours séquentiel de
`auction_fact_claims` dans la lecture par vente ; pour la liste, un agrégat de plus, par vente.

```sql
-- Lecture par vente (la fiche). Prendre l'identifiant d'une vente qui porte des observations.
explain select field_key, fact_status, value_jsonb
from public.v_auction_fact_claims_read_model
where auction_sale_id = '00000000-0000-0000-0000-000000000000';

-- Liste de relecture d'administration, la plus chère.
explain select count(*) from public.v_auction_fact_claims_read_model
where auction_sale_id is not null and fact_status in ('candidate', 'conflicted');
```

### A5. Deux index valides, deux opérations `applied`

Attendu : deux lignes `indisvalid` à `true` (`auction_fact_claims_agent_fact_key` unique), puis deux lignes
`applied` sans `last_error`.

```sql
select relation.relname, index_row.indisvalid, index_row.indisunique
from pg_index index_row join pg_class relation on relation.oid = index_row.indexrelid
where relation.relname in ('auction_sales_held_fields_idx', 'auction_fact_claims_agent_fact_key');

select operation_key, status, last_error from app_private.concurrent_index_operations
where operation_key like '20261117100450:%';
```

### Conseiller de sécurité de Supabase : deux avertissements attendus

Après A9, le conseiller signale `function_search_path_mutable` pour `app_private.fact_claims_generation` et
`app_private.fact_claims_generation_ceiling`. C'est voulu, ne pas « corriger » : une clause `set search_path`
empêcherait PostgreSQL de fondre ces deux fonctions dans la requête de la vue, qui paierait alors un appel par
observation. Tout y est qualifié par `pg_catalog`, elles ne lisent aucune table, et seul `service_role` les
exécute. Tout autre avertissement nouveau du conseiller est à examiner.

Puis le coût. Pour la vue, mesurer avant et après A9 les DEUX lectures de l'application : la lecture par vente
(`explain`, sans `analyze` : aucun parcours séquentiel attendu) et la liste de relecture d'administration, la plus
chère (temps moyen des deux requêtes PostgREST dans `pg_stat_statements`, ou `explain` de
`select count(*) from public.v_auction_fact_claims_read_model where auction_sale_id is not null and fact_status in ('candidate', 'conflicted')`).
Sur le banc local, à 240 000 observations rattachées à 20 000 ventes, la liste passe de 60 à 80 ms à 170 à
260 ms : un agrégat de plus par vente, sans expression rationnelle. La lecture par vente reste sous 2 ms. Le
rapport entre ce banc et la production n'est pas établi : il se calcule sur la mesure P7, et le chiffre à retenir
est l'écart mesuré en production (contrôle A4, puis temps moyen dans `pg_stat_statements`). Au-delà de 100 ms
d'écart sur la liste, un index partiel est prévu au lot R2b. Puis la durée des imports. Attendu : inchangée. Sur le banc local (5 000 ventes dont aucune n'est tenue), le coût isolé de chaque
élément du lot placé sur le chemin de l'import est de 1 à 6 microsecondes par ligne, pour une erreur de mesure de 3
à 7 microsecondes : dans le bruit, et de l'ordre de 1 % d'une ligne au plus. Aucun déclencheur du registre n'est
appelé quand rien n'est tenu : pendant cet upsert, les quatre fonctions de déclencheur du registre comptent zéro
appel (`track_functions`), et le test 884 le prouve en remplaçant la fonction de retenue et celle de la garde du
marqueur par une fonction qui lève. À suivre ensuite : les alertes
`fact_registry.*` (aucune attendue) et le journal de la tâche `fact-registry-check` dans `operational_job_runs`.
**Critère pour le lot R2b** : contrôle quotidien à zéro sur deux passages qui portent `counts`, durée des imports
inchangée.

## Si quelque chose échoue

| Symptôme                                                                           | Cause                                                                                                                                                                                                                                                                                                                                                             | Que faire                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canceling statement due to lock timeout` sur `20261117100100` ou `20261117100200` | Un lot de la collecte écrivait `auction_fact_claims` ou `auction_sales`                                                                                                                                                                                                                                                                                           | Rien n'est appliqué de cette migration. Relancer le workflow entre deux lots (mesure 2). Si A2 est passée et pas A3, l'état est cohérent et inerte.                                                                                                                                                                                                                                                                                                |
| `fact registry journals are not empty` sur `20261117100000`                        | Une décision ou un évènement existe déjà                                                                                                                                                                                                                                                                                                                          | Ne rien forcer. La séquence commune ne peut plus remplacer les identités sans décider de l'ordre des lignes existantes : revenir vers le plan.                                                                                                                                                                                                                                                                                                     |
| `violates check constraint "auction_fact_claim_decisions_lot_ref_check"`           | Une décision porte un libellé de lot hors format                                                                                                                                                                                                                                                                                                                  | Même cause que la ligne précédente (journal non vide) : revenir vers le plan.                                                                                                                                                                                                                                                                                                                                                                      |
| `Operational health expected-jobs list changed` sur `20261117100600`               | La liste attendue de `cron.stale` a changé depuis la rédaction                                                                                                                                                                                                                                                                                                    | Relire la définition en place, adapter la migration (nouvelle ancre), sans retirer d'entrée.                                                                                                                                                                                                                                                                                                                                                       |
| L'opération d'index `auction_fact_claims_agent_fact_key` passe à `failed`          | Doublons d'identifiant de fait (mesure F.8 non faite sur toutes les observations)                                                                                                                                                                                                                                                                                 | L'index invalide est retiré au passage suivant du script. Traiter les doublons avec le plan, puis relancer `npm run db:indexes:concurrent`. Rien d'autre n'est touché.                                                                                                                                                                                                                                                                             |
| La détection de dérive signale une instruction `CREATE [UNIQUE] INDEX` du lot      | L'outil imprime l'instruction sous une forme que `scripts/lib/schema-drift.mjs` ne prévoit pas. Cas survenu le 12/11/2026 à 08:50 UTC : chaque index imprimé sur deux lignes, le `WHERE` sur une ligne à part, indentée, alors que le filtre comparait ligne par ligne. Corrigé depuis : il compare l'instruction entière, jusqu'au point-virgule                 | Les index sont vérifiés à part, mot pour mot, dans le catalogue (étape précédente, verte) : la production est conforme. C'était le cas le 12/11/2026 (les deux index `applied`). Ajouter la forme imprimée aux tests de `check-supabase-schema-drift.test.mjs` et au filtre. Après la fusion, lancer une nouvelle exécution du workflow depuis `main` : relancer l'exécution échouée rejouerait l'ancien code.                                     |
| Alerte `cron.stale` pour `fact-registry-check`                                     | Les migrations ont été appliquées sans attendre un passage de la tâche                                                                                                                                                                                                                                                                                            | Attendre le passage suivant (05:28 UTC) : l'alerte se referme deux heures après le premier succès. Ne pas supprimer la ligne d'`operational_alerts`.                                                                                                                                                                                                                                                                                               |
| La tâche répond `skipped` après les migrations                                     | PostgREST ne voit pas `sync_fact_registry_alerts`                                                                                                                                                                                                                                                                                                                 | Étape 4 de l'ordre de déploiement.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| La tâche échoue : « rapport partiel »                                              | Plus de 500 ventes candidates                                                                                                                                                                                                                                                                                                                                     | Aucune alerte n'a été refermée. Le contrôle doit être paginé (reste du lot R2b) : revenir vers le plan.                                                                                                                                                                                                                                                                                                                                            |
| Alerte `fact_registry.triggers_not_always`                                         | Un déclencheur du registre manque ou n'est plus en mode `always` (un `disable trigger user` puis `enable trigger user` a été joué) ; ou sa définition diffère de celle de sa migration (fonction, schéma, mode de sécurité, réglages, évènements, colonnes, clause `WHEN`) ; ou une table du registre n'a plus le propriétaire de la projection (`<table>.owner`) | Lire d'abord `select app_private.fact_registry_triggers_not_always();` et le contrôle A1. Mode seulement (A1 montre autre chose que `A`) : `supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql`, entre deux lots. Douze lignes en `A` et un déclencheur nommé quand même : définition différente, ou forme imprimée non prévue juste après l'application (contrôle A2) ; ne rien réparer à la main, revenir vers le plan. |

## Retour arrière

Tant que `held_fields` est nulle partout et que les journaux sont vides (c'est le cas à ce lot), tout se retire
sans effet sur les fiches.

**Règle : tout retour arrière est livré par une NOUVELLE migration, d'horodatage postérieur, revue et appliquée
par le workflow.** Jamais de SQL joué à la main, jamais de fichier de migration retiré ni modifié une fois
appliqué :

- le workflow refuse de tourner quand une version présente dans l'historique de la base manque dans le dépôt
  (« Remote migration … is missing from the local migration directory »), et quand le contenu d'une migration
  appliquée a changé ;
- un objet retiré à la main laisserait la détection de dérive au rouge, puisque le dépôt le crée toujours.

Le SQL donné en tête de chaque migration sous « Retour arrière » est donc le CONTENU de cette nouvelle migration,
pas une commande à lancer. Les étapes ci-dessous disent quoi y mettre, dans l'ordre inverse du lot ; plusieurs
étapes peuvent tenir dans une seule migration.

**Index (A6).** `drop index concurrently` est refusé dans une migration (elle s'applique dans une transaction, et
le script des migrations l'écarte). Un index du lot se retire donc par une migration qui fait un `drop index if
exists` ordinaire, sous `lock_timeout` de 2 s et entre deux lots de publication (verrou ACCESS EXCLUSIVE bref sur
la table ; les deux index sont vides ou très petits à ce lot), et qui supprime dans la même transaction la ligne
correspondante de `app_private.concurrent_index_operations`. La même PR retire l'entrée de la liste blanche de
`scripts/apply-supabase-concurrent-index-operations.mjs`, son test, et la ligne de l'invariant qui la cite ;
sinon l'étape « Apply reviewed concurrent index operations » reconstruirait l'index. Ce chemin n'a pas été essayé
sur le banc : le relire avec `architecte-sql` avant de s'en servir.

1. A9 : réappliquer la définition de la vue de `20260929103000` (avec `security_invoker`, `revoke` et `grant`).
   Pas après le passage de la collecte à la version 3 : les observations s'afficheraient en double.
2. A8 : retirer l'entrée de la liste de `cron.stale` par le remplacement inverse (sinon l'alerte reste ouverte
   une fois la route retirée) ; retirer l'entrée de `vercel.json` et la route, dans la même PR.
3. A7 : `drop function` des trois fonctions publiques, de
   `app_private.sync_fact_registry_alerts_from_report` et de `app_private.sale_field_value_leaks`.
4. A6 : retirer les deux index par le chemin décrit ci-dessus (« Index (A6) »).
5. A5 : rétablir les définitions de `20260919123000`.
6. A4 : rétablir la définition de `20261109140000`. **`held_fields` est une dépendance dure de toute écriture de
   vente** : le journal des ventes (A4) nomme la colonne à chaque `UPDATE` de `auction_sales`. Ne jamais retirer
   la colonne `held_fields` avant d'avoir rétabli `20261109140000`, sinon toutes les écritures de vente échouent.
7. A3, **entre deux lots** : supprimer le déclencheur `aaab_auction_sales_held_fields_marker_guard`, réappliquer
   les définitions de `20261116100500` (retenue, projection à trois paramètres, déclencheur et sa liste de
   colonnes), puis supprimer les cinq fonctions de la mémoire d'écho. **Plus possible dès qu'un champ est tenu
   ou libéré** : la retenue du lot R1 ne connaît pas l'état `released`. **A3 retirée seule,
   `app_private.assert_fact_registry_triggers()` lève `registry_unavailable`** (A2 attend la garde du marqueur et
   la clause `WHEN` de la version 2) tant qu'A2 n'est pas rétablie elle aussi : le contrôle quotidien ouvre
   l'alerte `fact_registry.triggers_not_always`, et un rattrapage qui écrit `auction_sales` refuse de valider.
   Retirer A3 et A2 dans la même fenêtre.
8. A2, **entre deux lots** : rétablir les deux gardes et le déclencheur d'origine de `20261116100100` et
   `20261116100500`, supprimer les deux fonctions de contrôle et la fonction de la garde du marqueur ; ne
   rétablir les anciennes contraintes de `event` et de `lot_ref` que si aucun évènement `echo_suppressed`
   n'existe.
9. A1, journaux vides seulement : rétablir les deux fonctions de `20261116100000`, puis
   `alter column seq add generated always as identity` sur les deux tables et `drop sequence`.

Un retour arrière partiel est sans danger dans cet ordre. Ne jamais retirer les déclencheurs du lot R1 tant
qu'une vente a `held_fields` non nulle.

## Alerte de dérive de la projection : causes connues

`fact_registry.projection_drift` veut dire « la simulation de la projection changerait cette vente ». Tant
qu'aucune pièce n'est acceptée (ce lot), elle ne peut pas se lever. Ensuite, elle ne suit pas le seul
reclassement en terrain (`property_type`, `surface_scope`) : toute écriture de la collecte qui change ce que la
projection déciderait la provoque, sans qu'aucun déclencheur ne relance la projection. Cas prouvé sur base
jetable : une pièce « 3 pièces » bloquée parce que la fiche compte 6 chambres ; la collecte corrige
`bedrooms_count` à 2 ; la pièce tiendrait désormais le champ, la simulation répond `changed = true`, l'alerte se
lève au passage suivant. Ce n'est pas une corruption : la fiche montre encore l'annonce. La réponse (qui relance
la projection) est une question ouverte du lot R2b, voir la note d'architecture.

## À dire dans la description de la PR

À reprendre tel quel, pour que le relecteur ne découvre pas un `grant` à `authenticated` dans un lot annoncé
« sans droit nouveau » :

> La migration `20261117100400` redonne `execute` à `authenticated` sur
> `public.set_auction_sale_readiness_override` et `public.clear_auction_sale_readiness_override`. Ce n'est pas un
> droit nouveau : c'est le droit que ces deux RPC d'administration avaient avant le lot, reposé parce que leur
> type de retour change (la fonction est recréée). Les deux commencent toujours par `is_admin()`. Leur retour
> passe de la ligne entière de la vente à six clés : c'est une réduction de ce qu'elles exposent. Aucune autre
> fonction du lot n'est exécutable par `anon` ou `authenticated`.
>
> Limite de l'analyse statique. Les invariants lisent le texte des migrations : un `alter function` écrit en nom
> nu après un `set local search_path`, ou construit dynamiquement (`execute`, `format`), les passe sans être vu.
> Le contrôle en base (`app_private.fact_registry_triggers_not_always()`, lu chaque jour et avant toute écriture
> du registre) rattrape ce que ces instructions changeraient sur les fonctions des déclencheurs : le mode de
> sécurité, les réglages, et le propriétaire des tables et de la projection. Il ne relit pas le corps des
> fonctions : une garde redéfinie avec une condition morte n'est vue que par les tests pgTAP.

## Restauration de données seules

Essayée sur une base jetable (registre rempli : 15 ventes du registre, 52 décisions, 72 évènements).

**Ce qui se passe sans précaution.** Une restauration de données seules se joue en
`session_replication_role = replica` : les déclencheurs ordinaires et les clés étrangères se taisent, mais les
déclencheurs du registre, en mode `always`, jouent quand même.

- La garde d'insertion refuse toute vente restaurée avec `held_fields` non nulle : la table `auction_sales` n'est
  pas restaurée.
- Le déclencheur de validation refuse les acceptations tant que le profil de l'administrateur n'est pas restauré
  (les tables arrivent par ordre de nom) : le journal des décisions n'est pas restauré.
- Si l'administrateur existe déjà, c'est pire, parce que rien n'échoue : le déclencheur de validation et celui
  d'horodatage **renumérotent et redatent** les deux journaux (`seq`, `decided_at`, `created_at`). Toutes les
  décisions passent avant tous les évènements, la date de chaque décision est perdue, et l'ordre entre une
  libération par l'annonce et une décision devient faux. Reposer la séquence ne répare rien.

**Procédure.** Sur la base cible, entre deux lots de publication, à la main :

```sql
-- 1. Avant la restauration : suspendre, par leur nom, les trois déclencheurs qui refusent ou réécrivent.
begin;
set local lock_timeout = '5s';
alter table public.auction_sales disable trigger aaab_auction_sales_held_fields_insert_guard;
alter table public.auction_fact_claim_decisions disable trigger auction_fact_claim_decisions_validate;
alter table public.auction_sale_field_hold_events disable trigger auction_sale_field_hold_events_stamp;
commit;

-- 2. Restaurer (session_replication_role = replica). Aucune erreur attendue.

-- 3. Après, première transaction : remettre les trois déclencheurs en mode always. Elle est validée seule, pour
--    que les gardes soient de retour même si la suite échoue.
begin;
set local lock_timeout = '5s';
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_insert_guard;
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_validate;
alter table public.auction_sale_field_hold_events enable always trigger auction_sale_field_hold_events_stamp;
commit;

-- 4. Seconde transaction : reposer la séquence commune sur le plus grand seq des deux journaux, puis le contrôle,
--    qui lève s'il manque quelque chose.
begin;
select setval('app_private.fact_registry_seq', greatest(
  (select coalesce(max(seq), 0) from public.auction_fact_claim_decisions),
  (select coalesce(max(seq), 0) from public.auction_sale_field_hold_events),
  1), true);
select app_private.assert_fact_registry_triggers();
commit;
```

**En cas d'échec ou d'abandon à n'importe quelle étape** (restauration interrompue, session perdue, erreur) :
jouer `supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql`, qui remet les douze
déclencheurs en mode `always` et le vérifie, puis le `setval` de l'étape 4. Ne jamais laisser la base avec un des
trois déclencheurs suspendu.

Résultat de l'essai : `held_fields`, les deux journaux (`seq` et dates compris) identiques à la source ; une
nouvelle décision prend un numéro au-dessus de tous les autres ; la simulation de la projection ne changerait
aucune vente ; le contrôle quotidien lève les mêmes contrôles que sur la source.

À savoir :

- ne jamais employer `disable trigger user` puis `enable trigger user` : le second ordre sort tous les
  déclencheurs du registre du mode `always`, sans aucune erreur ;
- les deux autres déclencheurs de chaque journal (ajout seul, pas de `TRUNCATE`) et les gardes de mise à jour de
  `auction_sales` ne gênent pas une restauration : ils ne jouent que sur `UPDATE`, `DELETE` et `TRUNCATE` ;
- pendant la fenêtre, une acceptation ne serait plus validée, un évènement ne serait plus numéroté et une vente
  pourrait être insérée avec `held_fields` : **aucune écriture par l'API entre les étapes 1 et 3, rôle serveur
  compris** (aucune décision, aucun import, tâches planifiées de la collecte arrêtées) ;
- la garde d'origine des observations (`auction_fact_claims_registry_origin_guard`) reste en place et joue aussi
  à l'insertion pendant la restauration : elle laisse passer si le rôle qui restaure est le propriétaire de la
  projection (première condition d'arrêt de la section « Avant »). Restaurer avec ce rôle, pas avec un autre ;
- ces instructions restent dans ce runbook, à la main : aucune migration, aucun rattrapage ni aucun fichier de
  maintenance ne coupe un déclencheur du registre ni ne déplace la séquence (invariants
  `fact-registry-append-only` et `hold-trigger-present-early`).

## Ce qui ne doit pas être fait

- Appliquer A2 ou A3 pendant un lot de publication.
- Appeler la route de la tâche à la main avec le secret, ou insérer un faux succès de la tâche.
- Retirer la colonne `held_fields` avant d'avoir rétabli la définition de `20261109140000` du journal des ventes.
- Rejouer un rattrapage qui écrit `auction_sales` avec `disable trigger user` : voir `supabase/repairs/README.md`.
- Écrire `held_fields`, insérer une décision ou un évènement à la main : seules les fonctions du registre le font.
