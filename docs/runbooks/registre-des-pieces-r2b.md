# Registre des pièces : appliquer le lot R2b (fonctions de décision, fusion, relance)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md`, section 10. Architecture :
`docs/architecture/registre-des-pieces.md`. Runbook du lot précédent : `docs/runbooks/registre-des-pieces-r2a.md`.

Ce lot ne change aucune fiche. Les fonctions de décision existent **sans aucun droit d'exécution** : personne ne
peut écrire une décision avant le lot R2c. Sans décision, aucune vente ne tient de champ, la fusion ne reporte rien
et la relance planifiée ne fait rien.

**Préalable : le lot R2a est appliqué et contrôlé.** Les neuf migrations `20261117100000` à `20261117100700` sont
en production, les deux index sont construits, et les contrôles A1 à A5 du runbook R2a ont donné le résultat
attendu. Sinon, ne pas appliquer ce lot.

## Ce qui est appliqué

| Ordre | Migration                                                   | Contenu                                                                                                      | Verrou le plus fort                                                                               | Pendant un lot de publication |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| B0    | `20261118100000_field_projection_merge_hints`               | Projection : indice de fusion sans gagnant, mémoire de l'indice, stabilité                                   | Aucun (remplacement d'une fonction)                                                               | Oui                           |
| B1    | `20261118100100_fact_claim_decision_rpcs`                   | Verrou de la vente, fonction de décision, quatre fonctions publiques sans droit, `review_auction_fact_claim` | Aucun (fonctions)                                                                                 | Oui                           |
| B2    | `20261118100200_carry_registry_on_sale_merge`               | La fusion reporte le journal des publications et reprojette la vente conservée                               | Aucun (remplacement d'une fonction ; le déclencheur n'est pas touché)                             | **Non**                       |
| B3    | `20261118100300_fact_registry_check_pages_and_reprojection` | Contrôle quotidien paginé, relance planifiée fermée, son interrupteur, évènement `drift_reprojected`         | ACCESS EXCLUSIVE bref sur `auction_sale_field_hold_events` (vide), première application seulement | Oui                           |

Verrous relevés sur base jetable, avant chaque `COMMIT`, hors lecture : aucun pour B0, B1 et B2 ; pour B3, la file
d'évènements (ACCESS EXCLUSIVE à la première application, SHARE UPDATE EXCLUSIVE à la seconde, pour le commentaire
de table) et la nouvelle table de réglage. **Aucune migration du lot ne prend de verrou sur `auction_sales` ni sur
`auction_fact_claims`.** `lock_timeout` vaut 5 s, ramené à 2 s dans B3 avant la contrainte de la file d'évènements.
Chaque migration est sa propre transaction et se rejoue sans dommage.

Le workflow « Apply Supabase Migrations » applique tout ce qui est en attente, dans l'ordre. **À lancer entre deux
lots de publication de la collecte**, à cause de B2 : une fusion en cours changerait de fonction en route. Aucun
index n'est construit par ce lot.

## Ce qui change dès l'application, sans attendre le lot R2c

Le lot est inerte pour le registre, mais deux fonctions déjà en service sont retouchées.

