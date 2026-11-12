begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Suppression du rôle `lovable_readonly` (décision du propriétaire, 12/11/2026). Ce rôle de lecture venait de
-- l'outil Lovable, qui ne sert plus. Ses droits étaient posés hors migrations ; cinq migrations lui accordaient
-- en plus EXECUTE « si le rôle existe » (20261008102630, 20261101110000, 20261102120000, 20261103110000,
-- 20261111030117). Aucune migration postérieure à celle-ci ne doit le nommer (invariant
-- lovable-readonly-role-stays-dropped).
--
-- Mesure en production le 12/11/2026 (lecture seule) : connexion permise, sans expiration, ni superutilisateur
-- ni BYPASSRLS, aucune session ouverte, aucune politique RLS, aucun objet possédé ; 199 SELECT sur des tables
-- de public, 5 EXECUTE sur des fonctions, USAGE sur le schéma public, un privilège par défaut posé par postgres
-- (tables de public), une appartenance (postgres est membre du rôle) : 206 dépendances au catalogue partagé.
--
-- Rôle absent (base d'ombre, CI, poste local, seconde application) : rien n'est fait, la migration réussit.
--
-- Rôle présent : tout se passe dans la transaction de la migration. Au premier refus, rien n'est appliqué.
--   1. Gardes, avant toute écriture : le rôle qui applique peut supprimer celui-ci (superutilisateur, ou
--      CREATEROLE avec l'option ADMIN sur le rôle : exigence de PostgreSQL 16 et 17) ; le rôle ne possède
--      aucun objet, n'est nommé par aucune politique, n'a de dépendance dans aucune autre base, et ses droits
--      portent sur les seules sortes d'objets mesurées (tables, vues ou séquences, fonctions, schémas,
--      privilèges par défaut). Tout autre cas lève : la migration ne devine pas.
--   2. Révocations une à une, dans la liste que le catalogue donne (pg_shdepend), et non `drop owned by` :
--        * `drop owned` exige les droits du rôle (appartenance avec INHERIT). Le `postgres` qui a créé le rôle
--          n'en a que l'option ADMIN : il lui faudrait d'abord s'accorder le rôle. Une révocation ne demande
--          que d'être propriétaire de l'objet ;
--        * `drop owned` supprime aussi les objets possédés et retire le rôle des politiques sans le dire ;
--          ici ces cas lèvent ;
--        * la liste révoquée est exactement celle qui empêcherait `drop role`, comptée dans le message final.
--   3. Contrôle : plus aucune dépendance. Un droit accordé par un autre rôle que celui qui applique ne se
--      révoque pas (PostgreSQL n'émet qu'un avertissement) : il reste dans le catalogue, et la migration lève.
--   4. `drop role`. Il retire lui-même les appartenances, dont celle de postgres. Cette appartenance ne se
--      retire pas avant : c'est elle qui porte l'option ADMIN exigée par `drop role`, et postgres ne peut pas
--      révoquer une appartenance accordée par le superutilisateur d'amorçage.
--
-- Verrous. GRANT et REVOKE ne verrouillent pas la table elle-même : ils modifient sa ligne dans pg_class (et
-- pg_proc, pg_namespace, pg_default_acl), ligne tenue jusqu'au commit. Les lectures et les écritures de la
-- collecte ne sont donc ni bloquées ni attendues. Seule une opération de schéma concurrente sur un des mêmes
-- objets attendrait la fin de cette transaction, ou la ferait attendre (lock_timeout : 5 s, puis échec sans
-- effet, à relancer).
--
-- Pas de retour arrière : le rôle ne se recrée pas (docs/runbooks/suppression-role-lovable.md).

do $drop_lovable_readonly$
declare
  v_role constant name := 'lovable_readonly';
  v_role_oid oid;
  v_can_drop boolean;
  v_blocking text;
  v_revoked integer := 0;
  v_target record;
begin
  select r.oid into v_role_oid from pg_catalog.pg_roles r where r.rolname = v_role;
  if v_role_oid is null then
    raise notice 'Rôle % absent : rien à faire.', v_role;
    return;
  end if;

  select applier.rolsuper
         or (applier.rolcreaterole
             and exists (
               select 1
                 from pg_catalog.pg_auth_members membership
                where membership.roleid = v_role_oid
                  and membership.member = applier.oid
                  and membership.admin_option
             ))
    into v_can_drop
    from pg_catalog.pg_roles applier
   where applier.rolname = current_user;
  if not coalesce(v_can_drop, false) then
    raise exception
      'Suppression de % refusée : % n''est ni superutilisateur, ni doté de CREATEROLE avec l''option ADMIN sur ce rôle (pg_auth_members.admin_option). Rien n''est appliqué.',
      v_role, current_user;
  end if;

  select string_agg(
           format('%s × %s (%s)', blocking.total, blocking.catalogue, blocking.reason),
           ', ' order by blocking.catalogue, blocking.reason
         )
    into v_blocking
    from (
      select dependency.classid::regclass::text as catalogue,
             case
               when dependency.deptype = 'o' then 'objet possédé'
               when dependency.deptype = 'r' then 'politique qui nomme le rôle'
               when dependency.deptype <> 'a' then 'dépendance de type ' || dependency.deptype::text
               when dependency.dbid <> (
                 select d.oid from pg_catalog.pg_database d where d.datname = current_database()
               ) then 'droit hors de la base courante'
               else 'droit sur une sorte d''objet non prévue'
             end as reason,
             count(*) as total
        from pg_catalog.pg_shdepend dependency
       where dependency.refclassid = 'pg_catalog.pg_authid'::regclass
         and dependency.refobjid = v_role_oid
         and not (
           dependency.deptype = 'a'
           and dependency.dbid = (
             select d.oid from pg_catalog.pg_database d where d.datname = current_database()
           )
           and dependency.classid in (
             'pg_catalog.pg_class'::regclass,
             'pg_catalog.pg_proc'::regclass,
             'pg_catalog.pg_namespace'::regclass,
             'pg_catalog.pg_default_acl'::regclass
           )
         )
       group by 1, 2
    ) blocking;
  if v_blocking is not null then
    raise exception
      'Suppression de % refusée, état différent de la mesure du 12/11/2026 : %. Rien n''est appliqué.',
      v_role, v_blocking;
  end if;

  for v_target in
    select case dependency.classid
             when 'pg_catalog.pg_default_acl'::regclass then (
               select format(
                        'alter default privileges for role %I%s revoke all privileges on %s from %I',
                        setter.rolname,
                        coalesce(' in schema ' || quote_ident(namespace.nspname), ''),
                        case default_acl.defaclobjtype
                          when 'r' then 'tables'
                          when 'S' then 'sequences'
                          when 'f' then 'functions'
                          when 'T' then 'types'
                          when 'n' then 'schemas'
                        end,
                        v_role
                      )
                 from pg_catalog.pg_default_acl default_acl
                 join pg_catalog.pg_roles setter on setter.oid = default_acl.defaclrole
                 left join pg_catalog.pg_namespace namespace
                   on namespace.oid = default_acl.defaclnamespace
                where default_acl.oid = dependency.objid
             )
             when 'pg_catalog.pg_class'::regclass then (
               select format(
                        'revoke all privileges on %s %I.%I from %I',
                        case relation.relkind when 'S' then 'sequence' else 'table' end,
                        namespace.nspname,
                        relation.relname,
                        v_role
                      )
                 from pg_catalog.pg_class relation
                 join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                where relation.oid = dependency.objid
             )
             when 'pg_catalog.pg_proc'::regclass then format(
               'revoke all privileges on routine %s from %I',
               dependency.objid::regprocedure,
               v_role
             )
             when 'pg_catalog.pg_namespace'::regclass then (
               select format('revoke all privileges on schema %I from %I', namespace.nspname, v_role)
                 from pg_catalog.pg_namespace namespace
                where namespace.oid = dependency.objid
             )
           end as statement
      from (
        -- Un droit de colonne donne une ligne par colonne : la révocation sur la table les retire toutes.
        select distinct d.classid, d.objid
          from pg_catalog.pg_shdepend d
         where d.refclassid = 'pg_catalog.pg_authid'::regclass
           and d.refobjid = v_role_oid
      ) dependency
     -- Les privilèges par défaut d'abord : aucune table créée entre-temps ne reçoit de droit pour ce rôle.
     order by (dependency.classid <> 'pg_catalog.pg_default_acl'::regclass), dependency.classid, dependency.objid
  loop
    -- Un objet supprimé par une autre session depuis la lecture de la liste donne une instruction nulle :
    -- `execute` lève alors, et rien n'est appliqué.
    execute v_target.statement;
    v_revoked := v_revoked + 1;
  end loop;

  select string_agg(
           format('%s × %s', remaining.total, remaining.catalogue), ', ' order by remaining.catalogue
         )
    into v_blocking
    from (
      select d.classid::regclass::text as catalogue, count(*) as total
        from pg_catalog.pg_shdepend d
       where d.refclassid = 'pg_catalog.pg_authid'::regclass
         and d.refobjid = v_role_oid
       group by 1
    ) remaining;
  if v_blocking is not null then
    raise exception
      'Suppression de % refusée : des droits restent après révocation (%), accordés par un autre rôle que % ou accordés par % lui-même. Rien n''est appliqué.',
      v_role, v_blocking, current_user, v_role;
  end if;

  execute format('drop role %I', v_role);
  raise notice 'Rôle % supprimé : % objet(s) révoqué(s), appartenances retirées avec le rôle.',
    v_role, v_revoked;
end;
$drop_lovable_readonly$;

commit;
