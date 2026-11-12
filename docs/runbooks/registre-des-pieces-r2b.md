# Registre des pièces : appliquer le lot R2b (fonctions de décision, fusion, relance)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md`, section 10. Architecture :
`docs/architecture/registre-des-pieces.md`. Runbook du lot précédent : `docs/runbooks/registre-des-pieces-r2a.md`.

Ce lot ne change aucune fiche. Les fonctions de décision existent **sans aucun droit d'exécution** : personne ne
peut écrire une décision avant le lot R2c. Sans décision, aucune vente ne tient de champ, la fusion ne reporte rien
et la relance planifiée ne fait rien.

**Préalable : le lot R2a est appliqué et contrôlé** (fait le 12/11/2026 à 08:50 UTC). Les neuf migrations
`20261117100000` à `20261117100700` sont en production, les deux index sont construits, et les contrôles A1 à A5 du
runbook R2a ont donné le résultat attendu. Sinon, ne pas appliquer ce lot.

## Ce qui est appliqué

| Ordre | Migration                                                   | Contenu                                                                                                                                                         | Verrou le plus fort                                                                               | Pendant un lot de publication |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| B0    | `20261118100000_field_projection_merge_hints`               | Projection : indice de fusion sans gagnant, contamination exacte, pièce reportée (`merge_carried`) ; définition unique de la vente de terrain ; deux évènements | ACCESS EXCLUSIVE bref sur `auction_sale_field_hold_events` (vide), première application seulement | Oui                           |
| B1    | `20261118100100_fact_claim_decision_rpcs`                   | Réglages du registre, verrou de la vente, fonction de décision, quatre fonctions publiques sans droit, `review_auction_fact_claim`, origine « document » fermée | Aucun sur une table existante (fonctions, nouvelle table de réglage, cinq lignes de préséance)    | Oui                           |
| B2    | `20261118100200_carry_registry_on_sale_merge`               | La fusion reporte le journal des publications et reprojette la vente conservée                                                                                  | Aucun (remplacement d'une fonction ; le déclencheur n'est pas touché)                             | **Non**                       |
| B3    | `20261118100300_fact_registry_check_pages_and_reprojection` | Contrôle quotidien par pages, contrôles généraux calculés une fois, relance planifiée fermée (appel à part), onzième contrôle                                   | Aucun (fonctions, une ligne de réglage)                                                           | Oui                           |

**Aucune migration du lot ne prend de verrou sur `auction_sales` ni sur `auction_fact_claims`.** `lock_timeout`
vaut 5 s, ramené à 2 s dans B0 avant la contrainte de la file d'évènements. Chaque migration est sa propre
transaction et se rejoue sans dommage (seconde application : aucun ACCESS EXCLUSIVE sur une table existante).

Le workflow « Apply Supabase Migrations » applique tout ce qui est en attente, dans l'ordre. **À lancer entre deux
lots de publication de la collecte**, à cause de B2 : une fusion en cours changerait de fonction en route. Aucun
index n'est construit par ce lot.

## Ordre de déploiement

1. **Fusionner**, attendre le déploiement Vercel et la CI verte. Le code tolère l'absence des fonctions du lot : la
   tâche `fact-registry-check` appelle `reproject_fact_registry_drift` puis `sync_fact_registry_alerts` ; tant que
   la première n'existe pas, son résumé porte `reprojection: { skipped: "migration_pending" }` et le contrôle
   tourne comme au lot R2a.
2. **Appliquer les migrations** entre deux lots de publication.
3. **Au passage suivant de la tâche**, vérifier le contrôle A8.

## Ce qui change dès l'application, sans attendre le lot R2c

Le lot est inerte pour le registre, mais deux choses déjà en service changent.

