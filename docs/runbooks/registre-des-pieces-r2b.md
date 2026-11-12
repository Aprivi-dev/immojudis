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

| Ordre | Migration                                                   | Contenu                                                                                                                                                                                                   | Verrou le plus fort                                                                               | Pendant un lot de publication |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| B0    | `20261118100000_field_projection_merge_hints`               | Projection : indice de fusion sans gagnant, contamination exacte, pièce reportée (`merge_carried`) ; définitions uniques (terrain, lot qui tient, vente conservée, décision définitive) ; deux évènements | ACCESS EXCLUSIVE bref sur `auction_sale_field_hold_events` (vide), première application seulement | Oui                           |
| B1    | `20261118100100_fact_claim_decision_rpcs`                   | Réglages du registre, verrou de la vente, fonction de décision et ses deux plafonds, quatre fonctions publiques sans droit, `review_auction_fact_claim`, origine « document » fermée, index du journal    | SHARE sur `auction_fact_claim_decisions` (vide) le temps de créer l'index                         | Oui                           |
| B2    | `20261118100200_carry_registry_on_sale_merge`               | La fusion reporte le journal des publications et reprojette la vente conservée                                                                                                                            | Aucun (remplacement d'une fonction ; le déclencheur n'est pas touché)                             | **Non**                       |
| B3    | `20261118100300_fact_registry_check_pages_and_reprojection` | Contrôle quotidien par pages, contrôles généraux calculés une fois, relance planifiée fermée (appel à part), treize contrôles                                                                             | Aucun (fonctions, une ligne de réglage)                                                           | Oui                           |

**Aucune migration du lot ne prend de verrou sur `auction_sales` ni sur `auction_fact_claims`.** `lock_timeout`
vaut 5 s, ramené à 2 s dans B0 avant la contrainte de la file d'évènements. Chaque migration est sa propre
transaction et se rejoue sans dommage. Seconde application, relevée sur base jetable : B0 ne prend plus d'ACCESS
EXCLUSIVE ; B1 reprend un instant le verrou SHARE du journal des décisions (l'index existe, rien n'est construit)
et un ACCESS EXCLUSIVE bref sur sa propre table de réglage `app_private.fact_registry_switches` (son
`alter table … enable row level security` est rejoué), que seules la fonction de décision, la relance et le contrôle
lisent.

Le workflow « Apply Supabase Migrations » applique tout ce qui est en attente, dans l'ordre. **À lancer entre deux
lots de publication de la collecte**, à cause de B2 : une fusion en cours changerait de fonction en route. Un seul
index est construit, par B1, dans sa transaction : `auction_fact_claim_decisions_actor_decided_idx`
(`actor_id, decided_at`), sur le journal des décisions, vide. Il prend un verrou SHARE sur ce journal le temps de la
construction : les lectures passent, aucune écriture n'existe avant le lot R2c.

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
- **La tâche `fact-registry-check`** appelle la relance planifiée (fermée : une passe, qui ne fait rien), puis le
  contrôle. Ouverte, la relance enchaîne ses passes de 30 ventes tant que la base dit qu'il en reste, que la passe
  a écrit quelque chose et que 45 secondes ne sont pas écoulées (`REPROJECTION_PASS_START_BUDGET_MS` : la route
  dure 300 s au plus, une passe et le contrôle 120 s chacun). **Le contrôle tourne toujours**, même après une
  relance en échec ; la tâche échoue alors à la fin, et `error_message` dit les deux étapes. Son résumé dans
  `operational_job_runs.summary` porte en plus `pages`, `mergeCarried24h`, `decisionsSecondFactorRequired` (état
  du réglage du second facteur), `simulationFailureCodes` (codes des ventes dont la simulation lève) et
  `reprojection` (état de l'interrupteur, `passes`, comptes, codes des ventes en échec, jamais un identifiant de
  vente). En cas d'erreur de la base, `error_message` ne porte plus que l'étape et le code (« étape check, code
  57014 »), jamais le message de PostgreSQL. Une panne passagère est reconnue à son code seul (erreur sans code : réseau ; `40001`, `40P01`) : la tâche
  entière est alors reprise par `runMonitoredCron`, seulement s'il reste la place d'une tentative entière dans les
  300 s de la route. Le délai d'instruction (`57014`) n'est jamais repris : il est enregistré tel quel.
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

