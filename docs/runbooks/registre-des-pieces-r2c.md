# Registre des pièces : appliquer le lot R2c, partie base (ouverture des droits)

Plan : `docs/equipe/2026-11-11-registre-des-pieces.md`, section 10. Architecture :
`docs/architecture/registre-des-pieces.md`. Runbook du lot précédent : `docs/runbooks/registre-des-pieces-r2b.md`.

**Ce lot est la bascule.** Jusqu'ici personne ne pouvait écrire une décision. Après la dernière migration de ce
lot, tout administrateur connecté le peut, par l'API. Ce runbook ne couvre que la base : l'écran et les routes sont
un autre lot, déployé à part.

**Préalable : le lot R2b est appliqué et contrôlé** (fait le 12/11/2026 à 13:53 UTC, migrations `20261118100000` à
`20261118100300`).

## Risques acceptés par le propriétaire (12/11/2026)

À relire avant d'appliquer. Ce sont des décisions, pas des oublis.

- **Pas de second facteur.** Le réglage `decisions_require_second_factor` passe à faux. Le mot de passe d'un
  administrateur suffit pour décider.
- **Pas de plafond.** Ni les 20 décisions par heure, ni les 5 décisions définitives par 24 heures ne s'appliquent.
- **Conséquence, sans détour : un mot de passe d'administrateur volé permet un nombre illimité de décisions, dont
  des oppositions et des retraits pour autorisation retirée.** Ces deux décisions sont définitives : aucune
  procédure ne les annule, même pour le propriétaire. Une opposition abusive retient la valeur pour la vie de la
  vente ; une acceptation abusive change la fiche publique jusqu'à son retrait.
- **Rien ne bloque, deux contrôles informent, après coup.** `fact_registry.final_decisions` (avertissement) dès
  qu'une décision définitive existe sur 48 heures, `fact_registry.final_decisions_over_limit` (critique) si un
  auteur en a écrit plus de cinq sur 24 heures. La tâche passe une fois par jour, à 05:28 UTC : jusqu'à 24 heures
  peuvent s'écouler avant l'alerte.
- **Remettre le second facteur ne protège pas d'un mot de passe volé si l'administrateur n'a pas déjà enrôlé un
  second facteur** : celui qui connaît le mot de passe peut l'enrôler lui-même. Le seul arrêt sûr est de retirer
  le droit d'exécution (voir « Retour arrière »).
- **La relance planifiée reste fermée.** Une fiche en dérive (reclassement en terrain, nombre de chambres corrigé
  par la collecte) n'est reprojetée que par une décision sur la vente ; d'ici là l'alerte critique
  `fact_registry.projection_drift` reste ouverte.

Les deux mécanismes restent en place et se remettent sans migration (« Réglages »).

## Ce qui est appliqué

| Ordre | Migration                                                    | Contenu                                                                                                                                                                             | Verrou le plus fort                                                           | Pendant un lot de publication |
| ----- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------- |
| C0    | `20261119100000_sale_triggers_suspended_by_name`             | Retrait d'une source et recalcul de `catalogue_quarantined` : les déclencheurs ordinaires de `auction_sales` sont suspendus par leur nom, ceux du registre restent en mode `always` | Aucun                                                                         | Oui                           |
| C0b   | `20261119100050_data_api_guard_extension_functions`          | Garde de l'API : refuse à `anon` et `authenticated` tout chemin encodé (`%`) et tout appel `rpc/` d'une fonction d'extension du schéma `public` (PostGIS)                           | Aucun                                                                         | Oui                           |
| C1    | `20261119100100_fact_decision_limits_switch_and_author_lock` | Troisième réglage (plafonds), posé à faux ; second facteur passé à faux ; fonction de décision : plafonds selon le réglage, code `decision_in_progress`                             | ACCESS EXCLUSIVE bref sur `app_private.fact_registry_switches` (trois lignes) | Oui                           |
| C2    | `20261119100200_fact_registry_check_systemic_errors`         | Contrôle et relance : erreurs systémiques relevées ; décisions définitives sur 48 heures ; état des trois réglages au rapport                                                       | Aucun                                                                         | Oui                           |
| C3    | `20261119100300_hold_memorises_listing_surface_kind`         | Retenue : la nature de l'annonce est mémorisée à chaque écriture d'annonce                                                                                                          | Aucun (remplacement d'une fonction ; le déclencheur n'est pas touché)         | Oui                           |
| C4    | `20261119100400_fact_claim_decision_grants`                  | **Ouverture** : `grant execute` des quatre fonctions de décision à `authenticated` seul                                                                                             | Aucun                                                                         | Oui                           |