- **`public.review_auction_fact_claim`** (relecture des observations de la collecte, écran d'administration). Elle
  verrouille désormais la vente avant l'observation, chaque attente de verrou étant bornée à 3 secondes. Pendant
  un lot de publication qui tient cette vente (20 à 29 secondes), la base rend l'erreur `55P03` au lieu d'attendre,
  et `40001` si une fusion est en cours. La route `/api/admin/fact-claims/review` traduit ces deux codes en une
  réponse 409 : « Import en cours sur cette vente, réessayez dans une minute. » L'administrateur réessaie. La
  fonction refuse aussi une observation d'origine réservée (professionnel, saisie d'un administrateur) et une
  observation déjà décidée au journal du registre (aucune n'existe en production à ce jour).
- **La tâche `fact-registry-check`** fait deux appels au lieu d'un : la relance planifiée (fermée : elle ne fait
  rien), puis le contrôle. Son résumé dans `operational_job_runs.summary` porte en plus `pages`,
  `mergeCarried24h` et `reprojection` (état de l'interrupteur, comptes, codes des ventes en échec, jamais un
  identifiant de vente). En cas d'erreur de la base, `error_message` ne porte plus que l'étape et le code
  (« étape check, code 57014 »), jamais le message de PostgreSQL.
- **L'origine « document » ne peut plus tenir un champ** (`auction_fact_source_precedence.can_hold` à `false`,
  cinq lignes). Sans effet : aucune décision n'existe. Le lot R3 la rouvrira par sa propre migration.

## Réglages du registre

Table `app_private.fact_registry_switches`, deux lignes. Chaque réglage se change **sans migration de code**, par
le propriétaire, avec le rôle de migration. Aucun agent ne lance ces instructions en production, et un invariant
de sécurité refuse toute migration qui nommerait cette table ou ces fonctions.

| Réglage                           | Défaut  | Ligne absente | Changer                                                                |
| --------------------------------- | ------- | ------------- | ---------------------------------------------------------------------- |
| `decisions_require_second_factor` | `true`  | exigé         | `select app_private.set_fact_registry_decisions_second_factor(false);` |
| `scheduled_reprojection`          | `false` | fermé         | `select app_private.set_fact_registry_scheduled_reprojection(true);`   |

Une fonction de réglage lève (`55000`) si sa ligne manque : la rétablir par une migration.

**Second facteur des décisions.** Tant que le réglage vaut `true`, la fonction de décision refuse un jeton qui
n'est pas `aal2` (`second_factor_required`), même si l'interrupteur global `admin_mfa_required` est éteint. C'est
une décision du propriétaire, à prendre avant le lot R2c : enrôler un second facteur (`/admin/securite`) et garder
l'exigence, ou la lever.

**Plafond.** Vingt décisions par administrateur et par heure (`app_private.fact_registry_hourly_decision_limit()`,
une constante, changée par migration) ; au-delà, `rate_limited`.

## Relance planifiée de la projection

La projection lit des colonnes que la retenue ne tient pas. Un reclassement en terrain (`property_type`,
`surface_scope`, `app_surface_kind`) ou une écriture de `bedrooms_count` par la collecte change ce qu'elle
déciderait. Deux relances, et aucun déclencheur :

1. toute décision d'administrateur reprojette la vente entière ;
2. la tâche quotidienne `fact-registry-check` appelle `public.reproject_fact_registry_drift()` avant le contrôle,
   par un appel à part : la relance a sa propre transaction, et ses verrous sont rendus avant le contrôle.

**Le point 2 est une écriture de fiche lancée par une tâche planifiée.** Elle ne fait que réappliquer des décisions
humaines déjà acceptées : aucune décision n'est écrite, le mode de publication reste `manual`, les verrous
`auction_fact_claim_decisions_auto_locked` et `auction_fact_claim_decisions_accepted_by_admin` ne bougent pas.

- **Fermée par défaut** (réglage `scheduled_reprojection`). Tant qu'elle est ouverte, l'alerte
  `fact_registry.reprojection_enabled` (avertissement) reste ouverte : l'état ouvert ne s'oublie pas.
- **Sans effet** tant que le journal des décisions est vide, et quand un déclencheur du registre manque.
- **Bornée** : 30 ventes écrites ou occupées par passage. Dès la borne atteinte la passe s'arrête (`bounded` à
  `true`) et le passage suivant reprend. Une vente tenue par un lot de la collecte est comptée (`busy`) ; après
  trois ventes occupées la passe s'arrête. Chaque attente de verrou est bornée à 3 secondes.
