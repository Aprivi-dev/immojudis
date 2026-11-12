# Supprimer le rôle PostgreSQL `lovable_readonly`

Décision du propriétaire du 12/11/2026 : ce rôle de lecture venait de l'outil Lovable, qui ne sert plus.
Migration : `supabase/migrations/20261117110000_drop_lovable_readonly_role.sql`. Seul le propriétaire
l'applique, par le workflow « Apply Supabase Migrations ». Toutes les requêtes de cette page sont en lecture
seule.

Le numéro `20261117110000` est dans le futur : toute migration fusionnée ensuite doit porter un numéro
postérieur (`npm run check:migrations` le vérifie).

## Ce que fait la migration

- Rôle absent (CI, base d'ombre, poste local, seconde application) : rien, elle réussit.
- Rôle présent : dans une seule transaction, elle vérifie l'état, révoque un à un les droits que le catalogue
  liste pour ce rôle, vérifie qu'il n'en reste aucun, puis `drop role`, qui retire aussi l'appartenance de
  `postgres`. Au premier refus, rien n'est appliqué.
- Elle refuse, avec un message qui dit pourquoi, si : le rôle qui applique n'a pas l'option ADMIN sur
  `lovable_readonly` (exigée par PostgreSQL 16 et 17 pour `drop role`), le rôle possède un objet, une politique
  le nomme, il a un droit sur un objet partagé (`CONNECT` sur la base, par exemple), dans une autre base ou sur
  une sorte d'objet non mesurée, ou un droit reste après révocation.
- Verrous : aucun sur les tables. `REVOKE` modifie la ligne de l'objet dans le catalogue (`pg_class`, `pg_proc`,
  `pg_namespace`, `pg_default_acl`), tenue jusqu'au commit. Les lectures et les écritures de données ne sont ni
  bloquées ni attendues : un lot de collecte en cours ne gêne pas. Ce qui modifie la même ligne de catalogue
  gêne : une opération de schéma sur une des tables, ou un `autovacuum` qui termine. La migration attend alors
  au plus 5 s (`lock_timeout`) puis échoue, ou échoue aussitôt avec « tuple concurrently updated », sans effet.
- Durée mesurée sur une base PostgreSQL 16 jetable (203 objets) : 40 à 115 ms.

### Ce qui est prouvé, et où

- PostgreSQL 16 jetable, `postgres` non superutilisateur avec `CREATEROLE` : rôle absent, rôle présent avec la
  forme mesurée, seconde application, et tous les cas de refus.
- PostgreSQL 17 sous la pile Supabase locale (extension `supautils`, `postgres` non superutilisateur) : l'étape
  « Drop the lovable_readonly role when it exists » du job CI « Supabase migrations + pgTAP »
  (`npm run test:db-role-drop`) crée le rôle, exécute le fichier de migration lui-même et vérifie qu'il ne reste
  rien. **Ne pas appliquer en production tant que cette étape n'est pas verte sur le commit de `main`.** Sa
  sortie donne la version, le rôle qui applique et s'il est superutilisateur : vérifier qu'elle dit
  `"superuser":false` et un nombre non nul de réglages `supautils`, sinon la preuve ne vaut pas pour la
  production.
- Ce que la CI ne reproduit pas : le donneur de l'appartenance (`supabase_admin` en production) et le volume
  (206 objets).

## Avant : mesures en lecture seule

À refaire juste avant de lancer le workflow. Résultats du 12/11/2026 entre parenthèses.