- **`public.review_auction_fact_claim`** (relecture des observations de la collecte, écran d'administration). Elle
  verrouille désormais la vente avant l'observation, sous un délai de 3 secondes. Pendant un lot de publication
  qui tient cette vente (20 à 29 secondes), l'administrateur reçoit l'erreur `55P03`, message `sale_busy`, au lieu
  d'attendre : il réessaie. Elle refuse aussi une observation d'origine professionnelle et une observation déjà
  décidée au journal du registre (aucune n'existe en production à ce jour).
- **`public.sync_fact_registry_alerts()`** (tâche `fact-registry-check`). Elle enchaîne les pages du contrôle. Son
  rapport garde la forme attendue par la tâche ; il porte deux clés de plus, `pages` et `reprojection`, que la
  tâche ne recopie pas encore dans `operational_job_runs.summary` (lot TypeScript à venir).

## Relance planifiée de la projection

La projection lit des colonnes que la retenue ne tient pas. Un reclassement en terrain (`property_type`,
`surface_scope`) ou une écriture de `bedrooms_count` par la collecte change ce qu'elle déciderait. Deux relances,
et aucun déclencheur :

1. toute décision d'administrateur reprojette la vente entière ;
2. la tâche quotidienne `fact-registry-check` appelle `app_private.reproject_drifted_sales(50)` avant le contrôle.

**Le point 2 est une écriture de fiche lancée par une tâche planifiée.** Elle ne fait que réappliquer des décisions
humaines déjà acceptées : aucune décision n'est écrite, le mode de publication reste `manual`, les verrous
`auction_fact_claim_decisions_auto_locked` et `auction_fact_claim_decisions_accepted_by_admin` ne bougent pas.

- **Fermée par défaut.** Réglage : table `app_private.fact_registry_switches`, ligne `scheduled_reprojection`,
  `enabled = false`. Une ligne absente vaut « fermé ».
- **Ouvrir ou refermer, sans migration de code**, par le propriétaire, avec le rôle de migration :

  ```sql
  select app_private.set_fact_registry_scheduled_reprojection(true);   -- ouvrir
  select app_private.set_fact_registry_scheduled_reprojection(false);  -- refermer
  ```

  Aucun agent ne lance ces instructions en production. Un invariant de sécurité refuse une migration qui ouvrirait
  l'interrupteur.

- **Sans effet** tant que le journal des décisions est vide, et quand un déclencheur du registre manque.
- **Bornée** : 50 ventes par passage. Les suivantes sont comptées (`deferred`) et reprises au passage suivant. Une
  vente tenue par un lot de la collecte est comptée (`busy`) et reprise au passage suivant ; après trois ventes
  occupées, le reste de la passe est reporté. Une vente dont la projection échoue est comptée (`failed`) sans
  arrêter la passe.
- **Journalisée** : un évènement `drift_reprojected` par champ dont l'entrée a changé, dans
  `auction_sale_field_hold_events`.
- **Fermée, ou vente non appliquée** : le contrôle qui suit lève l'alerte critique
  `fact_registry.projection_drift`, comme au lot R2a.

Lire le compte rendu d'un passage (en attendant le lot TypeScript) :

```sql
select sale_id, field_key, held_value, decision_id, created_at
from public.auction_sale_field_hold_events
where event = 'drift_reprojected'
order by seq desc
limit 50;
```

## Avant

Mesures en lecture seule, à confier à `qualite-donnees`. **Si une mesure ne donne pas le résultat attendu, ne pas
appliquer et revenir vers le plan.**

### P1. Le lot R2a est en place

Attendu : sept lignes. Puis refaire les contrôles A1 à A5 du runbook R2a.

```sql
select namespace.nspname, routine.proname, routine.pronargs
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'app_private' and routine.proname in (
         'project_sale_fields', 'assert_fact_registry_triggers', 'fact_registry_triggers_not_always',
         'sync_fact_registry_alerts_from_report'))
   or (namespace.nspname = 'public' and routine.proname in (
         'check_fact_registry_consistency', 'sync_fact_registry_alerts', 'get_sale_field_baselines'))
order by 1, 2;
```

`project_sale_fields` doit compter 4 arguments, `check_fact_registry_consistency` 1 (B3 le remplace par une
fonction à 2 arguments).

### P2. Toujours inerte

Attendu : 0, 0, 0, 0.

```sql
select
  (select count(*) from public.auction_fact_claim_decisions) as decisions,
  (select count(*) from public.auction_sale_field_hold_events) as evenements,
  (select count(*) from public.auction_sales where held_fields is not null) as ventes_du_registre,
  (select count(*) from public.information_agent_fact_publications) as publications;
```

Si un des trois premiers comptes n'est pas nul, le lot R2c a commencé ou une écriture a eu lieu hors plan : ne pas
appliquer.

### P3. Nom et validité de la contrainte recréée par B3

Attendu : une ligne, `convalidated` à `true`.

```sql
select constraint_row.conname, constraint_row.convalidated
from pg_constraint constraint_row
join pg_class relation on relation.oid = constraint_row.conrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'auction_sale_field_hold_events'
  and constraint_row.conname = 'auction_sale_field_hold_events_event_check';
```

### P4. Un seul propriétaire

Attendu : une ligne. Les nouvelles fonctions sont créées par le rôle de migration ; il doit être le propriétaire de
la projection, de la fonction de fusion et de la fonction de relecture.

```sql
select distinct owner.rolname
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
join pg_roles owner on owner.oid = routine.proowner
where (namespace.nspname = 'app_private'
       and routine.proname in ('project_sale_fields', 'carry_sale_user_data_to_merged_sale'))
   or (namespace.nspname = 'public' and routine.proname = 'review_auction_fact_claim');
```

### P5. Fenêtre libre, juste avant de lancer le workflow

Attendu : aucune ligne. Aucun lot de publication en cours (B2), aucune transaction sur la file d'évènements (B3).

```sql
select activity.pid, activity.state, activity.xact_start, left(activity.query, 80) as requete
from pg_stat_activity activity
where activity.datname = current_database()
  and activity.pid <> pg_backend_pid()
  and activity.xact_start is not null
  and (activity.query ilike '%auction_sales%' or activity.query ilike '%auction_sale_field_hold_events%');
```

### P6. La tâche quotidienne tourne

Attendu : un succès de moins de 27 heures.

```sql
select status, finished_at
from public.operational_job_runs
where job_name = 'fact-registry-check'
order by started_at desc
limit 3;
```

## Vérifier après (lecture seule)

### A1. Les fonctions du lot, leur mode de sécurité

Attendu : treize lignes. `prosecdef` à `true` partout sauf `lock_sale_for_registry`,
`set_fact_registry_scheduled_reprojection` et `fact_registry_report_add_page` ; `proconfig` égal à
`{search_path=""}` partout ; `check_fact_registry_consistency` compte 2 arguments.

```sql
select namespace.nspname, routine.proname, routine.pronargs, routine.prosecdef, routine.proconfig
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'app_private' and routine.proname in (
         'decide_auction_fact_claim', 'lock_sale_for_registry', 'reproject_drifted_sales',
         'fact_registry_candidate_sales', 'fact_registry_report_add_page',
         'set_fact_registry_scheduled_reprojection', 'carry_sale_user_data_to_merged_sale'))
   or (namespace.nspname = 'public' and routine.proname in (
         'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
         'oppose_auction_fact_claim', 'check_fact_registry_consistency', 'sync_fact_registry_alerts'))
order by 1, 2;
```

### A2. Aucun droit d'exécution ouvert

Attendu : deux lignes, `check_fact_registry_consistency` et `sync_fact_registry_alerts` pour `service_role`. Toute
autre ligne est un droit ouvert par erreur : le retirer par une migration avant toute autre chose.

```sql
select namespace.nspname, routine.proname, api_role.rolname
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) api_role
where ((namespace.nspname = 'app_private' and routine.proname in (
          'decide_auction_fact_claim', 'lock_sale_for_registry', 'reproject_drifted_sales',
          'fact_registry_candidate_sales', 'fact_registry_report_add_page',
          'set_fact_registry_scheduled_reprojection', 'carry_sale_user_data_to_merged_sale'))
    or (namespace.nspname = 'public' and routine.proname in (
          'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
          'oppose_auction_fact_claim', 'check_fact_registry_consistency', 'sync_fact_registry_alerts')))
  and has_function_privilege(api_role.rolname, routine.oid, 'EXECUTE')
order by 1, 2, 3;
```

### A3. La relance planifiée est fermée

Attendu : une ligne, `enabled` à `false`.

```sql
select switch_name, enabled, updated_at, updated_by from app_private.fact_registry_switches;
```

### A4. La file d'évènements admet `drift_reprojected`

Attendu : une ligne.

```sql
select constraint_name
from information_schema.check_constraints
where constraint_schema = 'public'
  and constraint_name = 'auction_sale_field_hold_events_event_check'
  and check_clause like '%drift_reprojected%';
```

### A5. Toujours inerte, déclencheurs en place

Attendu : la requête P2 rend 0, 0, 0, 0 ; les contrôles A1 et A2 du runbook R2a (douze déclencheurs en mode
`always`, tableau vide) donnent le même résultat qu'avant ; le déclencheur de fusion est inchangé (une ligne,
`tgenabled` à `O`) :

```sql
select trigger_row.tgname, trigger_row.tgenabled
from pg_trigger trigger_row
join pg_class relation on relation.oid = trigger_row.tgrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'auction_sales'
  and trigger_row.tgname = 'auction_sales_carry_sale_user_data';
```

### A6. Au passage suivant de la tâche

Attendu : `status` à `success`, les dix contrôles dans `summary`, aucune alerte `fact_registry.*` ouverte. Une
réponse `skipped` veut dire que PostgREST ne voit pas la fonction : recharger le schéma
(`notify pgrst, 'reload schema';`) et vérifier le passage suivant.

```sql
select status, finished_at, summary
from public.operational_job_runs
where job_name = 'fact-registry-check'
order by started_at desc
limit 1;

select alert_key, status, last_seen_at
from public.operational_alerts
where alert_key like 'fact\_registry.%' and status = 'open';
```

## Si quelque chose échoue

- **Une migration échoue sur un verrou** (`55P03`) : elle n'a rien changé, les précédentes restent appliquées.
  Relancer le workflow entre deux lots de publication.
- **B3 échoue sur la contrainte** : un évènement d'un type inconnu existe dans la file. Ne pas forcer ; relever les
  types présents (`select event, count(*) from public.auction_sale_field_hold_events group by event;`).
- **La tâche échoue après B3** avec un rapport illisible ou tronqué : le registre compte plus de 20 000 ventes, ou
  la fonction a changé de forme. Aucune alerte n'a été refermée. Revenir vers le plan.
- **Une fusion de la collecte échoue après B2** avec une erreur de la projection : la suppression est annulée,
  rien n'est perdu. Relever l'erreur et la vente, ne pas contourner par une suppression à la main.

## Retour arrière

Toujours par une nouvelle migration, jamais par une modification à la main. Tant qu'aucun droit n'a été ouvert et
qu'aucune décision n'existe, chaque retour est sans effet sur les fiches. Ordre inverse de l'application :

1. **B3** : refermer la relance suffit à en retirer l'effet. Pour revenir aux définitions du lot R2a : rétablir
   `public.sync_fact_registry_alerts()` et `public.check_fact_registry_consistency(integer)` de `20261117100500`
   en supprimant la signature à deux arguments, puis supprimer `app_private.reproject_drifted_sales(integer)`,
   `app_private.fact_registry_report_add_page(jsonb, jsonb)`, `app_private.fact_registry_candidate_sales()`,
   `app_private.set_fact_registry_scheduled_reprojection(boolean)` et `app_private.fact_registry_switches`. La
   valeur `drift_reprojected` reste admise par la contrainte.
2. **B2** : rétablir `app_private.carry_sale_user_data_to_merged_sale()` de `20261029150000`, entre deux lots de
   publication.
3. **B1** : supprimer les quatre fonctions publiques et `app_private.decide_auction_fact_claim`, rétablir
   `public.review_auction_fact_claim` de `20260928180000`, puis supprimer `app_private.lock_sale_for_registry`.
4. **B0** : rétablir `app_private.project_sale_fields` de `20261117100200`, après le retour de B2.

Dès qu'une décision existe (après le lot R2c), ne plus revenir sur B0 ni sur B2 : les journaux sont gardés, et le
retour se fait par retrait des pièces, comme le prévoit le plan pour la bascule.

## Essais à deux sessions (base jetable, rejoués pour ce lot)

| Cas                                                                                                                  | Résultat                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un lot de la collecte tient la vente, l'administrateur accepte                                                       | `sale_busy` après 3,0 s, aucune décision écrite ; la même acceptation passe dès la fin du lot                                                                                    |
| L'administrateur accepte sans valider, la collecte écrit la vente                                                    | L'écriture attend, puis la retenue garde la valeur tenue                                                                                                                         |
| Fusion par le repli REST : la suppression tient la vente absorbée et attend la vente conservée, tenue par un lot SQL | Si le lot demande ensuite la vente absorbée, PostgreSQL détecte l'interblocage en 1 s et annule l'une des deux transactions (dans l'essai : le lot SQL), sans écriture partielle |
| Même fusion, le lot SQL ne demande pas la vente absorbée                                                             | La suppression attend la fin du lot, puis la vente conservée tient la pièce                                                                                                      |

Le repli REST n'est pas le chemin de production (le workflow de la collecte exige la connexion SQL). Dans le
chemin SQL, le lot tient déjà les deux ventes quand il supprime l'absorbée : aucune attente.

## Non fait à ce lot, et à quelle condition

| Sujet                                                                                         | Condition                                                                                                  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Retirer les copies (`properties`, `auction_surfaces`, `judicial_sales`) du contrôle quotidien | L'étape PB de la collecte est en production : ces copies ne reçoivent plus les colonnes du registre        |
| Index partiel de la liste de relecture d'administration                                       | Le contrôle A4 du runbook R2a, mesuré en production, montre un écart de plus de 100 ms                     |
| Retirer la tolérance `skipped: migration_pending` ; réduire le message d'erreur de la tâche   | Lot TypeScript, après l'application du lot R2a                                                             |
| Recopier `pages` et `reprojection` dans le résumé de la tâche                                 | Même lot TypeScript                                                                                        |
| Droits d'exécution des quatre fonctions de décision ; lecture pour l'écran de relecture       | Lot R2c, après vérification du second facteur des administrateurs                                          |
| Levée du blocage après une opposition                                                         | Décision du propriétaire et d'un juriste, avant qu'une pièce d'occupation ou de pièces puisse être opposée |
| Ouverture de la relance planifiée                                                             | Décision du propriétaire, avant le lot R2c                                                                 |

## Passer au lot R2c

Conditions du plan (section 10) : indicateur d'écho à zéro en production ; répétition complète sur base jetable
(import, pose, retrait, fusion) ; second facteur des administrateurs enrôlé et exigé. S'y ajoute la décision du
propriétaire sur la relance planifiée (ouverte ou fermée le jour de la bascule).

## Ce qui ne doit pas être fait

- Donner un droit d'exécution sur une fonction de décision avant le lot R2c.
- Appeler la route `/api/cron/fact-registry-check` à la main, lire `CRON_SECRET`, ou insérer un faux succès dans
  `operational_job_runs`.
- Ouvrir la relance planifiée sans la décision du propriétaire.
- Écrire à la main dans `auction_fact_claim_decisions`, `auction_sale_field_hold_events` ou
  `app_private.fact_registry_switches`.
