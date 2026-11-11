# Registre des pièces : appliquer le lot R2a (durcissement, inerte)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md`, section 10. Architecture :
`docs/architecture/registre-des-pieces.md`. Ce lot ne change aucune fiche : aucun champ n'est tenu, aucune décision
n'est écrite, rien n'appelle la projection.

## Ce qui est appliqué

| Ordre | Migration                                          | Contenu                                                                                | Verrou le plus fort                                                            | Pendant un import     |
| ----- | -------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------- |
| A1    | `20261117100000_fact_registry_common_sequence`     | Séquence commune aux deux journaux                                                     | ACCESS EXCLUSIVE sur les deux journaux (vides), première application seulement | Possible, déconseillé |
| A2    | `20261117100100_fact_registry_guards`              | Gardes par rôle en liste blanche, contrôle du mode des déclencheurs, `echo_suppressed` | ACCESS EXCLUSIVE bref sur la file d'évènements (vide), première application    | Possible              |
| A3    | `20261117100200_field_hold_and_projection_v2`      | Retenue et projection en version 2                                                     | **SHARE ROW EXCLUSIVE sur `auction_sales`** (jamais ACCESS EXCLUSIVE)          | **Non**               |
| A4    | `20261117100300_sale_history_skips_held_fields`    | L'historique des ventes ignore `held_fields`                                           | Aucun                                                                          | Oui                   |
| A5    | `20261117100400_readiness_override_rpcs_summary`   | Les deux RPC de dérogation rendent six clés                                            | Aucun                                                                          | Oui                   |
| A6    | `20261117100450_fact_registry_concurrent_indexes`  | Enregistre deux index, construits ensuite hors transaction                             | Aucun dans la migration ; SHARE UPDATE EXCLUSIVE pendant la construction       | Possible, plus lent   |
| A7    | `20261117100500_fact_registry_baselines_and_check` | Valeurs d'annonce pour la fusion, contrôle quotidien, alertes                          | Aucun                                                                          | Oui                   |
| A8    | `20261117100600_cron_stale_fact_registry_check`    | La tâche `fact-registry-check` entre dans la liste de `cron.stale` (27 h)              | Aucun                                                                          | Oui                   |

Le workflow « Apply Supabase Migrations » applique tout ce qui est en attente, dans l'ordre, puis construit les
index (« Apply reviewed concurrent index operations ») et contrôle la dérive de schéma. **À lancer entre deux
imports**, à cause de A3. Chaque migration est sa propre transaction, avec `lock_timeout = 5s` : si un verrou
n'est pas obtenu, cette migration échoue sans effet, les précédentes restent appliquées, et il suffit de relancer
le workflow. Chaque migration se rejoue sans dommage (seconde application vérifiée : aucun ACCESS EXCLUSIVE).

## Avant

1. **Observation du lot R1 terminée** (pas avant le 12/11/2026 à 11:45 UTC) et propre.
2. **Mesures en lecture seule** (annexe 08, section F), à confier à `qualite-donnees` :
   - journaux vides et aucun champ tenu (F.1 : 0, 0, 0). Si un journal n'est pas vide, A1 refuse de s'appliquer
     (erreur `55000`, « fact registry journals are not empty ») : ne pas forcer, revenir vers le plan ;
   - onze déclencheurs du registre en mode `A` (F.2) ;
   - **aucun doublon** d'identifiant de fait dans les observations (F.8), sinon l'index unique ne se construit pas :

     ```sql
     select evidence_locator->>'information_agent_fact_id', count(*) from public.auction_fact_claims
     where evidence_locator ? 'information_agent_fact_id' group by 1 having count(*) > 1;
     ```

   - nom de la contrainte de la colonne `event` (F.13) : `auction_sale_field_hold_events_event_check` attendu.

3. **Code déployé d'abord** : la route `/api/cron/fact-registry-check` doit être en ligne avant les migrations.
   Avant A7, la tâche réussit sans rien contrôler (`skipped: migration_pending`).

## Application

1. Fusionner, attendre le déploiement Vercel et la CI verte du commit.
2. Entre deux imports, lancer le workflow « Apply Supabase Migrations » (`confirm_target: production`).
3. Juste après, appeler la route une fois : `GET /api/cron/fact-registry-check` avec
   `Authorization: Bearer $CRON_SECRET`. Sans cet appel, `cron.stale` ouvre une alerte **critique** pour
   `fact-registry-check` au passage suivant d'`operational-health` (la tâche n'a encore aucun succès), sauf si la
   route a déjà réussi dans les 27 heures. L'alerte se referme d'elle-même deux heures après le premier succès :
   ne pas supprimer la ligne d'`operational_alerts` (`docs/operations/planification.md`).

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

-- 3. Onze déclencheurs en mode always (tableau vide attendu), et la nouvelle liste de colonnes de la retenue.
select app_private.fact_registry_triggers_not_always();
select pg_get_triggerdef(oid) from pg_trigger where tgname = 'aaab_auction_sales_hold_projected_fields';

-- 4. Une seule signature de la projection (quatre paramètres).
select pg_get_function_identity_arguments(oid) from pg_proc
where pronamespace = 'app_private'::regnamespace and proname = 'project_sale_fields';

-- 5. Les deux index sont construits et valides.
select operation_key, status, last_error from app_private.concurrent_index_operations
where operation_key like '20261117100450:%';

-- 6. Le contrôle quotidien ne lève rien.
select key, value ->> 'active' as leve, value ->> 'count' as compte
from jsonb_each(public.check_fact_registry_consistency() -> 'checks');