```sql
-- M1. Version et réglages de supautils. (PostgreSQL 17.11 ; lovable_readonly absent de
-- supautils.reserved_roles et de supautils.reserved_memberships.)
select current_setting('server_version') as version;
select name, setting from pg_catalog.pg_settings where name like 'supautils.%' order by name;

-- M2. Le rôle, celui qui applique, et les sessions ouvertes sous le rôle. (Connexion permise, sans expiration,
-- ni superutilisateur ni BYPASSRLS ; postgres a rolcreaterole = true ; aucune session.)
select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolvaliduntil
  from pg_catalog.pg_roles
 where rolname in ('lovable_readonly', 'postgres');
select a.pid, a.usename, a.application_name, a.client_addr, a.backend_start, a.state
  from pg_catalog.pg_stat_activity a
 where a.usename = 'lovable_readonly';

-- M3. Tout ce qui dépend du rôle, par type, catalogue et base. (Uniquement le type 'a', base courante :
-- 199 pg_class, 5 pg_proc, 1 pg_namespace, 1 pg_default_acl, aucune colonne.)
select d.deptype, c.relname as catalogue, coalesce(db.datname, '(partagé)') as base,
       count(*) as lignes, count(*) filter (where d.objsubid <> 0) as dont_colonnes
  from pg_catalog.pg_shdepend d
  join pg_catalog.pg_roles r on r.oid = d.refobjid
  join pg_catalog.pg_class rc on rc.oid = d.refclassid and rc.relname = 'pg_authid'
  join pg_catalog.pg_class c on c.oid = d.classid
  left join pg_catalog.pg_database db on db.oid = d.dbid
 where r.rolname = 'lovable_readonly'
 group by 1, 2, 3
 order by 1, 2;

-- M4. Les droits que postgres voit. Cette vue ne montre que les droits dont le lecteur est le donneur ou le
-- bénéficiaire : elle ne peut PAS montrer un droit accordé par un autre rôle. Le critère est donc la
-- comparaison des totaux avec M3 : droits_vus de pg_class = lignes pg_class de M3, et de même pour pg_proc.
-- Un total plus petit : un autre rôle a accordé des droits, postgres ne pourra pas les révoquer.
select 'pg_class' as catalogue, g.grantor, g.privilege_type, count(*) as droits_vus
  from information_schema.role_table_grants g
 where g.grantee = 'lovable_readonly'
 group by 1, 2, 3
union all
select 'pg_proc', g.grantor, g.privilege_type, count(*)
  from information_schema.role_routine_grants g
 where g.grantee = 'lovable_readonly'
 group by 1, 2, 3
 order by 1, 2, 3;

-- M5. Appartenances. (Une seule : postgres membre de lovable_readonly, accordée par supabase_admin,
-- admin_option = true, inherit_option = false, set_option = false.)
select r.rolname as role, m.rolname as membre, g.rolname as accordee_par,
       am.admin_option, am.inherit_option, am.set_option
  from pg_catalog.pg_auth_members am
  join pg_catalog.pg_roles r on r.oid = am.roleid
  join pg_catalog.pg_roles m on m.oid = am.member
  left join pg_catalog.pg_roles g on g.oid = am.grantor
 where r.rolname = 'lovable_readonly' or m.rolname = 'lovable_readonly';

-- M6. Privilèges par défaut qui nomment le rôle. (Une ligne : postgres, public, r.)
select setter.rolname as pose_par, n.nspname as schema, a.defaclobjtype as sorte, a.defaclacl::text as droits
  from pg_catalog.pg_default_acl a
  join pg_catalog.pg_roles setter on setter.oid = a.defaclrole
  left join pg_catalog.pg_namespace n on n.oid = a.defaclnamespace
 where a.defaclacl::text like '%lovable_readonly%';

-- M7. Juste avant de lancer : transactions longues, opérations de schéma et autovacuum en cours.
-- Attendu : aucune ligne. Sinon attendre qu'elles finissent.
select a.pid, a.usename, a.backend_type, a.state, a.wait_event_type,
       now() - a.xact_start as duree_transaction, left(a.query, 80) as debut_requete
  from pg_catalog.pg_stat_activity a
 where a.pid <> pg_backend_pid()
   and (
     a.backend_type = 'autovacuum worker'
     or a.xact_start < now() - interval '30 seconds'
     or (a.state <> 'idle'
         and a.query ~* '^\s*(alter|create|drop|truncate|reindex|vacuum|analyze|grant|revoke|refresh)\M')
   )
 order by a.xact_start;
```

Lancer aussi C1 (section « Après ») avant, pour avoir le point de départ.

Complément facultatif à M4, **à lancer par le propriétaire dans l'éditeur SQL de Supabase** (l'outil de lecture
de l'agent refuse `aclexplode`) : le donneur de chaque droit. Attendu : `postgres` pour les relations et les
fonctions, `postgres` ou `pg_database_owner` pour le schéma `public`.

```sql
select 'relation' as sorte, grantor.rolname as donneur, acl.privilege_type, count(*) as total
  from pg_catalog.pg_class c
 cross join lateral aclexplode(c.relacl) acl
  join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
  join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
 where grantee.rolname = 'lovable_readonly'
 group by 1, 2, 3
union all
select 'fonction', grantor.rolname, acl.privilege_type, count(*)
  from pg_catalog.pg_proc p
 cross join lateral aclexplode(p.proacl) acl
  join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
  join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
 where grantee.rolname = 'lovable_readonly'
 group by 1, 2, 3
union all
select 'schéma', grantor.rolname, acl.privilege_type, count(*)
  from pg_catalog.pg_namespace n
 cross join lateral aclexplode(n.nspacl) acl
  join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
  join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
 where grantee.rolname = 'lovable_readonly'
 group by 1, 2, 3
 order by 1, 2, 3;
```

