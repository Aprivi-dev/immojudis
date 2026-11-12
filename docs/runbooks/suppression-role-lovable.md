# Supprimer le rôle PostgreSQL `lovable_readonly`

Décision du propriétaire du 12/11/2026 : ce rôle de lecture venait de l'outil Lovable, qui ne sert plus.
Migration : `supabase/migrations/20261117110000_drop_lovable_readonly_role.sql`. Seul le propriétaire
l'applique, par le workflow « Apply Supabase Migrations ». Toutes les requêtes de cette page sont en lecture
seule.

## Ce que fait la migration

- Rôle absent (CI, base d'ombre, poste local, seconde application) : rien, elle réussit.
- Rôle présent : dans une seule transaction, elle vérifie l'état, révoque un à un les droits que le catalogue
  liste pour ce rôle (privilèges par défaut d'abord), vérifie qu'il n'en reste aucun, puis `drop role`, qui
  retire aussi l'appartenance de `postgres`. Au premier refus, rien n'est appliqué.
- Elle refuse, avec un message qui dit pourquoi, si : le rôle qui applique n'a pas l'option ADMIN sur
  `lovable_readonly` (exigée par PostgreSQL 16 et 17 pour `drop role`), le rôle possède un objet, une politique
  le nomme, il a un droit dans une autre base ou sur une sorte d'objet non mesurée, ou un droit reste après
  révocation (droit accordé par un autre rôle que `postgres`).
- Verrous : aucun sur les tables. `REVOKE` modifie la ligne de l'objet dans le catalogue (`pg_class`, `pg_proc`,
  `pg_namespace`, `pg_default_acl`), tenue jusqu'au commit. Les lectures et les écritures de la collecte ne sont
  ni bloquées ni attendues ; la migration peut donc tourner pendant un lot. Seule une modification de schéma
  concurrente sur un des mêmes objets ferait attendre : `lock_timeout` de 5 s, puis échec sans effet, à relancer.
- Durée mesurée sur une base PostgreSQL 16 jetable (203 objets) : 40 à 75 ms.

## Avant : mesures en lecture seule

À refaire juste avant de lancer le workflow. La mesure du 12/11/2026 donnait : connexion permise, sans
expiration, ni superutilisateur ni `BYPASSRLS`, aucune session, 206 dépendances (199 tables, 5 fonctions, le
schéma `public`, un privilège par défaut), `postgres` membre du rôle.

```sql
-- P1. Le rôle, et celui qui applique. Attendu : postgres a rolcreaterole = true.
select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolvaliduntil
  from pg_catalog.pg_roles
 where rolname in ('lovable_readonly', 'postgres');

-- P2. Sessions ouvertes sous ce rôle. Attendu : aucune ligne.
select a.pid, a.usename, a.application_name, a.client_addr, a.backend_start, a.state
  from pg_catalog.pg_stat_activity a
 where a.usename = 'lovable_readonly';

-- P3. Tout ce qui dépend du rôle. Attendu : seulement deptype = 'a', dans la base courante, sur pg_class,
-- pg_proc, pg_namespace et pg_default_acl. Une ligne 'o' (objet possédé) ou 'r' (politique) : la migration
-- refusera.
select d.deptype, c.relname as catalogue, coalesce(db.datname, '(partagé)') as base, count(*) as total
  from pg_catalog.pg_shdepend d
  join pg_catalog.pg_roles r on r.oid = d.refobjid
  join pg_catalog.pg_class rc on rc.oid = d.refclassid and rc.relname = 'pg_authid'
  join pg_catalog.pg_class c on c.oid = d.classid
  left join pg_catalog.pg_database db on db.oid = d.dbid
 where r.rolname = 'lovable_readonly'
 group by 1, 2, 3
 order by 1, 2;

-- P4. Les droits, par rôle qui les a accordés. Attendu : SELECT et EXECUTE seulement, accordés par postgres.
-- Un autre rôle dans la colonne grantor : postgres ne pourra pas révoquer ce droit, la migration refusera.
select 'table' as sorte, g.grantor, g.privilege_type, count(*) as total
  from information_schema.role_table_grants g
 where g.grantee = 'lovable_readonly'
 group by 1, 2, 3
union all
select 'fonction', g.grantor, g.privilege_type, count(*)
  from information_schema.role_routine_grants g
 where g.grantee = 'lovable_readonly'
 group by 1, 2, 3
 order by 1, 2, 3;

-- P5. Privilèges par défaut qui nomment le rôle. Attendu : une ligne (postgres, public, r).
select setter.rolname as pose_par, n.nspname as schema, a.defaclobjtype as sorte, a.defaclacl::text as droits
  from pg_catalog.pg_default_acl a
  join pg_catalog.pg_roles setter on setter.oid = a.defaclrole
  left join pg_catalog.pg_namespace n on n.oid = a.defaclnamespace
 where a.defaclacl::text like '%lovable_readonly%';

-- P6. Appartenances. Attendu : postgres membre de lovable_readonly avec admin_option = true.
select r.rolname as role, m.rolname as membre, g.rolname as accordee_par, am.admin_option
  from pg_catalog.pg_auth_members am
  join pg_catalog.pg_roles r on r.oid = am.roleid
  join pg_catalog.pg_roles m on m.oid = am.member
  left join pg_catalog.pg_roles g on g.oid = am.grantor
 where r.rolname = 'lovable_readonly' or m.rolname = 'lovable_readonly';
```

**Ne pas lancer si** P6 montre `admin_option = false` (ou aucune ligne pour `postgres`), si P3 montre autre chose
que des lignes `a` sur les quatre catalogues, ou si P4 montre un autre `grantor` que `postgres` : la migration
refuserait, et **une migration qui échoue bloque toutes celles qui la suivent** dans le workflow. Dans ce cas,
corriger d'abord (voir « Si la migration refuse »).

Une session ouverte (P2) n'empêche pas la suppression : PostgreSQL supprime le rôle, la session continue sans
aucun droit propre jusqu'à sa déconnexion. Mieux vaut qu'il n'y en ait pas : révoquer d'abord la connexion côté
Lovable (dernière section).

## Application

1. Fusionner le lot dans `main`, attendre que la CI du commit soit verte.
2. Vérifier ce qui est en attente : la migration `20261117110000` s'applique avec toutes les migrations en
   attente avant elle, dans l'ordre. Si un autre lot est en attente, suivre aussi son runbook (créneau hors
   collecte, par exemple).