**Plafonds.** Deux constantes, changées par migration :

- vingt décisions par administrateur et par heure (`app_private.fact_registry_hourly_decision_limit()`) ; au-delà,
  `rate_limited` ;
- cinq décisions **définitives** (opposition, retrait pour autorisation retirée) par administrateur et par
  24 heures (`app_private.fact_registry_daily_final_decision_limit()`) ; au-delà, `final_rate_limited`. Personne ne
  peut défaire une décision définitive : ce plafond borne le dégât d'un mot de passe volé tant que le second
  facteur n'est pas enrôlé.

Les deux comptes sont exacts : la fonction de décision prend un verrou consultatif de transaction par auteur avant
de compter, deux sessions du même administrateur passent donc l'une après l'autre. Mesuré sur base jetable, 60
sessions simultanées du même administrateur qui avait déjà décidé deux fois dans l'heure : 18 décisions écrites, 42
refus `rate_limited`, 20 au journal (23 sans le verrou). Cette attente est bornée par le délai de verrou de 3
secondes de la fonction : au-delà, la réponse est `sale_busy`, jamais une décision de trop.

Le contrôle quotidien suit ces décisions : `fact_registry.final_decisions` (avertissement, pour information) dès
qu'une décision définitive a été écrite sur 24 heures, `fact_registry.final_decisions_over_limit` (critique) si un
auteur dépasse le plafond, ce que la fonction de décision interdit.

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
- **En deux temps** : la passe simule d'abord toutes les ventes du registre, sans aucun verrou, puis applique la
  projection aux ventes en dérive. Les verrous de ligne ne sont pris qu'au second temps. Mesuré sur base jetable,
  3 000 ventes tenues dont 30 en dérive réparties : verrous tenus 10,2 s avant cette correction (la première vente
  écrite restait verrouillée pendant la simulation des suivantes), 0,1 s après ; la passe dure 13,7 s.
- **Bornée** : 30 ventes écrites ou occupées par passe. Dès la borne atteinte la passe s'arrête (`bounded` à
  `true`) ; la tâche enchaîne une autre passe s'il reste du temps, sinon le passage du lendemain reprend. Une vente
  tenue par un lot de la collecte est comptée (`busy`) ; après trois ventes occupées la passe s'arrête. Chaque
  attente de verrou est bornée à 3 secondes.
- **Une vente dont la simulation ou la projection échoue ne compte pas dans la borne** et n'arrête pas la passe :
  elle ne prive pas les suivantes de leur tour. Elle est comptée (`failed`) et rendue avec son code SQLSTATE et le
  nom de la contrainte, sans message. Le contrôle qui suit la signale en dérive, avec son code
  (`simulation_failures` dans le rapport, `simulationFailureCodes` dans le résumé de la tâche).
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

Attendu : aucune ligne. Un lot de publication de la collecte tient un verrou consultatif pendant toute sa durée
(clé `immojudis:outcome_catalogue_bridge:v1`), et des verrous de ligne sur `auction_sales`. B0 demande un ACCESS
EXCLUSIVE sur la file d'évènements : même une simple lecture de cette table (`AccessShareLock`) le fait attendre,
elle est donc listée. Les verrous des autres bases et les verrous consultatifs sans rapport ne le sont pas.