**Ne pas lancer si** :

- M5 ne montre pas `postgres` membre avec `admin_option = true` ;
- M3 montre autre chose que des lignes `a` de la base courante sur les quatre catalogues ;
- les totaux de M4 sont inférieurs à ceux de M3 ;
- M1 montre `lovable_readonly` dans un réglage `supautils.reserved_*` ;
- un import DVF (`dvf-import.yml`) ou un recalcul des tendances (`refresh-commune-market-trends.yml`) est en
  cours ou planifié dans l'heure : l'import crée, renomme et supprime des tables dans `public`, et une table
  créée pendant la migration reçoit encore le droit par défaut du rôle ;
- M7 montre une ligne.

Une migration qui échoue **bloque toutes celles qui la suivent** dans le workflow. Mieux vaut l'appliquer quand
aucun autre lot n'attend derrière elle.

Une session ouverte (M2) n'empêche pas la suppression : PostgreSQL supprime le rôle, la session continue sans
aucun droit propre jusqu'à sa déconnexion. Mieux vaut qu'il n'y en ait pas : retirer d'abord l'accès côté
Lovable (dernière section).

## Application

1. Fusionner le lot dans `main`, attendre que la CI du commit soit verte, étape « Drop the lovable_readonly
   role when it exists » comprise.
2. Vérifier ce qui est en attente : la migration `20261117110000` s'applique avec toutes les migrations en
   attente avant elle, dans l'ordre. Si un autre lot est en attente, suivre aussi son runbook.
3. Refaire M1 à M7, puis lancer « Apply Supabase Migrations » depuis `main`, avec `confirm_target` =
   `production`.
4. Critère de succès : le workflow est vert jusqu'à sa dernière étape (« Detect production schema drift ») et
   C1 rend zéro partout. L'avis `Rôle lovable_readonly supprimé : N objet(s) révoqué(s)` n'est pas un critère :
   le client du workflow l'affiche sous la forme d'un objet, peu lisible. N peut dépasser 206 si des tables ont
   été créées dans `public` depuis la mesure.

### Ordre de livraison et contrôle de dérive

Le même lot retire du contrôle de dérive la liste qui ignorait les droits de ce rôle
(`scripts/lib/schema-drift.mjs`). Vérifié dans les workflows :

- en CI (`.github/workflows/ci.yml`), le contrôle compare une base éphémère où le rôle n'a jamais existé : il n'y
  avait rien à ignorer, le retrait de la liste n'y change rien ;
- en production, le contrôle ne tourne qu'à la dernière étape de « Apply Supabase Migrations », après « Apply
  pending migrations », et à la fin de `npm run release:prepare`, après `db:migrate`. Dans les deux cas le rôle
  est déjà supprimé. Aucune tâche planifiée ne lance ce contrôle.

Conséquence : entre la fusion et l'application, un `npm run check:schema-drift -- --remote` lancé à la main
sortirait rouge, avec les 206 lignes de droits du rôle. C'est attendu, et cela disparaît avec la migration.

## Après : contrôles

```sql
-- C1. Attendu après la migration : zéro partout. Les motifs cherchent le nom du rôle et un identifiant
-- resté sans rôle (un nombre à la place d'un nom).
select
  (select count(*) from pg_catalog.pg_roles where rolname = 'lovable_readonly') as role_present,
  (select count(*) from pg_catalog.pg_default_acl a
    where a.defaclacl::text ~ '(lovable_readonly|[{,][0-9]+)=') as privileges_par_defaut,
  (select count(*) from pg_catalog.pg_class c
    where c.relacl::text ~ '(lovable_readonly|[{,][0-9]+)=') as droits_de_relations,
  (select count(*) from pg_catalog.pg_attribute a
    where a.attacl::text ~ '(lovable_readonly|[{,][0-9]+)=') as droits_de_colonnes,
  (select count(*) from pg_catalog.pg_proc p
    where p.proacl::text ~ '(lovable_readonly|[{,][0-9]+)=') as droits_de_fonctions,
  (select count(*) from pg_catalog.pg_namespace n
    where n.nspacl::text ~ '(lovable_readonly|[{,][0-9]+)=') as droits_de_schemas,
  (select count(*)
     from pg_catalog.pg_auth_members am
    where not exists (select 1 from pg_catalog.pg_roles r where r.oid = am.roleid)
       or not exists (select 1 from pg_catalog.pg_roles r where r.oid = am.member))
    as appartenances_orphelines,
  (select count(*)
     from pg_catalog.pg_stat_activity a
    where a.usesysid is not null
      and not exists (select 1 from pg_catalog.pg_roles r where r.oid = a.usesysid))
    as sessions_sans_role;

-- C2. La migration est inscrite à l'historique. Attendu : une ligne.
select version, name from supabase_migrations.schema_migrations where version = '20261117110000';
```