- **Une vente dont la projection échoue ne compte pas dans la borne** : elle ne prive pas les suivantes de leur
  tour. Elle est comptée (`failed`) et rendue avec son code SQLSTATE et le nom de la contrainte, sans message. Le
  contrôle qui suit la signale en dérive.
- **Journalisée** : un évènement `drift_reprojected` par champ dont l'entrée a changé (à défaut, par champ tenu),
  dans `auction_sale_field_hold_events`.
- **Fermée, ou vente non appliquée** : le contrôle lève l'alerte critique `fact_registry.projection_drift`, comme
  au lot R2a.

Lire ce qu'un passage a écrit :

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

Attendu : sept lignes ; `project_sale_fields` compte 4 arguments, `check_fact_registry_consistency` 1. Puis refaire
les contrôles A1 à A5 du runbook R2a.

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

### P3. Nom et validité de la contrainte recréée par B0

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

Attendu : aucune ligne. Un lot de publication de la collecte tient un verrou consultatif pendant toute sa durée,
et des verrous de ligne sur `auction_sales` ; B0 attend la file d'évènements.

```sql
select lock_row.locktype, lock_row.mode, lock_row.granted, lock_row.pid, relation.relname
from pg_locks lock_row
left join pg_class relation on relation.oid = lock_row.relation
where lock_row.pid <> pg_backend_pid()
  and (
    lock_row.locktype = 'advisory'
    or (relation.relname in ('auction_sales', 'auction_sale_field_hold_events')
        and lock_row.mode <> 'AccessShareLock')
  )
order by lock_row.pid, lock_row.locktype;
```

### P6. La tâche quotidienne tourne, et sa durée

Attendu : un succès de moins de 27 heures ; noter `duration_ms` (référence pour A8).

```sql
select status, finished_at, duration_ms
from public.operational_job_runs
where job_name = 'fact-registry-check'
order by started_at desc
limit 7;
```

### P7. Délais des rôles