3. Lancer « Apply Supabase Migrations » depuis `main`, avec `confirm_target` = `production`.
4. Dans le journal de l'étape « Apply pending migrations », lire l'avis
   `Rôle lovable_readonly supprimé : 206 objet(s) révoqué(s)`. Le nombre est celui de P3.

### Ordre de livraison et contrôle de dérive

Le même lot retire du contrôle de dérive la liste qui ignorait les droits de ce rôle
(`scripts/lib/schema-drift.mjs`). Vérifié dans les workflows :

- en CI (`.github/workflows/ci.yml`), le contrôle compare une base éphémère où le rôle n'a jamais existé : il n'y
  avait rien à ignorer, le retrait de la liste n'y change rien ;
- en production, le contrôle ne tourne qu'à la dernière étape de « Apply Supabase Migrations » (« Detect
  production schema drift », après « Apply pending migrations ») et à la fin de `npm run release:prepare` (après
  `db:migrate`). Dans les deux cas le rôle est déjà supprimé. Aucune tâche planifiée ne lance ce contrôle.

Conséquence : entre la fusion et l'application, un `npm run check:schema-drift -- --remote` lancé à la main
sortirait rouge, avec les 206 lignes de droits du rôle. C'est attendu, et cela disparaît avec la migration.

## Après : contrôles

```sql
-- C1. Attendu : zéro partout.
select
  (select count(*) from pg_catalog.pg_roles where rolname = 'lovable_readonly') as role_present,
  (select count(*) from pg_catalog.pg_default_acl a where a.defaclacl::text like '%lovable_readonly%')
    as privileges_par_defaut,
  (select count(*) from pg_catalog.pg_default_acl a where a.defaclacl::text ~ '[{,][0-9]+=')
    as privileges_par_defaut_orphelins,
  (select count(*) from pg_catalog.pg_class c where c.relacl::text ~ '(lovable_readonly|[{,][0-9]+)=')
    as droits_de_tables_restants,
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

Rien n'est appliqué et rien n'est inscrit à l'historique : l'état est celui d'avant. Le message dit la cause.

- `lock timeout` : une modification de schéma était en cours sur un des objets. Relancer le workflow.
- Option ADMIN manquante, objet possédé, politique, droit accordé par un autre rôle, ou refus de la plateforme
  Supabase (son extension `supautils` filtre certaines opérations sur les rôles ; ce cas n'a pas pu être essayé
  hors production) : ne pas contourner à la main. Rendre le message à l'équipe. Comme la migration n'est pas
  inscrite, son fichier peut encore être corrigé par un nouveau lot ; tant qu'elle échoue, les migrations
  suivantes attendent.

## Retour arrière

Il n'y en a pas, et il n'est pas prévu de recréer le rôle. Avant le commit, tout échec annule la transaction.
Après, le rôle, son mot de passe et ses droits n'existent plus. L'invariant de sécurité
`lovable-readonly-role-stays-dropped` (`npm run test:security-invariants`) interdit à toute migration postérieure
de nommer `lovable_readonly`. Si un accès en lecture pour un outil externe redevient nécessaire : un nouveau
rôle, sous un autre nom, dont tous les droits sont écrits dans une migration, sur décision du propriétaire.

## Côté Lovable : à faire par le propriétaire

La suppression du rôle rend inutilisables l'identifiant et le mot de passe que Lovable détenait. Il reste à
retirer l'accès du côté de l'outil :

1. Dans Lovable, déconnecter le projet Supabase et supprimer la chaîne de connexion enregistrée (de préférence
   avant d'appliquer la migration, pour qu'aucune session ne soit ouverte).
2. Dans le tableau de bord Supabase, vérifier que Lovable ne figure plus parmi les applications ou intégrations
   autorisées du compte et de l'organisation, et révoquer l'autorisation si elle y est.
3. Si une clé d'API du projet (`anon`, `service_role`) ou un jeton d'accès personnel a un jour été confié à
   Lovable, ce rôle n'en dépend pas : la suppression ne les invalide pas. Les renouveler est une décision à
   part (`docs/runbooks/fuite-secret-ou-donnees.md` pour la marche à suivre).