- `sessions_sans_role` supérieur à zéro : une session de l'ancien rôle était ouverte pendant la suppression.
  Elle n'a plus aucun droit propre et disparaît à sa déconnexion ; le propriétaire peut la fermer.
- Détection de dérive : l'étape « Detect production schema drift » du workflow est verte. Si elle est rouge avec
  des lignes qui nomment `lovable_readonly`, le rôle existe encore : relire le journal de l'étape d'application.

## Si la migration refuse

Rien n'est appliqué et rien n'est inscrit à l'historique : l'état est celui d'avant. Dans un run en échec, les
étapes suivantes du workflow ne tournent pas : ni la configuration du planificateur de santé, ni le contrôle de
dérive.

- `lock timeout` ou « tuple concurrently updated » : une opération de schéma ou un `autovacuum` touchait un des
  objets. Refaire M7, puis relancer le workflow.
- Tout autre refus (option ADMIN manquante, objet possédé, politique, droit sur un objet partagé, droit accordé
  par un autre rôle, refus de `supautils`) : ne rien contourner à la main, et **ne jamais insérer de ligne à la
  main dans `supabase_migrations.schema_migrations`**. Annuler le lot entier par un revert de sa fusion : la
  migration n'étant pas inscrite, l'historique reste cohérent, les migrations suivantes ne sont plus bloquées,
  et l'exception du contrôle de dérive pour ce rôle revient avec le revert. Rendre le message à l'équipe pour un
  nouveau lot.

## Retour arrière

Il n'y en a pas, et il n'est pas prévu de recréer le rôle. Avant le commit, tout échec annule la transaction.
Après, le rôle, son mot de passe et ses droits n'existent plus. L'invariant de sécurité
`lovable-readonly-role-stays-dropped` (`npm run test:security-invariants`) interdit à toute migration
postérieure, à tout rattrapage, fichier de maintenance ou fonction Edge de nommer `lovable_readonly`. Si un
accès en lecture pour un outil externe redevient nécessaire : un nouveau rôle, sous un autre nom, dont tous les
droits sont écrits dans une migration, sur décision du propriétaire.

Après l'application, l'étape de CI « Drop the lovable_readonly role when it exists », `npm run
test:db-role-drop` et `scripts/test-drop-lovable-readonly-role.mjs` n'ont plus rien à prouver : à retirer par
un petit lot.

## Côté Lovable : à faire par le propriétaire

La suppression du rôle rend inutilisables l'identifiant et le mot de passe PostgreSQL que Lovable détenait.
Elle ne retire aucun autre accès. À vérifier, de préférence avant d'appliquer la migration :

1. **GitHub.** L'application de Lovable a écrit dans le dépôt : 173 commits de `gpt-engineer-app[bot]`, du 19
   au 22/05/2026. Vérifier, et désinstaller ou révoquer ce qui s'y trouve encore :
   - les applications GitHub installées sur le compte ou l'organisation, et celles qui ont accès au dépôt ;
   - les applications OAuth autorisées du compte ;
   - les webhooks et les clés de déploiement du dépôt.
2. **Supabase.**
   - Les applications OAuth autorisées de l'organisation : révoquer Lovable.
   - Les fonctions Edge et leurs secrets : le dépôt n'en a qu'une, `source-fetch-relay`. Toute autre fonction
     ou tout secret inconnu est à examiner.
   - Les URL de redirection de l'authentification : retirer celles qui pointent vers un domaine de Lovable.
3. **Dans Lovable**, déconnecter le projet Supabase et le dépôt GitHub, et supprimer la chaîne de connexion
   enregistrée.
4. **Secrets, à renouveler seulement s'ils ont été confiés à Lovable** (marche à suivre :
   `docs/runbooks/fuite-secret-ou-donnees.md`) :
   - `SUPABASE_SECRET_KEY` et `SUPABASE_SERVICE_ROLE_KEY` : leur renouvellement invalide les liens signés déjà
     émis ;
   - le mot de passe de `postgres`, porté par `SUPABASE_DB_URL`, `POSTGRES_URL_NON_POOLING` et `POSTGRES_URL` ;
   - `SUPABASE_ACCESS_TOKEN`.
5. Les `VITE_SUPABASE_*` (et leurs équivalents `NEXT_PUBLIC_SUPABASE_*`) sont publiques : rien à faire.