**Aucune migration du lot ne prend de verrou sur `auction_sales`, sur `auction_fact_claims` ni sur les journaux**,
pas même en lecture (relevé sur base jetable, juste avant chaque `commit`, à la première et à la seconde
application). C1 prend un ACCESS EXCLUSIVE sur la table de réglage le temps de recréer sa contrainte : seuls la
tâche quotidienne (05:28 UTC) et la fonction de décision la lisent. `lock_timeout` vaut 5 s partout. Chaque
migration est sa propre transaction. **Ne pas appliquer C1 pendant la tâche quotidienne de 05:28 UTC** : la
migration attendrait son verrou sur la table des réglages, que la tâche lit pendant tout son passage, et
échouerait proprement au bout de 5 s (rien n'est changé, relancer le workflow).

Rejouée, C1 remet le second facteur à faux : sans objet en production, où une migration appliquée ne se rejoue pas.

## La garde de l'API (C0b), à appliquer avant l'ouverture

PostGIS est installé dans le schéma `public`. Ses fonctions sont exécutables par `anon` et `authenticated`, et le
rôle de migration ne peut pas leur retirer ce droit (elles appartiennent à `supabase_admin`). L'une d'elles,
`st_findextent(text, text)`, exécute le texte qu'elle reçoit : atteinte par l'API, elle permettrait de poser le
jeton de la requête au nom d'un administrateur puis d'appeler une fonction de décision. Elle n'est pas appelable
par `/rpc` aujourd'hui, mais seulement parce que ses arguments n'ont pas de nom : une règle de PostgREST, pas une
barrière du projet.

C0b étend la garde que PostgREST appelle avant chaque requête (`public.enforce_data_api_object_boundary()`). Pour
`anon` et `authenticated`, elle refuse (`42501`) : tout chemin qui contient `%` ; `spatial_ref_sys` ; tout appel
`rpc/<nom>` dont le nom, tel quel ou en minuscules, est une fonction du schéma `public` qui appartient à une
extension. `service_role` n'est pas concerné. Seul le chemin est lu, pas la chaîne de requête : les filtres
encodés de PostgREST passent comme avant. Aucun code du dépôt n'appelle par l'API une fonction d'extension, ni
n'envoie de chemin encodé (vérifié sur `src/`, `services/`, `scripts/`, `supabase/functions/`, `e2e/`).

**Coût par requête**, mesuré sur base jetable (100 000 appels par chemin, PostGIS installé, 559 noms de fonctions
d'extension) : chemin de table 3,8 µs (4,0 µs avant) ; chemin `rpc/` 17 à 19 µs (4,0 µs avant), soit 0,015 ms de
plus par appel de fonction ; chemin encodé refusé en 5,6 µs. La lecture du catalogue n'a lieu que pour un chemin
`rpc/`.

**Ce que ce lot ne prouve pas** : la forme exacte de `request.path` en production (chemin brut, sans chaîne de
requête) est celle que décrit PostgREST ; elle n'a pas été relue sur la plateforme. Contrôle A7.

## Ordre de déploiement

1. **Fusionner ce lot**, attendre la CI verte. Aucun code de l'application ne dépend de ces migrations : la tâche
   `fact-registry-check` lit le rapport tel qu'il est.
2. **Faire les précontrôles** P1 à P8.
3. **Appliquer les migrations** par le workflow « Apply Supabase Migrations ». Hors de la minute 05:28 UTC (tâche
   quotidienne), à cause de C1. Dès que C4 est validée, les droits sont ouverts.
4. **Faire les contrôles** A1 à A6, puis la première décision d'essai.
5. Le lot « écran et routes » se déploie avant ou après : avant, ses appels reçoivent `42501` (droit refusé) tant
   que C4 n'est pas appliquée.

## Réglages du registre

Table `app_private.fact_registry_switches`, trois lignes. Chacun se change **sans migration**, par le propriétaire
de la base seul (éditeur SQL de Supabase, rôle `postgres`). Aucun agent ne lance ces instructions en production,
et un invariant de sécurité refuse toute migration qui nommerait cette table ou ces fonctions, hors des deux
décisions du 12/11/2026 écrites mot pour mot dans C1.

| Réglage                           | Après ce lot | Ligne absente | Changer                                                               |
| --------------------------------- | ------------ | ------------- | --------------------------------------------------------------------- |
| `decisions_require_second_factor` | `false`      | exigé         | `select app_private.set_fact_registry_decisions_second_factor(true);` |
| `decision_rate_limits_enabled`    | `false`      | appliqués     | `select app_private.set_fact_registry_decision_rate_limits(true);`    |
| `scheduled_reprojection`          | `false`      | fermée        | `select app_private.set_fact_registry_scheduled_reprojection(true);`  |

Une fonction de réglage lève (`55000`) si sa ligne manque : la rétablir par une migration. L'effet est immédiat,
pour la décision suivante. **Rallumer les plafonds compte aussi les décisions prises pendant qu'ils étaient
éteints** : un administrateur qui a décidé vingt fois dans l'heure, ou écrit cinq décisions définitives dans les 24
heures, est refusé aussitôt, jusqu'à ce que ces décisions sortent de la fenêtre.

## Codes d'erreur rendus à la route

Les quatre fonctions rendent une liste fermée : le message est le code, sans détail ni indice. Plusieurs codes
partagent un SQLSTATE : **la route lit le message**.

| Message                                                                                                                   | SQLSTATE | Sens pour l'écran                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `admin_required`                                                                                                          | `42501`  | Pas un administrateur (ou pas de session)                          |
| `second_factor_required`                                                                                                  | `42501`  | Seulement si le propriétaire remet le second facteur               |
| `permission denied for function …` (PostgreSQL, pas la liste fermée)                                                      | `42501`  | Appel sans jeton d'utilisateur (`anon`) ou par le rôle de service  |
| `invalid_reason_code`, `invalid_lot_attachment`, `invalid_argument`                                                       | `22023`  | Saisie refusée                                                     |
| `claim_not_found`, `sale_not_found`                                                                                       | `P0002`  | Observation ou vente disparue                                      |
| `invalid_transition`, `opposed_final`, `withdrawal_final`, `claim_detached`, `origin_cannot_hold`, `field_not_applicable` | `55000`  | Décision impossible dans cet état                                  |
| `registry_unavailable`                                                                                                    | `55000`  | Un déclencheur du registre n'est pas en place : incident, prévenir |
| `rate_limited`, `final_rate_limited`                                                                                      | `53400`  | Seulement si le propriétaire remet les plafonds                    |
| `sale_busy`                                                                                                               | `55P03`  | Un import tient la vente : réessayer dans une minute               |
| **`decision_in_progress`**                                                                                                | `55P03`  | Une autre décision du même administrateur est en cours : réessayer |
| `retry`                                                                                                                   | `40001`  | Fusion en cours : réessayer                                        |
| `registry_write_failed`                                                                                                   | `P0001`  | Erreur inattendue ; son code est au journal du serveur             |

`decision_in_progress` est nouveau : SQLSTATE `55P03`, message exact `decision_in_progress`. Il ne peut sortir que
si les plafonds sont appliqués (le verrou d'auteur n'est pris que pour les compter).

## Avant

Mesures en lecture seule, à confier à `qualite-donnees`. Aucune de ces requêtes n'emploie
`has_function_privilege`, `pg_get_userbyid`, `pg_get_expr`, `aclexplode`, `current_database`, `pg_backend_pid` ni
`hashtextextended` : la lecture seule peut les refuser. **Si une mesure ne donne pas le résultat attendu, ne pas
appliquer et revenir vers le plan.**

### P1. Le lot R2b est en place

Attendu : onze lignes.

```sql
select namespace.nspname, routine.proname, routine.pronargs
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'app_private' and routine.proname in (
         'decide_auction_fact_claim', 'lock_sale_for_registry', 'fact_registry_page_checks',
         'fact_registry_global_checks', 'fact_registry_decisions_second_factor_required',
         'set_fact_registry_decisions_second_factor', 'hold_projected_sale_fields'))
   or (namespace.nspname = 'public' and routine.proname in (
         'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
         'oppose_auction_fact_claim'))
order by 1, 2;
```

### P2. Toujours inerte

Attendu : 0, 0, 0, 0. **Rôle requis : `service_role` ou `postgres`.**

```sql
select
  (select count(*) from public.auction_fact_claim_decisions) as decisions,
  (select count(*) from public.auction_sale_field_hold_events) as evenements,
  (select count(*) from public.auction_sales where held_fields is not null) as ventes_du_registre,
  (select count(*) from public.information_agent_fact_publications) as publications;
```

### P3. Aucun droit ouvert sur les fonctions de décision

Les droits se lisent dans `pg_proc.proacl`, comparée comme un texte. Une entrée qui commence par `=` est le droit
donné à tout le monde (`PUBLIC`) ; une colonne vide (`NULL`) vaut le droit par défaut, donc `PUBLIC`.

Attendu : aucune ligne.

```sql
select namespace.nspname, routine.proname, routine.proacl::text as droits
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where ((namespace.nspname = 'public' and routine.proname in (
          'accept_auction_fact_claim', 'reject_auction_fact_claim', 'withdraw_auction_fact_claim',
          'oppose_auction_fact_claim'))
    or (namespace.nspname = 'app_private' and routine.proname = 'decide_auction_fact_claim'))
  and (routine.proacl is null
       or routine.proacl::text ~ '[{,](=|anon=|authenticated=|service_role=)')
order by 1, 2;
```

### P4. La contrainte de la table des réglages porte le nom attendu

C1 retire puis repose cette contrainte par son nom. Attendu : une ligne.

```sql
select constraint_row.conname
from pg_constraint constraint_row
join pg_class relation on relation.oid = constraint_row.conrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'app_private'
  and relation.relname = 'fact_registry_switches'
  and constraint_row.conname = 'fact_registry_switches_switch_name_check';
```

### P5. Les déclencheurs du registre sont en mode `always`

Attendu : douze lignes, `tgenabled` à `A` partout. Une autre valeur veut dire qu'un retrait de source ou un
recalcul a eu lieu depuis le lot R2b (constat N3, que C0 corrige) : remettre les modes par
`supabase/maintenance/20261117100600_restore_fact_registry_trigger_modes.sql` **avant** d'appliquer, sinon toute
décision sera refusée (`registry_unavailable`).

```sql
select relation.relname, trigger_row.tgname, trigger_row.tgenabled
from pg_trigger trigger_row
join pg_class relation on relation.oid = trigger_row.tgrelid
join pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and not trigger_row.tgisinternal
  and (trigger_row.tgname like 'aaab\_auction\_sales\_%'
       or (relation.relname in ('auction_fact_claim_decisions', 'auction_sale_field_hold_events')
           and trigger_row.tgname ~ '_(append_only|no_truncate|validate|stamp)$')
       or trigger_row.tgname in ('auction_fact_claims_no_truncate', 'auction_fact_claims_registry_origin_guard'))
order by 1, 2;
```

### P6. Aucune table fille, aucune tâche planifiée qui décide

Attendu : 0 pour la première requête ; aucune ligne pour la seconde. **Rôle requis pour la seconde : `postgres`**
(le schéma `cron` n'est pas lisible par les autres rôles).

```sql
select count(*) as tables_filles_ou_meres
from pg_inherits inheritance
join pg_class relation on relation.oid in (inheritance.inhparent, inheritance.inhrelid)
join pg_namespace namespace on namespace.oid = relation.relnamespace
where (namespace.nspname = 'public' and relation.relname in (
         'auction_fact_fields', 'auction_fact_source_precedence', 'auction_fact_claim_decisions',
         'auction_sale_field_hold_events', 'auction_fact_claims', 'auction_sales'))
   or (namespace.nspname = 'app_private' and relation.relname = 'fact_registry_switches');

select jobname
from cron.job
where command ~* '(accept|reject|withdraw|oppose|decide)_auction_fact_claim|request\.jwt';
```

### P7. Les réglages avant le lot

**Rôle requis : `postgres`.** Attendu : deux lignes, `decisions_require_second_factor` à `true`,
`scheduled_reprojection` à `false`. Sans ce rôle : le résumé de la tâche (P8) porte
`decisionsSecondFactorRequired: true` et `reprojection.enabled: false`.

```sql
select switch_name, enabled, updated_at, updated_by
from app_private.fact_registry_switches
order by switch_name;
```

### P8. La tâche quotidienne tourne

Attendu : un succès de moins de 27 heures, aucune alerte `fact_registry.*` ouverte.

```sql
select status, finished_at, duration_ms, summary
from public.operational_job_runs
where job_name = 'fact-registry-check'
order by started_at desc
limit 3;

select alert_key, status, last_seen_at
from public.operational_alerts
where alert_key like 'fact\_registry.%' and status = 'open';
```

## Vérifier après (lecture seule)

### A1. Les droits exacts

Attendu : quatre lignes. Chaque colonne `droits` compte **deux entrées et pas une de plus** : celle du
propriétaire, et `authenticated=X/…`. Aucune entrée `anon=`, `service_role=`, ni entrée qui commence par `=`. Un
`X` suivi d'une étoile (`X*`) serait un droit de redonner le droit : il ne doit pas y en avoir pour
`authenticated`.

```sql
select routine.proname, routine.proacl::text as droits
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where namespace.nspname = 'public'
  and routine.proname in ('accept_auction_fact_claim', 'reject_auction_fact_claim',
                          'withdraw_auction_fact_claim', 'oppose_auction_fact_claim')
order by 1;
```

Attendu pour la suivante : aucune ligne. Elle cherche tout droit en trop : `anon`, `PUBLIC` ou `service_role` sur
une fonction de décision, n'importe quel rôle de l'API sur la fonction de décision interne, les fonctions de
réglage ou les deux fonctions de suspension des déclencheurs.

```sql
select namespace.nspname, routine.proname, routine.proacl::text as droits
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'public'
       and routine.proname in ('accept_auction_fact_claim', 'reject_auction_fact_claim',
                               'withdraw_auction_fact_claim', 'oppose_auction_fact_claim')
       and (routine.proacl is null
            or routine.proacl::text ~ '[{,](=|anon=|service_role=)'
            or routine.proacl::text ~ 'authenticated=X\*'))
   or (namespace.nspname = 'app_private'
       and routine.proname in (
         'decide_auction_fact_claim', 'set_fact_registry_decisions_second_factor',
         'set_fact_registry_decision_rate_limits', 'set_fact_registry_scheduled_reprojection',
         'fact_registry_decision_rate_limits_enabled', 'fact_registry_error_is_systemic',
         'suspend_ordinary_sale_triggers', 'resume_ordinary_sale_triggers',
         'repair_catalogue_quarantine_drift')
       and (routine.proacl is null
            or routine.proacl::text ~ '[{,](=|anon=|authenticated=|service_role=)'))
order by 1, 2;
```

### A2. L'état des trois réglages

**Rôle requis : `postgres`.** Attendu : trois lignes, toutes à `false`.

```sql
select switch_name, enabled, updated_at, updated_by
from app_private.fact_registry_switches
order by switch_name;
```

Avec `service_role` ou `postgres`, le rapport du contrôle les donne aussi. Attendu : `false`, `false`, `false`.

```sql
select report -> 'decisions_second_factor_required' as second_facteur_exige,
       report -> 'decision_rate_limits_enabled' as plafonds_appliques,
       report -> 'scheduled_reprojection_enabled' as relance_ouverte
from (select public.check_fact_registry_consistency(1) as report) checked;
```

### A3. Le registre est vide avant la première décision

Attendu : la requête P2 rend 0, 0, 0, 0. Si le compte des décisions n'est pas nul, quelqu'un a décidé entre
l'application et ce contrôle : relever l'auteur avant toute autre chose.

```sql
select decision, actor_kind, actor_id, decided_at
from public.auction_fact_claim_decisions
order by seq
limit 20;
```

### A4. Les fonctions sont remplacées

Attendu : sept lignes, `remplace` à `true` partout.

```sql
select routine.proname,
       case routine.proname
         when 'decide_auction_fact_claim' then routine.prosrc like '%decision_in_progress%'
         when 'reproject_source_withdrawal' then
           routine.prosrc like '%suspend_ordinary_sale_triggers%' and routine.prosrc not like '%trigger user%'
         when 'repair_catalogue_quarantine_drift' then
           routine.prosrc like '%suspend_ordinary_sale_triggers%' and routine.prosrc not like '%trigger user%'
         when 'fact_registry_page_checks' then routine.prosrc like '%fact_registry_error_is_systemic%'
         when 'fact_registry_global_checks' then routine.prosrc like '%decision_rate_limits_enabled%'
         when 'reproject_fact_registry_drift' then routine.prosrc like '%fact_registry_error_is_systemic%'
         when 'hold_projected_sale_fields' then routine.prosrc like '%lot R2c%'
       end as remplace
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where (namespace.nspname = 'app_private'
       and routine.proname in ('decide_auction_fact_claim', 'reproject_source_withdrawal',
                               'repair_catalogue_quarantine_drift', 'fact_registry_page_checks',
                               'fact_registry_global_checks', 'hold_projected_sale_fields'))
   or (namespace.nspname = 'public' and routine.proname = 'reproject_fact_registry_drift')
order by 1;
```

### A5. Les déclencheurs sont toujours en mode `always`

Attendu : la requête P5 rend douze lignes à `A`. Avec le rôle `postgres`, la fonction du registre doit rendre un
tableau vide :

```sql
select app_private.fact_registry_triggers_not_always();
```

### A6. Au passage suivant de la tâche

Attendu : `status` à `success` ; dans `summary`, `decisionsSecondFactorRequired` à `false`,
`reprojection.enabled` à `false`, `simulationFailureCodes` vide ; aucune alerte `fact_registry.*` ouverte tant
qu'aucune décision définitive n'existe. Le résumé de la tâche ne porte pas l'état des plafonds : il se lit par A2.
La requête est celle de P8.

### A7. La garde de l'API refuse les fonctions d'extension

Attendu : `remplace` à `true`, et `garde_posee` à `true` (le rôle `authenticator` appelle toujours la garde avant
chaque requête).

```sql
select routine.prosrc like '%deptype = ''e''%' as remplace,
       (select coalesce(role_row.rolconfig::text, '') like '%pgrst.db_pre_request=public.enforce_data_api_object_boundary%'
          from pg_roles role_row where role_row.rolname = 'authenticator') as garde_posee
from pg_proc routine
join pg_namespace namespace on namespace.oid = routine.pronamespace
where namespace.nspname = 'public'
  and routine.proname = 'enforce_data_api_object_boundary';
```

Puis trois appels de l'API, avec la clé publiable seule (aucun jeton de session), à faire par le propriétaire ou
par `qualite-donnees` :

- `POST <url du projet>/rest/v1/rpc/st_findextent` : attendu `403` (ou `401`), code `42501`, message « Data API
  access denied for an extension object ». Avant C0b : `404` `PGRST202` ;
- `GET <url du projet>/rest/v1/spatial%5Fref%5Fsys` : attendu `42501`, message « Data API access denied for an
  encoded request path ». Si la réponse est une liste de lignes, la plateforme décode le chemin avant la garde :
  le dire tout de suite, la garde ne voit alors pas le chemin brut ;
- une page publique du site qui liste des ventes (elle appelle `rpc/search_auction_sales_preview_v3`) : elle
  s'affiche comme avant.

## Première décision d'essai (par le propriétaire)

À faire par le propriétaire, avec son propre compte d'administrateur. Aucun agent ne la fait à sa place, et
personne ne pose un jeton à la main dans l'éditeur SQL (`set_config('request.jwt.claims', …)`) : la décision
porterait un auteur que la base n'a pas authentifié.

Toute décision entre dans un journal qui ne s'efface pas. La première est donc choisie pour ne rien afficher :

1. **Un rejet**, motif `other`, sur une observation que le propriétaire rejetterait de toute façon. Par l'écran de
   relecture s'il est déployé, sinon par un appel de l'API avec le jeton de sa session :
   `POST <url du projet>/rest/v1/rpc/reject_auction_fact_claim`, en-têtes `apikey: <clé publiable>` et
   `Authorization: Bearer <jeton de session>`, corps `{"p_claim_id": "<observation>", "p_reason_code": "other"}`.
   Attendu : un objet avec `decision` à `rejected` et `state` nul.
2. **Contrôler** : une ligne au journal, `actor_kind` à `admin`, `actor_id` égal à l'identifiant du propriétaire ;
   aucune vente ne tient de champ ; aucun évènement.

```sql
select decision.decision, decision.actor_kind, decision.actor_id, decision.reason_code, decision.decided_at,
       (select count(*) from public.auction_sales where held_fields is not null) as ventes_du_registre,
       (select count(*) from public.auction_sale_field_hold_events) as evenements
from public.auction_fact_claim_decisions decision
order by decision.seq desc
limit 1;
```

3. **Deux refus à constater** : le même appel sans jeton de session (la clé publiable seule) rend `42501`
   « permission denied » ; avec le jeton d'un compte qui n'est pas administrateur, `42501` `admin_required`.

**Ne pas essayer une opposition ni un retrait pour autorisation retirée** : ils sont définitifs. Une acceptation
d'essai change la fiche publique : elle se fait sur une vraie pièce, pas pour voir.

## Retour arrière

**Refermer la bascule.** Une nouvelle migration, quatre lignes. Les décisions déjà écrites restent, et les champs
tenus le restent : seul un retrait de chaque pièce, avant de refermer, rend la valeur de l'annonce.

```sql
revoke execute on function public.accept_auction_fact_claim(uuid, text, text, uuid) from authenticated;
revoke execute on function public.reject_auction_fact_claim(uuid, text) from authenticated;
revoke execute on function public.withdraw_auction_fact_claim(uuid, text) from authenticated;
revoke execute on function public.oppose_auction_fact_claim(uuid, text) from authenticated;
```

Cette migration nomme les fonctions de décision : son fichier s'ajoute à `DECISION_MIGRATIONS` dans
`scripts/check-security-invariants-fact-registry.mjs`, dans le même commit. Elle rend rouges deux tests pgTAP, à
ajuster dans ce même commit :

- `887` : sept assertions. Les deux assertions des droits (la liste « `authenticated` seul » devient vide) et
  celles qui décident sous le rôle `authenticated` (elles reçoivent `permission denied` au lieu du refus ou de la
  décision attendus) ;
- `441` : une assertion, la liste des fonctions `security definer` ouvertes à `authenticated` (retirer les quatre
  fonctions de décision).

**En urgence (compte d'administrateur compromis).** Par le propriétaire, dans cet ordre :

1. **Lancer les quatre `revoke` ci-dessus depuis l'éditeur SQL.** C'est le seul arrêt certain : plus aucun compte
   ne décide, quel que soit son rôle et quel que soit le jeton. C'est une écriture de production hors migration :
   décision du propriétaire, à noter dans le journal de l'équipe, puis à régulariser par la migration identique.
2. **Retirer le rôle `admin` du compte**, pour ses autres droits d'administrateur :

   ```sql
   update public.user_profiles set user_role = 'user' where user_id = '<identifiant du compte>';
   ```

   L'effet est immédiat quand l'instruction passe : la fonction de décision relit le profil à chaque appel.
   **Elle peut être refusée** (`55000`, « A statistical reviewer identity and administrator role are immutable
   after review. » ou « A Judilibre reviewer identity and administrator role are immutable after decision. ») :
   deux gardes de `user_profiles` interdisent de retirer le rôle d'un compte qui a relu une preuve statistique ou
   décidé un rapprochement Judilibre. Un compte volé peut se donner cette protection par une seule relecture.
   Dans ce cas : les `revoke` de l'étape 1 suffisent à arrêter les décisions du registre ; ne pas contourner la
   garde (ni déclencheur coupé, ni suppression de la relecture). Lever la garde d'identité des relecteurs pour un
   compte compromis est une décision du propriétaire, qui n'est pas prévue ici.

3. Bannir l'utilisateur dans Supabase et changer son mot de passe. Seul, cela ne suffit pas : son jeton de session
   reste valable jusqu'à son expiration.
4. Relever les décisions de la période (requête A3, filtrée sur `actor_id`).

Les décisions définitives de l'attaquant ne s'annulent pas (voir « Risques acceptés »).

**Durcir sans refermer**, par le propriétaire, sans migration :

```sql
select app_private.set_fact_registry_decisions_second_factor(true);
select app_private.set_fact_registry_decision_rate_limits(true);
```

Le second facteur exigé refuse aussitôt toute session `aal1` (`second_factor_required`) : enrôler d'abord un
second facteur (`/admin/securite`), sinon plus personne ne décide.

**Revenir sur les autres migrations** : par une nouvelle migration qui rétablit la définition précédente, nommée
dans l'en-tête de chaque fichier. C0 ne se retire pas tant que le registre est en service.

## Si quelque chose échoue

- **Une migration échoue sur un verrou** (`55P03`) : elle n'a rien changé, les précédentes restent appliquées.
  Relancer le workflow. Si C4 n'est pas passée, les droits ne sont pas ouverts.
- **C1 échoue sur la contrainte** : le nom attendu au contrôle P4 n'existe pas. Ne pas forcer ; relever les
  contraintes de la table et revenir vers le plan.
- **Toute décision rend `registry_unavailable`** : un déclencheur du registre n'est pas en mode `always` (contrôle
  A5). Remettre les modes par le fichier de maintenance, puis chercher qui les a changés.
- **La tâche échoue après C2 avec un code de classe 42, 53, 58 ou XX** : c'est une erreur systémique relevée par le
  contrôle (droit, fonction absente, ressource, erreur interne), et non plus « tout le registre en dérive ». Lire
  `error_message` (étape et code), puis le journal de la base pour le message.
- **Une vente passe en terrain et son alerte `projection_drift` reste ouverte** : attendu depuis C3 quand l'annonce
  change sa nature. Une décision sur la vente la reprojette (la relance planifiée est fermée).

## Essais à deux sessions

Rejoués sur base jetable pour ce lot, chaque session sous le rôle `authenticated` avec le jeton d'un même
administrateur :

| Cas                                                                                            | Résultat                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Plafonds levés (état livré) : deux sessions, deux ventes, la première garde sa transaction 5 s | Les deux décisions passent aussitôt (0,04 s) : aucun verrou d'auteur          |
| Plafonds remis par le propriétaire : même essai, la première garde sa transaction 6 s          | La seconde reçoit `decision_in_progress` après 3,0 s, aucune décision de trop |
| Plafonds remis : la première valide en moins de 3 s                                            | La seconde attend (0,8 s) puis passe                                          |
| Un import tient la ligne de la vente                                                           | `sale_busy` après 3,0 s, comme au lot R2b                                     |

## Conditions du runbook R2b : où elles en sont

| Condition                                          | État à ce lot                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1. Second facteur                                  | Tranchée : levé (C1)                                                                              |
| 2. Droits à `authenticated` seul                   | Faite (C4)                                                                                        |
| 3. Noyau de l'agent d'information                  | Non faite : hors de la partie base                                                                |
| 4, 15. Levée ou annulation d'une opposition        | Tranchée : aucune procédure dans ce lot, la décision reste définitive                             |
| 5. Autre pièce de même valeur après une opposition | Non tranchée                                                                                      |
| 6. Suppression des doublons vente par vente        | Non faite : lot du pipeline                                                                       |
| 7, 17. Délais de `service_role`, hissage des 120 s | Non vérifiés : mesures en production                                                              |
| 8. Brouillons de l'agent d'information             | Non faite                                                                                         |
| 9, 12. Relance planifiée                           | Tranchée : fermée                                                                                 |
| 10. Indicateur d'écho, répétition, essais manuels  | Essais à deux sessions de ce lot faits ; indicateur d'écho et répétition complète : non faits ici |
| 11. Limite « terrain »                             | Faite (C3), avec deux cas restants décrits dans la note d'architecture                            |
| 13. Acceptation sur un champ non tenu              | Non faite                                                                                         |
| 14. Création d'une observation d'origine `admin`   | Non faite                                                                                         |
| 16. Relecture humaine obligatoire (`CODEOWNERS`)   | Non tranchée                                                                                      |

## Retoucher la fonction de décision (complément au runbook R2b)

La procédure du runbook R2b vaut toujours. Trois précisions depuis ce lot :

- `DECISION_MIGRATIONS` compte trois fichiers. Un fichier de cette liste échappe aux **deux** règles de texte qui
  lisent le nom des fonctions de décision et l'écriture du journal ; toutes les autres règles le lisent. Il se
  relit donc en entier, ligne par ligne.
- Un `grant` sur une fonction de décision n'est admis que dans `20261119100400`. Une migration qui redéfinit une
  des quatre fonctions publiques garde leur droit (`create or replace` ne le retire pas) : elle ne répète pas le
  `revoke all`, qui refermerait la bascule.
- Les deux fonctions `app_private.suspend_ordinary_sale_triggers` et `app_private.resume_ordinary_sale_triggers`
  sont épinglées de la même façon (`TRIGGER_SUSPENSION_FUNCTIONS`) : même procédure pour les retoucher.

## Échecs locaux connus (base jetable)

| Test  | Cause                                                | Correctif d'amorçage                         |
| ----- | ---------------------------------------------------- | -------------------------------------------- |
| `060` | `pg_net` absent                                      | Aucun (extension de Supabase)                |
| `443` | `auth.mfa_factors` absente du schéma `auth` factice  | Aucun à ce jour                              |
| `887` | `auth.jwt()` du script d'amorçage rend toujours `{}` | Définition de Supabase (voir le runbook R2b) |

## Ce qui ne doit pas être fait

- Donner un droit d'exécution sur une fonction de décision à `anon`, à `PUBLIC` ou à `service_role`.
- Revenir sur la garde de l'API (C0b), ou appeler par l'API une fonction d'extension du schéma `public`, tant que
  les fonctions de décision sont ouvertes.
- Poser un jeton à la main (`request.jwt.claims`) pour décider depuis l'éditeur SQL.
- Écrire à la main dans `auction_fact_claim_decisions`, `auction_sale_field_hold_events`,
  `auction_fact_source_precedence` ou `app_private.fact_registry_switches` (hors des trois fonctions de réglage,
  par le propriétaire).
- Ouvrir la relance planifiée sans la décision du propriétaire.
- Couper tous les déclencheurs de `auction_sales` (`disable trigger user`, `disable trigger all`) : passer par
  `app_private.suspend_ordinary_sale_triggers()` et `app_private.resume_ordinary_sale_triggers(noms)`.
- Appeler la route `/api/cron/fact-registry-check` à la main, lire `CRON_SECRET`, ou insérer un faux succès dans
  `operational_job_runs`.
