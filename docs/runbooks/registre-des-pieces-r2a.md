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
vaut 5 s, ramené à **1 s** juste avant les déclencheurs de A2 et de A3 : le verrou est libre, ou pris pour une
vingtaine de secondes par un lot de la collecte, et attendre plus ne ferait que mettre en attente tous les autres
écrivains de la table derrière la migration. Si un verrou n'est pas obtenu, cette migration échoue sans effet, les
précédentes restent appliquées, et il suffit de relancer le workflow. Chaque migration se rejoue sans dommage
(seconde application vérifiée : aucun ACCESS EXCLUSIVE sur une table).

Entre A2 et A3, `app_private.assert_fact_registry_triggers()` lève `registry_unavailable` (la garde du marqueur
est attendue, son déclencheur n'est créé que par A3). Rien ne l'appelle avant A7 : sans conséquence, sauf à lancer
à la main le rattrapage `20261029100200` ou le fichier de maintenance dans cet intervalle.

**A9 doit être appliquée avant le lot « collecte » qui passe les observations à la version 3.** Tant que la
collecte écrit une seule version, elle ne masque rien.

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
2. **Aucun lot de publication en cours** au moment de lancer le workflow (aucune ligne attendue) :

   ```sql
   select a.pid, a.application_name, now() - a.xact_start
   from pg_locks l join pg_stat_activity a using (pid)
   where l.relation = 'public.auction_sales'::regclass and l.mode = 'RowExclusiveLock' and l.granted;
   ```

3. **Un succès de la tâche de moins de 27 heures** (étape 2 de l'ordre de déploiement) :

   ```sql
   select status, finished_at from public.operational_job_runs
   where job_name = 'fact-registry-check' order by started_at desc limit 3;
   ```

4. **Mesures en lecture seule** (annexe 08, section F), à confier à `qualite-donnees` :
   - journaux vides et aucun champ tenu (F.1 : 0, 0, 0). Si un journal n'est pas vide, A1 refuse de s'appliquer
     (erreur `55000`, « fact registry journals are not empty ») : ne pas forcer, revenir vers le plan. Le format
     de `lot_ref` (A2) suppose lui aussi un journal des décisions vide ;
   - onze déclencheurs du registre en mode `A` avant le lot (F.2), douze après ;
   - **aucun doublon** d'identifiant de fait sur **toutes** les observations, y compris celles qui ne sont plus
     rattachées à une vente (F.8, sans filtre de vente), sinon l'index unique ne se construit pas :

     ```sql
     select evidence_locator->>'information_agent_fact_id', count(*) from public.auction_fact_claims
     where evidence_locator ? 'information_agent_fact_id' group by 1 having count(*) > 1;
     ```

   - nom de la contrainte de la colonne `event` (F.13) : `auction_sale_field_hold_events_event_check` attendu ;
     de même `auction_fact_claim_decisions_lot_ref_check` pour `lot_ref` ;
   - versions présentes dans les observations, pour A9 :

     ```sql
     select extractor_name, extractor_version, count(*) from public.auction_fact_claims
     where auction_sale_id is not null group by 1, 2;
     ```

## Vérifier après (lecture seule)

```sql
-- 1. Rien n'est tenu, rien n'est journalisé.
select (select count(*) from public.auction_sales where held_fields is not null) as ventes_du_registre,
       (select count(*) from public.auction_sale_field_hold_events) as evenements,
       (select count(*) from public.auction_fact_claim_decisions) as decisions;          -- 0, 0, 0

-- 2. Les deux journaux n'ont plus d'identité ; la séquence commune existe.
select attrelid::regclass, attidentity = '' as sans_identite, attnotnull
from pg_attribute where attname = 'seq' and attrelid in (
  'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass);
select last_value, is_called from app_private.fact_registry_seq;

-- 3. Douze déclencheurs en mode always, chacun sur sa fonction (tableau vide attendu), et les clauses WHEN de la
--    retenue, de la garde du marqueur et de la garde d'origine.
select app_private.fact_registry_triggers_not_always();
select pg_get_triggerdef(oid) from pg_trigger where tgname in (
  'aaab_auction_sales_hold_projected_fields', 'aaab_auction_sales_held_fields_marker_guard',
  'auction_fact_claims_registry_origin_guard');

-- 4. Une seule signature de la projection (quatre paramètres) ; la fonction d'alerte n'a aucun paramètre.
select proname, pg_get_function_identity_arguments(oid) from pg_proc
where proname in ('project_sale_fields', 'sync_fact_registry_alerts');

-- 5. Les deux index existent, sont valides, et leur opération est « applied ».
select relation.relname, index_row.indisvalid, index_row.indisunique
from pg_index index_row join pg_class relation on relation.oid = index_row.indexrelid
where relation.relname in ('auction_sales_held_fields_idx', 'auction_fact_claims_agent_fact_key');
select operation_key, status, last_error from app_private.concurrent_index_operations
where operation_key like '20261117100450:%';

-- 6. Le contrôle quotidien ne lève rien (dix lignes, toutes à false).
select key, value ->> 'active' as leve, value ->> 'count' as compte
from jsonb_each(public.check_fact_registry_consistency() -> 'checks');

-- 7. Les RPC de dérogation ne rendent plus la ligne.
select proname, prorettype::regtype from pg_proc
where proname in ('set_auction_sale_readiness_override', 'clear_auction_sale_readiness_override');

-- 8. La vue des observations garde son option et ses droits.
select reloptions from pg_class where oid = 'public.v_auction_fact_claims_read_model'::regclass;
```

Puis le coût : `explain` (sans `analyze`) de la lecture par vente de la vue, avant et après, et la durée des
imports. Attendu : inchangée. Sur le banc local (5 000 ventes dont aucune n'est tenue), le coût isolé de chaque
élément du lot placé sur le chemin de l'import est de 1 à 6 microsecondes par ligne, pour une erreur de mesure de 3
à 7 microsecondes : dans le bruit, et de l'ordre de 1 % d'une ligne au plus. Aucun déclencheur du registre n'est
appelé quand rien n'est tenu : pendant cet upsert, les quatre fonctions de déclencheur du registre comptent zéro
appel (`track_functions`), et le test 884 le prouve en remplaçant la fonction de retenue et celle de la garde du
marqueur par une fonction qui lève. À suivre ensuite : les alertes
`fact_registry.*` (aucune attendue) et le journal de la tâche `fact-registry-check` dans `operational_job_runs`.
**Critère pour le lot R2b** : contrôle quotidien à zéro sur deux passages qui portent `counts`, durée des imports
inchangée.

## Si quelque chose échoue

| Symptôme                                                                           | Cause                                                                                        | Que faire                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canceling statement due to lock timeout` sur `20261117100100` ou `20261117100200` | Un lot de la collecte écrivait `auction_fact_claims` ou `auction_sales`                      | Rien n'est appliqué de cette migration. Relancer le workflow entre deux lots (mesure 2). Si A2 est passée et pas A3, l'état est cohérent et inerte.                                    |
| `fact registry journals are not empty` sur `20261117100000`                        | Une décision ou un évènement existe déjà                                                     | Ne rien forcer. La séquence commune ne peut plus remplacer les identités sans décider de l'ordre des lignes existantes : revenir vers le plan.                                         |
| `violates check constraint "auction_fact_claim_decisions_lot_ref_check"`           | Une décision porte un libellé de lot hors format                                             | Même cause que la ligne précédente (journal non vide) : revenir vers le plan.                                                                                                          |
| `Operational health expected-jobs list changed` sur `20261117100600`               | La liste attendue de `cron.stale` a changé depuis la rédaction                               | Relire la définition en place, adapter la migration (nouvelle ancre), sans retirer d'entrée.                                                                                           |
| L'opération d'index `auction_fact_claims_agent_fact_key` passe à `failed`          | Doublons d'identifiant de fait (mesure F.8 non faite sur toutes les observations)            | L'index invalide est retiré au passage suivant du script. Traiter les doublons avec le plan, puis relancer `npm run db:indexes:concurrent`. Rien d'autre n'est touché.                 |
| La détection de dérive signale exactement une ligne `CREATE [UNIQUE] INDEX` du lot | L'outil imprime le prédicat sous une forme que `scripts/lib/schema-drift.mjs` ne prévoit pas | Les index sont vérifiés à part, mot pour mot, dans le catalogue (étape précédente, verte). Ajouter la forme imprimée aux tests de `check-supabase-schema-drift.test.mjs` et au filtre. |
| Alerte `cron.stale` pour `fact-registry-check`                                     | Les migrations ont été appliquées sans attendre un passage de la tâche                       | Attendre le passage suivant (05:28 UTC) : l'alerte se referme deux heures après le premier succès. Ne pas supprimer la ligne d'`operational_alerts`.                                   |
| La tâche répond `skipped` après les migrations                                     | PostgREST ne voit pas `sync_fact_registry_alerts`                                            | Étape 4 de l'ordre de déploiement.                                                                                                                                                     |
| La tâche échoue : « rapport partiel »                                              | Plus de 500 ventes candidates                                                                | Aucune alerte n'a été refermée. Le contrôle doit être paginé (reste du lot R2b) : revenir vers le plan.                                                                                |
| Alerte `fact_registry.triggers_not_always`                                         | Un `disable trigger user` puis `enable trigger user` a été joué sur une table du registre    | `supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql`, entre deux lots.                                                                                        |

## Retour arrière

Tant que `held_fields` est nulle partout et que les journaux sont vides (c'est le cas à ce lot), tout se retire
sans effet sur les fiches. Dans l'ordre inverse, chaque étape étant décrite en tête de sa migration :

1. A9 : réappliquer la définition de la vue de `20260929103000` (avec `security_invoker`, `revoke` et `grant`).
   Pas après le passage de la collecte à la version 3 : les observations s'afficheraient en double.
2. A8 : retirer l'entrée de la liste de `cron.stale` par le remplacement inverse (sinon l'alerte reste ouverte
   une fois la route retirée) ; retirer l'entrée de `vercel.json` et la route.
3. A7 : `drop function` des trois fonctions publiques, de
   `app_private.sync_fact_registry_alerts_from_report` et de `app_private.sale_field_value_leaks`.
4. A6 : `drop index concurrently` des deux index, puis supprimer les deux lignes de
   `app_private.concurrent_index_operations` et les deux entrées de la liste blanche du script.
5. A5 : rétablir les définitions de `20260919123000`.
6. A4 : rétablir la définition de `20261109140000`. **`held_fields` est une dépendance dure de toute écriture de
   vente** : le journal des ventes (A4) nomme la colonne à chaque `UPDATE` de `auction_sales`. Ne jamais retirer
   la colonne `held_fields` avant d'avoir rétabli `20261109140000`, sinon toutes les écritures de vente échouent.
7. A3, **entre deux lots** : supprimer le déclencheur `aaab_auction_sales_held_fields_marker_guard`, réappliquer
   les définitions de `20261116100500` (retenue, projection à trois paramètres, déclencheur et sa liste de
   colonnes), puis supprimer les cinq fonctions de la mémoire d'écho. **Plus possible dès qu'un champ est tenu
   ou libéré** : la retenue du lot R1 ne connaît pas l'état `released`.
8. A2, **entre deux lots** : rétablir les deux gardes et le déclencheur d'origine de `20261116100100` et
   `20261116100500`, supprimer les deux fonctions de contrôle et la fonction de la garde du marqueur ; ne
   rétablir les anciennes contraintes de `event` et de `lot_ref` que si aucun évènement `echo_suppressed`
   n'existe.
9. A1, journaux vides seulement : rétablir les deux fonctions de `20261116100000`, puis
   `alter column seq add generated always as identity` sur les deux tables et `drop sequence`.

Un retour arrière partiel est sans danger dans cet ordre. Ne jamais retirer les déclencheurs du lot R1 tant
qu'une vente a `held_fields` non nulle.

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

-- 3. Après : remettre les trois déclencheurs en mode always, reposer la séquence commune sur le plus grand seq
--    des deux journaux, puis le contrôle, qui fait échouer la transaction s'il manque quelque chose.
begin;
set local lock_timeout = '5s';
alter table public.auction_sales enable always trigger aaab_auction_sales_held_fields_insert_guard;
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_validate;
alter table public.auction_sale_field_hold_events enable always trigger auction_sale_field_hold_events_stamp;
select setval('app_private.fact_registry_seq', greatest(
  (select coalesce(max(seq), 0) from public.auction_fact_claim_decisions),
  (select coalesce(max(seq), 0) from public.auction_sale_field_hold_events),
  1), true);
select app_private.assert_fact_registry_triggers();
commit;
```

Résultat de l'essai : `held_fields`, les deux journaux (`seq` et dates compris) identiques à la source ; une
nouvelle décision prend un numéro au-dessus de tous les autres ; la simulation de la projection ne changerait
aucune vente ; le contrôle quotidien lève les mêmes contrôles que sur la source.

À savoir :

- ne jamais employer `disable trigger user` puis `enable trigger user` : le second ordre sort tous les
  déclencheurs du registre du mode `always`, sans aucune erreur ;
- les deux autres déclencheurs de chaque journal (ajout seul, pas de `TRUNCATE`) et les gardes de mise à jour de
  `auction_sales` ne gênent pas une restauration : ils ne jouent que sur `UPDATE`, `DELETE` et `TRUNCATE` ;
- pendant la fenêtre, une acceptation ne serait plus validée et un évènement ne serait plus numéroté : ne rien
  laisser écrire le registre (aucune décision, aucun import) entre les étapes 1 et 3 ;
- ces instructions restent dans ce runbook, à la main : aucune migration, aucun rattrapage ni aucun fichier de
  maintenance ne coupe un déclencheur du registre ni ne déplace la séquence (invariants
  `fact-registry-append-only` et `hold-trigger-present-early`).

## Ce qui ne doit pas être fait

- Appliquer A2 ou A3 pendant un lot de publication.
- Appeler la route de la tâche à la main avec le secret, ou insérer un faux succès de la tâche.
- Retirer la colonne `held_fields` avant d'avoir rétabli la définition de `20261109140000` du journal des ventes.
- Rejouer un rattrapage qui écrit `auction_sales` avec `disable trigger user` : voir `supabase/repairs/README.md`.
- Écrire `held_fields`, insérer une décision ou un évènement à la main : seules les fonctions du registre le font.