-- 7. Les RPC de dérogation ne rendent plus la ligne.
select proname, prorettype::regtype from pg_proc
where proname in ('set_auction_sale_readiness_override', 'clear_auction_sale_readiness_override');
```

À suivre ensuite : la durée des imports (inchangée attendue : sur le banc local, 5 000 ventes dont aucune n'est
tenue, l'écart reste dans le bruit, le coût isolé des trois éléments du lot qui sont sur le chemin de l'import
est de 0 à 7 microsecondes près par ligne, et aucun déclencheur du registre n'est appelé quand rien n'est tenu) ;
les alertes `fact_registry.*` (aucune attendue) ;
le journal de la tâche `fact-registry-check` dans `operational_job_runs`. **Critère pour le lot R2b** : contrôle
quotidien à zéro sur deux passages, durée des imports inchangée.

## Si quelque chose échoue

| Symptôme                                                                           | Cause                                                                                        | Que faire                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canceling statement due to lock timeout` sur `20261117100200`                     | Un import écrivait `auction_sales`                                                           | Rien n'est appliqué de cette migration. Relancer le workflow hors import.                                                                                                              |
| `fact registry journals are not empty` sur `20261117100000`                        | Une décision ou un évènement existe déjà                                                     | Ne rien forcer. La séquence commune ne peut plus remplacer les identités sans décider de l'ordre des lignes existantes : revenir vers le plan.                                         |
| `Operational health expected-jobs list changed` sur `20261117100600`               | La liste attendue de `cron.stale` a changé depuis la rédaction                               | Relire la définition en place, adapter la migration (nouvelle ancre), sans retirer d'entrée.                                                                                           |
| L'opération d'index `auction_fact_claims_agent_fact_key` passe à `failed`          | Doublons d'identifiant de fait (mesure F.8 non faite)                                        | L'index invalide est retiré au passage suivant du script. Traiter les doublons avec le plan, puis relancer `npm run db:indexes:concurrent`. Rien d'autre n'est touché.                 |
| La détection de dérive signale exactement une ligne `CREATE [UNIQUE] INDEX` du lot | L'outil imprime le prédicat sous une forme que `scripts/lib/schema-drift.mjs` ne prévoit pas | Les index sont vérifiés à part, mot pour mot, dans le catalogue (étape précédente, verte). Ajouter la forme imprimée aux tests de `check-supabase-schema-drift.test.mjs` et au filtre. |
| Alerte `cron.stale` pour `fact-registry-check`                                     | La route n'a pas été appelée après la migration, ou n'est pas déployée                       | Étape 3 de l'application.                                                                                                                                                              |
| Alerte `fact_registry.triggers_not_always`                                         | Un `disable trigger user` puis `enable trigger user` a été joué sur une table du registre    | `supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql`, hors import.                                                                                            |

## Retour arrière

Tant que `held_fields` est nulle partout et que les journaux sont vides (c'est le cas à ce lot), tout se retire
sans effet sur les fiches. Dans l'ordre inverse, chaque étape étant décrite en tête de sa migration :

1. A8 : retirer l'entrée de la liste de `cron.stale` par le remplacement inverse (sinon l'alerte reste ouverte
   une fois la route retirée) ; retirer l'entrée de `vercel.json` et la route.
2. A7 : `drop function` des trois fonctions publiques et de `app_private.sale_field_value_leaks`.
3. A6 : `drop index concurrently` des deux index, puis supprimer les deux lignes de
   `app_private.concurrent_index_operations` et les deux entrées de la liste blanche du script.
4. A5, A4 : rétablir les définitions de `20260919123000` et de `20261109140000`.
5. A3, **hors import** : réappliquer les définitions de `20261116100500` (retenue, projection à trois
   paramètres, déclencheur et sa liste de colonnes), puis supprimer les cinq fonctions de la mémoire d'écho.
   **Plus possible dès qu'un champ est tenu ou libéré** : la retenue du lot R1 ne connaît pas l'état `released`.
6. A2 : rétablir les deux gardes de `20261116100100` et `20261116100500`, supprimer les deux fonctions de
   contrôle ; ne rétablir l'ancienne contrainte de `event` que si aucun évènement `echo_suppressed` n'existe.
7. A1, journaux vides seulement : rétablir les deux fonctions de `20261116100000`, puis
   `alter column seq add generated always as identity` sur les deux tables et `drop sequence`.

Un retour arrière partiel est sans danger dans cet ordre. Ne jamais retirer les déclencheurs du lot R1 tant
qu'une vente a `held_fields` non nulle.

## Restauration de données seules

- Les trois déclencheurs `aaab_` de `auction_sales` sont en mode `always` : ils jouent aussi en
  `session_replication_role = replica`. La garde d'insertion refuse une vente restaurée avec `held_fields` non
  nulle. Sur la base cible, retirer ces trois déclencheurs avant la restauration, puis les recréer par les
  instructions de `20261117100200` (retenue) et de `20261116100500` (les deux gardes), et terminer par
  `select app_private.assert_fact_registry_triggers();`.
- Après la restauration, la séquence commune doit repartir au-dessus du plus grand `seq` des deux journaux,
  sinon l'ordre entre une décision et un évènement serait faux :

  ```sql
  select setval('app_private.fact_registry_seq', greatest(
    (select coalesce(max(seq), 0) from public.auction_fact_claim_decisions),
    (select coalesce(max(seq), 0) from public.auction_sale_field_hold_events)) + 1, false);
  ```

  À la main seulement : aucune migration ni aucun rattrapage ne déplace cette séquence (invariant
  `fact-registry-append-only`).

## Ce qui ne doit pas être fait

- Appliquer A3 pendant un import.
- Rejouer un rattrapage qui écrit `auction_sales` avec `disable trigger user` : voir `supabase/repairs/README.md`.
- Écrire `held_fields`, insérer une décision ou un évènement à la main : seules les fonctions du registre le font.