À relever, pour savoir quel délai d'instruction s'applique à la tâche (rôle `service_role`, via `authenticator`).
Les deux fonctions appelées par la tâche demandent 120 s (réglage de fonction, que PostgREST applique à la
transaction de l'appel) ; à vérifier sur la durée réelle au contrôle A8.

```sql
select role_row.rolname, setting
from pg_roles role_row
cross join unnest(coalesce(role_row.rolconfig, array[]::text[])) setting
where role_row.rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres')
  and setting like '%timeout%'
order by 1, 2;
```

### P8. Volumes

À relever : nombre d'observations, de ventes à venir, de fusions sur 30 jours, et les cinq lignes de préséance de
l'origine « document » (attendu : `can_hold` à `true` avant B1).

```sql
select
  (select count(*) from public.auction_fact_claims) as observations,
  (select count(*) from public.auction_sales where status in ('active', 'upcoming')) as ventes_a_venir,
  (select count(*) from app_private.auction_sale_merges
    where merged_at > now() - interval '30 days') as fusions_30_jours;

select field_key, can_hold
from public.auction_fact_source_precedence
where source_kind = 'document'
order by field_key;
```

## Vérifier après (lecture seule)

### A1. Les fonctions du lot, leur mode de sécurité et leurs réglages

Attendu : vingt lignes. `prosecdef` à `true` sauf pour `lock_sale_for_registry`, les deux fonctions de réglage,
`fact_registry_report_add_page`, `fact_registry_hourly_decision_limit` et `sale_is_land_sale`. `proconfig` contient
partout `search_path=""`, et en plus :

- `lock_timeout=3s` pour `lock_sale_for_registry` et `decide_auction_fact_claim` ;
- `statement_timeout=120s` pour `sync_fact_registry_alerts` et `reproject_fact_registry_drift`.

```sql
select namespace.nspname, routine.proname, routine.pronargs, routine.prosecdef, routine.proconfig
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'app_private' and routine.proname in (
         'decide_auction_fact_claim', 'lock_sale_for_registry', 'sale_is_land_sale',
         'fact_registry_hourly_decision_limit', 'set_fact_registry_decisions_second_factor',
         'set_fact_registry_scheduled_reprojection', 'fact_registry_candidate_sales',
         'fact_registry_page_checks', 'fact_registry_global_checks', 'fact_registry_report_add_page',
         'carry_sale_user_data_to_merged_sale', 'sync_fact_registry_alerts_from_report',
         'project_sale_fields'))
   or (namespace.nspname = 'public' and routine.proname in (
         'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
         'oppose_auction_fact_claim', 'check_fact_registry_consistency', 'sync_fact_registry_alerts',
         'reproject_fact_registry_drift'))
order by 1, 2;
```

### A2. Aucun droit d'exécution ouvert

Attendu : trois lignes, `check_fact_registry_consistency`, `reproject_fact_registry_drift` et
`sync_fact_registry_alerts` pour `service_role`. Toute autre ligne est un droit ouvert par erreur : le retirer par
une migration avant toute autre chose.

```sql
select namespace.nspname, routine.proname, api_role.rolname
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) api_role
where ((namespace.nspname = 'app_private' and routine.proname in (
          'decide_auction_fact_claim', 'lock_sale_for_registry', 'sale_is_land_sale',
          'fact_registry_hourly_decision_limit', 'set_fact_registry_decisions_second_factor',
          'set_fact_registry_scheduled_reprojection', 'fact_registry_candidate_sales',
          'fact_registry_page_checks', 'fact_registry_global_checks', 'fact_registry_report_add_page',
          'carry_sale_user_data_to_merged_sale', 'sync_fact_registry_alerts_from_report',
          'project_sale_fields'))
    or (namespace.nspname = 'public' and routine.proname in (
          'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
          'oppose_auction_fact_claim', 'check_fact_registry_consistency', 'sync_fact_registry_alerts',
          'reproject_fact_registry_drift')))
  and has_function_privilege(api_role.rolname, routine.oid, 'EXECUTE')
order by 1, 2, 3;
```

### A3. Droits de la relecture inchangés

Attendu : une ligne, `service_role` ; `proconfig` contient `lock_timeout=3s`.

```sql
select api_role.rolname, routine.proconfig
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) api_role
where namespace.nspname = 'public'
  and routine.proname = 'review_auction_fact_claim'
  and has_function_privilege(api_role.rolname, routine.oid, 'EXECUTE');
```

### A4. Les réglages dans leur sens sûr

Attendu : deux lignes, `decisions_require_second_factor` à `true`, `scheduled_reprojection` à `false`.

```sql
select switch_name, enabled, updated_at, updated_by
from app_private.fact_registry_switches
order by switch_name;
```

### A5. La file d'évènements admet les deux nouveaux évènements, l'origine « document » est fermée

Attendu : une ligne, puis cinq lignes à `false`.

```sql
select constraint_name
from information_schema.check_constraints
where constraint_schema = 'public'
  and constraint_name = 'auction_sale_field_hold_events_event_check'
  and check_clause like '%drift_reprojected%'
  and check_clause like '%merge_carried%';

select field_key, can_hold
from public.auction_fact_source_precedence
where source_kind = 'document'
order by field_key;
```

### A6. Corps remplacés

Attendu : quatre lignes, `remplace` à `true` partout. Une ligne à `false` veut dire que l'ancienne définition est
restée (migration non appliquée, ou fonction recréée ensuite).

```sql
select routine.proname,
       case routine.proname
         when 'project_sale_fields' then routine.prosrc like '%sale_is_land_sale%'
         when 'carry_sale_user_data_to_merged_sale' then routine.prosrc like '%v_carries_registry%'
         when 'review_auction_fact_claim' then routine.prosrc like '%lock_sale_for_registry%'
         when 'sync_fact_registry_alerts' then routine.prosrc like '%fact_registry_page_checks%'
       end as remplace
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'app_private'
       and routine.proname in ('project_sale_fields', 'carry_sale_user_data_to_merged_sale'))
   or (namespace.nspname = 'public'
       and routine.proname in ('review_auction_fact_claim', 'sync_fact_registry_alerts'))
order by 1;
```

### A7. Toujours inerte, déclencheurs en place

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

### A8. Au passage suivant de la tâche

Attendu : `status` à `success` ; dans `summary`, les onze contrôles, `pages` à 1, `reprojection.enabled` à
`false` ; `duration_ms` du même ordre que la mesure P6 ; aucune alerte `fact_registry.*` ouverte. Un résumé
`skipped`, ou `reprojection.skipped`, veut dire que PostgREST ne voit pas une fonction : recharger le schéma
(`notify pgrst, 'reload schema';`) et vérifier le passage suivant.

```sql
select status, finished_at, duration_ms, summary, error_message
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
- **B0 échoue sur la contrainte** : un évènement d'un type inconnu existe dans la file. Ne pas forcer ; relever les
  types présents (`select event, count(*) from public.auction_sale_field_hold_events group by event;`).
- **La tâche échoue après B3** : lire `error_message` (étape et code). Étape `check`, rapport partiel : le
  registre compte plus de 20 000 ventes ; aucune alerte n'a été refermée. Code `57014` : le délai d'instruction a
  été atteint ; relever la durée et revenir vers le plan.

### Fiche d'incident : suppression de doublons en échec

**Symptôme.** Un lot de la collecte, ou une suppression de doublon, échoue après B2 avec `40P01` (« deadlock
detected »), ou avec une erreur levée dans `app_private.project_sale_fields`.

**Pourquoi.** La suppression d'une vente fusionnée verrouille cette vente, puis le déclencheur de fusion verrouille
la vente conservée pour la reprojeter. Les lots de la collecte verrouillent par ordre d'identifiant. Quand un lot
tient la vente conservée et demande la vente fusionnée, les deux s'attendent : PostgreSQL annule l'une des deux
transactions. Aucune écriture partielle. Cela ne peut arriver que pour une vente fusionnée qui porte une pièce
(donc jamais avant le lot R2c).

**Diagnostic, en lecture seule.**

```sql
-- La vente fusionnée porte-t-elle une pièce ? (remplacer l'identifiant)
select sale.id, sale.held_fields is not null as tient_ou_memorise,
       (select count(*) from public.auction_fact_claim_decisions decision
         where decision.sale_id = sale.id) as decisions
from public.auction_sales sale
where sale.id = '00000000-0000-0000-0000-000000000000';

-- La fusion a-t-elle eu lieu ? (une ligne : oui)
select old_sale_id, canonical_sale_id, merged_at
from app_private.auction_sale_merges
where old_sale_id = '00000000-0000-0000-0000-000000000000';
```

**Réparation.** Rien à réparer en base : la transaction annulée n'a rien écrit. La collecte reprend la fusion à
son passage suivant. Si l'échec se répète pour la même vente, ne pas contourner par une suppression à la main :
relever l'erreur (code SQLSTATE) et revenir vers le plan. Si l'erreur vient de la projection et non d'un
interblocage, la vente conservée est signalée en dérive par le contrôle quotidien ; la corriger passe par une
décision d'administrateur ou par une migration, jamais par une écriture directe.

**Suite.** La suppression des doublons vente par vente, sous point de sauvegarde, côté collecte, est une condition
du lot R2c (voir plus bas) : elle ramène l'échec à une seule vente au lieu d'un lot entier.

## Retour arrière

Toujours par une nouvelle migration, jamais par une modification à la main. Tant qu'aucun droit n'a été ouvert et
qu'aucune décision n'existe, chaque retour est sans effet sur les fiches. Ordre inverse de l'application :

1. **B3** : refermer la relance suffit à en retirer l'effet. Pour revenir aux définitions du lot R2a : rétablir
   `public.sync_fact_registry_alerts()`, `app_private.sync_fact_registry_alerts_from_report(jsonb)` et
   `public.check_fact_registry_consistency(integer)` de `20261117100500`, puis supprimer
   `public.reproject_fact_registry_drift()`, les fonctions `fact_registry_page_checks`,
   `fact_registry_global_checks`, `fact_registry_report_add_page`, `fact_registry_candidate_sales` et
   `set_fact_registry_scheduled_reprojection`.
2. **B2** : rétablir `app_private.carry_sale_user_data_to_merged_sale()` de `20261029150000`, entre deux lots de
   publication.
3. **B1** : supprimer les quatre fonctions publiques et `app_private.decide_auction_fact_claim`, rétablir
   `public.review_auction_fact_claim` de `20260928180000`, puis supprimer `lock_sale_for_registry`,
   `fact_registry_hourly_decision_limit`, `set_fact_registry_decisions_second_factor` et la table
   `app_private.fact_registry_switches` ; repasser l'origine « document » à `can_hold = true`.
4. **B0** : rétablir `app_private.project_sale_fields` de `20261117100200`, après le retour de B2, puis supprimer
   `app_private.sale_is_land_sale`. Les deux valeurs d'évènement restent admises par la contrainte.

Dès qu'une décision existe (après le lot R2c), ne plus revenir sur B0 ni sur B2 : les journaux sont gardés, et le
retour se fait par retrait des pièces, comme le prévoit le plan pour la bascule.

## Essais à deux sessions

Rejoués sur base jetable pour ce lot (transcription dans le dossier de travail du développeur) :

| Cas                                                                                                                  | Résultat                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Un lot de la collecte tient la vente, l'administrateur accepte                                                       | `sale_busy` après 3,0 s, aucune décision écrite ; la même acceptation passe dès la fin du lot                                                                                    |
| L'administrateur accepte sans valider, la collecte écrit la vente                                                    | L'écriture attend, puis la retenue garde la valeur tenue                                                                                                                         |
| Fusion par le repli REST : la suppression tient la vente absorbée et attend la vente conservée, tenue par un lot SQL | Si le lot demande ensuite la vente absorbée, PostgreSQL détecte l'interblocage en 1 s et annule l'une des deux transactions (dans l'essai : le lot SQL), sans écriture partielle |
| Même fusion, le lot SQL ne demande pas la vente absorbée                                                             | La suppression attend la fin du lot, puis la vente conservée tient la pièce                                                                                                      |
| Relance planifiée (ouverte pour l'essai) pendant qu'un lot tient une vente en dérive                                 | `busy: 1`, `applied: 1` après 3,0 s ; au passage suivant la vente est reprise                                                                                                    |

Essais manuels à refaire avant le lot R2c, sur base jetable, parce qu'aucun test automatique à une session ne les
couvre :

1. **Délai de 3 secondes.** Session A : `begin; select 1 from public.auction_sales where id = '<vente>' for no key
update;`. Session B, avec un jeton d'administrateur `aal2` : `select public.accept_auction_fact_claim('<pièce>',
'single_lot');`. Attendu : `sale_busy` après 3 secondes, pas 30 ; aucune décision écrite.
2. **`retry`.** Session A : `begin;` puis la fusion de la vente de la pièce dans une autre (mise à jour de
   `source_urls` de la vente conservée, suppression de la vente absorbée), sans valider. Session B : une décision
   sur la pièce. Attendu : `sale_busy` tant que A ne valide pas ; après validation, la même décision porte sur la
   vente conservée (ou `claim_detached` si la pièce n'avait jamais été décidée).
3. **Trois ventes occupées.** Quatre ventes en dérive, la relance ouverte. Session A verrouille les trois
   premières (par identifiant). Session B : `select public.reproject_fact_registry_drift();`. Attendu : `busy: 3`,
   `bounded: true`, la quatrième non écrite, réponse en 9 à 18 secondes (un verrou de ligne peut compter deux
   attentes de 3 secondes).

## Échecs locaux connus (base jetable)

| Test  | Cause                                                                                                                      | Correctif d'amorçage                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `060` | `pg_net` absent                                                                                                            | Aucun (extension de Supabase)                                                                                                                                            |
| `443` | `auth.mfa_factors` absente du schéma `auth` factice                                                                        | Aucun à ce jour                                                                                                                                                          |
| `887` | `auth.jwt()` du script d'amorçage rend toujours `{}` : les assertions « jeton `aal2` » échouent (`second_factor_required`) | Définir `auth.jwt()` comme Supabase : `coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb` |
| `888` | Même cause : ses décisions passent par la fonction de décision, donc par le second facteur                                 | Même correctif                                                                                                                                                           |

## Non fait à ce lot, et à quelle condition

| Sujet                                                                                         | Condition                                                                                           |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Retirer les copies (`properties`, `auction_surfaces`, `judicial_sales`) du contrôle quotidien | L'étape PB de la collecte est en production : ces copies ne reçoivent plus les colonnes du registre |
| Index partiel de la liste de relecture d'administration                                       | Le contrôle A4 du runbook R2a, mesuré en production, montre un écart de plus de 100 ms              |
| Retirer la tolérance `skipped: migration_pending` de la tâche                                 | Après l'application de ce lot : le code est déployé avant la migration                              |
| Droits d'exécution des quatre fonctions de décision ; lecture pour l'écran de relecture       | Lot R2c                                                                                             |
| Ouvrir l'origine « document »                                                                 | Lot R3, par une migration qui repasse `can_hold` à `true`                                           |

## Conditions du lot R2c

À lever une par une, noir sur blanc, avant d'ouvrir un droit d'exécution :

1. **Second facteur** : choix du propriétaire sur le réglage `decisions_require_second_factor` (enrôler et garder
   l'exigence, ou la lever), en plus de l'interrupteur global `admin_mfa_required`.
2. **Droits** : `grant execute` des quatre fonctions de décision à `authenticated` **seul**, jamais à
   `service_role` ni à `anon`. L'auteur est lu dans le jeton de l'administrateur ; un appel par le rôle de service
   n'a pas d'auteur. Les invariants de sécurité refusent aujourd'hui tout droit sur ces fonctions : la règle du
   lot R2c les remplacera par « `authenticated` seul ».
3. **Noyau de l'agent d'information** : `review_information_agent_fact_candidate` est appelée par le rôle de
   service avec l'identifiant de l'administrateur en paramètre. Il ne peut donc pas appeler la fonction de
   décision telle quelle : à trancher (appel avec le jeton de l'administrateur, ou autre chemin relu).
4. **Levée d'une opposition** : aujourd'hui impossible, même pour le propriétaire. Une valeur d'annonce légitime,
   égale ou proche de la valeur opposée, est retenue pour la vie de la vente. Décision du propriétaire et d'un
   juriste, avant qu'une pièce d'occupation ou de nombre de pièces puisse être opposée.
5. **Autre pièce de même valeur après une opposition** : une opposition (ou un retrait de l'autorisation) ferme
   l'observation, pas la valeur. Une autre observation qui dit la même valeur peut être acceptée et tient alors
   le champ. Est-ce voulu ? À trancher avec le juriste.
6. **Suppression des doublons vente par vente** côté collecte, sous point de sauvegarde (lot du pipeline), pour
   qu'un échec de report n'annule qu'une vente.
7. **Délai d'instruction de `service_role`** mesuré en production (P7, A8) face à la durée réelle de la tâche.
8. **Brouillons** de l'agent d'information créés avant la bascule : annulés ou régénérés.
9. **Relance planifiée** : ouverte ou fermée le jour de la bascule, décision du propriétaire.
10. Conditions déjà au plan (section 10) : indicateur d'écho à zéro en production ; répétition complète sur base
    jetable (import, pose, retrait, fusion) ; essais manuels à deux sessions ci-dessus.

## Ce qui ne doit pas être fait

- Donner un droit d'exécution sur une fonction de décision avant le lot R2c.
- Appeler la route `/api/cron/fact-registry-check` à la main, lire `CRON_SECRET`, ou insérer un faux succès dans
  `operational_job_runs`.
- Ouvrir la relance planifiée ou lever le second facteur sans la décision du propriétaire.
- Écrire à la main dans `auction_fact_claim_decisions`, `auction_sale_field_hold_events`,
  `auction_fact_source_precedence` ou `app_private.fact_registry_switches`.