```sql
select lock_row.locktype, lock_row.mode, lock_row.granted, lock_row.pid, relation.relname
from pg_locks lock_row
left join pg_class relation on relation.oid = lock_row.relation
where lock_row.pid <> pg_backend_pid()
  and lock_row.database = (select oid from pg_database where datname = current_database())
  and (
    (lock_row.locktype = 'advisory'
      and lock_row.objsubid = 1
      and ((lock_row.classid::bigint << 32) | lock_row.objid::bigint)
          = hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0))
    or (lock_row.locktype = 'relation' and relation.relname = 'auction_sale_field_hold_events')
    or (lock_row.locktype = 'relation' and relation.relname = 'auction_sales'
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

**Le délai de 120 s ne vaut que par PostgREST.** Les deux fonctions appelées par la tâche portent
`set statement_timeout = '120s'`. Un réglage de fonction ne peut pas allonger le délai de l'instruction qui
l'appelle : c'est PostgREST qui lit ce réglage et le pose sur la transaction de l'appel (`db-hoisted-tx-settings`,
qui contient `statement_timeout` par défaut). Appelées depuis l'éditeur SQL ou par `pg_cron`, ces fonctions
gardent le délai de la session. **Ce hissage n'est pas prouvé en production** : c'est une condition du lot R2c
(plus bas), à vérifier sur la durée réelle au contrôle A8.

Volumes mesurés sur base jetable par la contre-vérification, pour situer ce délai : 0,9 s pour un registre vide ;
28 à 38 s pour 3 000 ventes tenues ; 82 s avec 2 940 ventes en dérive avant que le rejeu soit borné aux vingt
premières de chaque page.

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

**Rôle requis : `postgres`** (éditeur SQL de Supabase, par le propriétaire). La première requête lit
`app_private.auction_sale_merges` : `service_role` et le rôle de lecture seule n'ont aucun droit sur le schéma
`app_private`. La seconde se lit avec n'importe quel rôle du serveur.

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

Attendu : vingt-sept lignes. `prosecdef` à `true` sauf pour `lock_sale_for_registry`, les deux fonctions de réglage,
`fact_registry_report_add_page`, `fact_registry_failure`, les deux plafonds (`fact_registry_hourly_decision_limit`,
`fact_registry_daily_final_decision_limit`), `sale_is_land_sale`, `fact_lot_attachment_holds` et
`fact_decision_is_final`. `proconfig` contient partout `search_path=""`, et en plus :

- `lock_timeout=3s` pour `lock_sale_for_registry` et `decide_auction_fact_claim` ;
- `statement_timeout=120s` pour `sync_fact_registry_alerts` et `reproject_fact_registry_drift`.

```sql
select namespace.nspname, routine.proname, routine.pronargs, routine.prosecdef, routine.proconfig
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'app_private' and routine.proname in (
         'decide_auction_fact_claim', 'lock_sale_for_registry', 'sale_is_land_sale',
         'fact_lot_attachment_holds', 'fact_registry_kept_sale', 'fact_decision_is_final',
         'fact_registry_hourly_decision_limit', 'fact_registry_daily_final_decision_limit',
         'fact_registry_decisions_second_factor_required', 'set_fact_registry_decisions_second_factor',
         'fact_registry_scheduled_reprojection_enabled', 'set_fact_registry_scheduled_reprojection',
         'fact_registry_candidate_sales', 'fact_registry_failure', 'fact_registry_page_checks',
         'fact_registry_global_checks', 'fact_registry_report_add_page',
         'carry_sale_user_data_to_merged_sale', 'sync_fact_registry_alerts_from_report',
         'project_sale_fields'))
   or (namespace.nspname = 'public' and routine.proname in (
         'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
         'oppose_auction_fact_claim', 'check_fact_registry_consistency', 'sync_fact_registry_alerts',
         'reproject_fact_registry_drift'))
order by 1, 2;
```

### A2. Aucun droit d'exécution ouvert

Les droits se lisent dans la colonne `pg_proc.proacl`, comparée comme un texte : ni `has_function_privilege` ni
`aclexplode`, que la lecture seule peut refuser. Une liste de droits a la forme `{rôle=X/donneur,…}` ; une entrée
qui commence par `=` est le droit donné à tout le monde (`PUBLIC`), et une colonne vide (`NULL`) vaut le droit par
défaut, donc `PUBLIC`.

Attendu : trois lignes, `check_fact_registry_consistency`, `reproject_fact_registry_drift` et
`sync_fact_registry_alerts`, dont les droits ne nomment que `service_role` (et le propriétaire). Toute autre ligne
est un droit ouvert par erreur : le retirer par une migration avant toute autre chose.

```sql
select namespace.nspname, routine.proname, routine.proacl::text as droits
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where ((namespace.nspname = 'app_private' and routine.proname in (
          'decide_auction_fact_claim', 'lock_sale_for_registry', 'sale_is_land_sale',
          'fact_lot_attachment_holds', 'fact_registry_kept_sale', 'fact_decision_is_final',
          'fact_registry_hourly_decision_limit', 'fact_registry_daily_final_decision_limit',
          'fact_registry_decisions_second_factor_required', 'set_fact_registry_decisions_second_factor',
          'fact_registry_scheduled_reprojection_enabled', 'set_fact_registry_scheduled_reprojection',
          'fact_registry_candidate_sales', 'fact_registry_failure', 'fact_registry_page_checks',
          'fact_registry_global_checks', 'fact_registry_report_add_page',
          'carry_sale_user_data_to_merged_sale', 'sync_fact_registry_alerts_from_report',
          'project_sale_fields'))
    or (namespace.nspname = 'public' and routine.proname in (
          'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
          'oppose_auction_fact_claim', 'check_fact_registry_consistency', 'sync_fact_registry_alerts',
          'reproject_fact_registry_drift')))
  and (routine.proacl is null
       or routine.proacl::text ~ '[{,](=|anon=|authenticated=|service_role=)')
order by 1, 2;
```

### A3. Droits de la relecture inchangés

Attendu : une ligne ; `droits` nomme `service_role` et le propriétaire, ni `anon=`, ni `authenticated=`, ni une
entrée qui commence par `=` ; `proconfig` contient `lock_timeout=3s`.

```sql
select routine.proacl::text as droits, routine.proconfig
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where namespace.nspname = 'public'
  and routine.proname = 'review_auction_fact_claim';
```

### A4. Les réglages dans leur sens sûr

**Rôle requis : `postgres`** (éditeur SQL de Supabase, par le propriétaire) : aucun autre rôle ne lit
`app_private.fact_registry_switches`. Sans ce rôle, l'état du second facteur se lit dans le résumé de la tâche
(`decisionsSecondFactorRequired`, contrôle A8) et celui de la relance dans `reprojection.enabled`.

Attendu : deux lignes, `decisions_require_second_factor` à `true`, `scheduled_reprojection` à `false`.

```sql
select switch_name, enabled, updated_at, updated_by
from app_private.fact_registry_switches
order by switch_name;
```

### A5. La file d'évènements admet les deux nouveaux évènements, l'origine « document » est fermée, l'index existe

Attendu : une ligne, `convalidated` et `deux_evenements` à `true` ; puis cinq lignes à `false` ; puis une ligne.
La contrainte se lit dans `pg_constraint`, comme au contrôle P3. Si la lecture seule refuse
`pg_get_constraintdef`, retirer la colonne `deux_evenements` et faire lire la définition par le propriétaire depuis
l'éditeur SQL de Supabase.

```sql
select constraint_row.conname, constraint_row.convalidated,
       pg_get_constraintdef(constraint_row.oid) like '%drift_reprojected%merge_carried%' as deux_evenements
from pg_constraint constraint_row
join pg_class relation on relation.oid = constraint_row.conrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = 'auction_sale_field_hold_events'
  and constraint_row.conname = 'auction_sale_field_hold_events_event_check';

select field_key, can_hold
from public.auction_fact_source_precedence
where source_kind = 'document'
order by field_key;

select index_relation.relname
from pg_class index_relation
join pg_namespace namespace on namespace.oid = index_relation.relnamespace
where namespace.nspname = 'public'
  and index_relation.relkind = 'i'
  and index_relation.relname = 'auction_fact_claim_decisions_actor_decided_idx';
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

Attendu : `status` à `success` ; dans `summary`, les treize contrôles, `pages` à 1, `reprojection.enabled` à
`false` et `reprojection.passes` à 1, `decisionsSecondFactorRequired` à `true`, `simulationFailureCodes` vide ;
`duration_ms` du même ordre que la mesure P6 ; aucune alerte `fact_registry.*` ouverte. Un résumé
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
- **La tâche échoue après B3** : lire `error_message` (étape et code). Étape `reprojection` : le contrôle a tourné
  quand même, et le message dit ce qu'il a donné ; les alertes sont à jour. Étape `check`, rapport partiel : le
  registre compte plus de 20 000 ventes ; aucune alerte n'a été refermée. Code `57014` : le délai d'instruction a
  été atteint (la tâche n'est pas reprise dans ce cas) ; relever la durée et revenir vers le plan : le
  hissage du délai de 120 s par PostgREST est alors à vérifier (P7).

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
   `fact_registry_global_checks`, `fact_registry_report_add_page`, `fact_registry_candidate_sales`,
   `fact_registry_failure`, `fact_registry_scheduled_reprojection_enabled` et
   `set_fact_registry_scheduled_reprojection`.
2. **B2** : rétablir `app_private.carry_sale_user_data_to_merged_sale()` de `20261029150000`, entre deux lots de
   publication.
3. **B1** : supprimer les quatre fonctions publiques et `app_private.decide_auction_fact_claim`, rétablir
   `public.review_auction_fact_claim` de `20260928180000`, puis supprimer `lock_sale_for_registry`,
   `fact_registry_hourly_decision_limit`, `fact_registry_daily_final_decision_limit`,
   `fact_registry_decisions_second_factor_required`, `set_fact_registry_decisions_second_factor`, l'index
   `auction_fact_claim_decisions_actor_decided_idx` et la table `app_private.fact_registry_switches` ; repasser
   l'origine « document » à `can_hold = true`.
4. **B0** : rétablir `app_private.project_sale_fields` de `20261117100200`, après le retour de B2, puis supprimer
   `app_private.sale_is_land_sale`, `app_private.fact_lot_attachment_holds`, `app_private.fact_decision_is_final`
   et `app_private.fact_registry_kept_sale`. Les deux valeurs d'évènement restent admises par la contrainte.

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
| Rafale : 60 sessions simultanées du même administrateur, deux décisions déjà écrites dans l'heure                    | 18 décisions écrites, 42 refus `rate_limited`, 20 au journal : le plafond est exact. Sans le verrou consultatif par auteur (définition précédente) : 23                          |
| Relance planifiée, 3 000 ventes tenues dont 30 en dérive réparties : durée des verrous de ligne                      | 0,1 s (les verrous ne sont pris qu'après la simulation de tout le registre) ; 10,2 s avec la définition précédente. Passe : 13,7 s                                               |

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
| Supprimer `OPTIONAL_FACT_REGISTRY_CHECKS` (exiger les trois contrôles du lot dans le rapport) | Après l'application de ce lot, pour la même raison                                                  |
| Droits d'exécution des quatre fonctions de décision ; lecture pour l'écran de relecture       | Lot R2c                                                                                             |
| Ouvrir l'origine « document »                                                                 | Lot R3, par une migration qui repasse `can_hold` à `true`                                           |

## Conditions du lot R2c

À lever une par une, noir sur blanc, avant d'ouvrir un droit d'exécution :

1. **Second facteur** : choix du propriétaire sur le réglage `decisions_require_second_factor` (enrôler et garder
   l'exigence, ou la lever), en plus de l'interrupteur global `admin_mfa_required`. Le propriétaire n'active pas
   la double authentification pour l'instant : s'il lève l'exigence, le plafond de cinq décisions définitives par
   24 heures et les deux alertes `fact_registry.final_decisions*` sont ce qui borne un mot de passe volé.
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
11. **Limite « terrain »** : pour une surface tenue, la nature lue est celle de l'annonce mémorisée à la prise du
    champ. Si l'annonce passe en terrain par sa seule nature (`app_surface_kind`) alors que la valeur d'annonce
    mémorisée ne bouge pas, le registre ne le voit pas. Le déclencheur de retenue doit mettre à jour la nature
    mémorisée à chaque écriture de l'annonce.
12. **Reclassement en terrain et relance ouverte** : la relance libère une surface bâtie acceptée dès que la vente
    est reclassée en terrain (par le type de bien ou la portée), sans décision humaine. À confirmer par le
    propriétaire avant d'ouvrir la relance.
13. **Acceptation sur un champ que le registre ne tient pas** : elle est enregistrée et n'affiche rien. Le jour où
    ce champ entre au registre, elle devient une pièce à projeter, sans nouvelle décision. À recenser avant tout
    ajout de champ.
14. **Qui peut créer une observation d'origine `admin`** (`evidence_kind = 'admin_entry'`) : aujourd'hui le
    propriétaire de la base seulement (garde d'origine). Le chemin de saisie du lot R2c est à définir et à relire.
15. **Annuler une opposition ou un retrait abusif** : aucune procédure n'existe, la décision est définitive pour
    tous. Décision du propriétaire, avec la condition 4.
16. **Relecture humaine obligatoire des migrations** (`CODEOWNERS`) : décision du propriétaire. Rien n'est ajouté à
    ce lot. Les invariants de sécurité épinglent la fonction de décision, mais ils sont modifiables par le même
    commit qu'une migration.
17. **Délai de 120 s** : prouver en production que PostgREST hisse le `statement_timeout` des deux fonctions de la
    tâche sur la transaction de l'appel (`db-hoisted-tx-settings`), par la durée réelle d'un passage ou par une
    lecture de la configuration (P7).

## Retoucher la fonction de décision

La fonction `app_private.decide_auction_fact_claim` est épinglée par les invariants de sécurité
(`scripts/check-security-invariants-fact-registry.mjs`) : l'empreinte de son corps, et la liste des fichiers qui
ont le droit de la nommer. Une retouche légitime suit ces étapes, dans un seul commit :

1. Écrire une **nouvelle migration** qui redéfinit la fonction entière par `create or replace` (jamais
   `alter function`, que les invariants refusent), avec ses `revoke`.
2. Lancer `npm run test:security-invariants`. Il échoue et nomme la nouvelle empreinte. Relire la différence entre
   les deux corps, ligne par ligne : l'auteur lu par `(select auth.uid())`, `public.is_admin()` avant tout, le
   contrôle des déclencheurs, puis les plafonds sous leur verrou consultatif.
3. Mettre à jour `DECIDE_BODY_SHA256`, et ajouter le nom du fichier à `DECISION_MIGRATIONS` (seuls fichiers qui
   nomment la fonction de décision, les quatre fonctions publiques, ou qui écrivent le journal des décisions).
4. Si la migration nomme la table des réglages ou une fonction de réglage, l'ajouter aussi à `SWITCH_MIGRATIONS`.
   Les deux lectures de réglage (`fact_registry_decisions_second_factor_required`,
   `fact_registry_scheduled_reprojection_enabled`) sont tenues à leur forme : leur sens sûr ne se change pas.
5. Adapter le test `supabase/tests/887_fact_claim_decision_rpcs.sql`, et déclarer le chemin de la migration dans
   l'exception de recherche de secrets si elle porte des clés de champ (`field_key … 'property.surface_m2'`).
6. Faire relire le commit par une personne : les invariants et la migration changent ensemble, la relecture
   humaine est la seule garde de ce commit (condition 16).

## Ce qui ne doit pas être fait

- Donner un droit d'exécution sur une fonction de décision avant le lot R2c.
- Appeler la route `/api/cron/fact-registry-check` à la main, lire `CRON_SECRET`, ou insérer un faux succès dans
  `operational_job_runs`.
- Ouvrir la relance planifiée ou lever le second facteur sans la décision du propriétaire.
- Écrire à la main dans `auction_fact_claim_decisions`, `auction_sale_field_hold_events`,
  `auction_fact_source_precedence` ou `app_private.fact_registry_switches`.
