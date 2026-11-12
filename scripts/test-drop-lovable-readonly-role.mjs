// Exerce le chemin « rôle présent » de la migration de suppression du rôle lovable_readonly sur la base
// Supabase LOCALE (CI : image supabase/postgres en PostgreSQL 17, extension supautils chargée, `postgres` non
// superutilisateur), que le rejeu des migrations ne parcourt jamais puisque le rôle n'y existe pas.
//
// Le script crée le rôle sous le rôle de connexion, lui donne des droits de la forme mesurée en production
// (SELECT sur des tables et une vue de public, EXECUTE sur une fonction de app_private, USAGE sur public, un
// privilège par défaut), puis exécute le fichier de migration lui-même, sans en recopier le SQL, et vérifie
// qu'il ne reste rien du rôle. Runbook : docs/runbooks/suppression-role-lovable.md.
//
// Il refuse toute base qui n'est pas sur la machine locale, et toute base où le rôle de connexion est
// superutilisateur ou où supautils n'est pas chargé (la preuve n'y vaudrait rien). À retirer, avec son étape de CI, une fois la
// migration appliquée en production : il n'a alors plus rien à prouver.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const ROLE = "lovable_readonly";
const databaseUrl =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const migrationsDirectory = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "supabase",
  "migrations",
);
const migrationFiles = readdirSync(migrationsDirectory).filter((file) =>
  file.endsWith("_drop_lovable_readonly_role.sql"),
);
if (migrationFiles.length !== 1) {
  console.error(
    `[role-drop-test] Une seule migration *_drop_lovable_readonly_role.sql attendue, ${migrationFiles.length} trouvée(s).`,
  );
  process.exit(1);
}
const migration = readFileSync(join(migrationsDirectory, migrationFiles[0]), "utf8");

// Le client ne se connecte qu'à la première requête. La garde lit les hôtes que le pilote a retenus, et non
// ceux qu'un autre analyseur d'URL croirait lire : `u@distant,x:1@127.0.0.1` se lit `127.0.0.1` par `new URL`,
// alors que le pilote se connecterait à `distant`. Aucun socket Unix non plus.
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const hosts = [sql.options.host].flat();
if (
  sql.options.path ||
  hosts.length === 0 ||
  !hosts.every((host) => ["127.0.0.1", "localhost", "::1"].includes(host))
) {
  console.error(
    "[role-drop-test] Refusé : ce test crée puis supprime un rôle, il ne tourne que sur une base locale (127.0.0.1, localhost ou ::1).",
  );
  process.exit(1);
}

// Ce qui nomme encore le rôle, par son nom ou par son identifiant resté sans rôle.
const leftovers = (roleOid) => sql`
  select
    (select count(*)::integer from pg_catalog.pg_roles where rolname = ${ROLE}) as role,
    (select count(*)::integer from pg_catalog.pg_shdepend d
      where d.refclassid = 'pg_catalog.pg_authid'::regclass and d.refobjid = ${roleOid}::oid)
      as dependencies,
    (select count(*)::integer from pg_catalog.pg_auth_members m
      where m.roleid = ${roleOid}::oid or m.member = ${roleOid}::oid) as memberships,
    (select count(*)::integer from pg_catalog.pg_default_acl a
      where a.defaclacl::text like ${`%${ROLE}%`}) as default_privileges
`;

try {
  const [context] = await sql`
    select current_setting('server_version') as version, current_user as applier,
           r.rolsuper as superuser, r.rolcreaterole as createrole,
           (select count(*)::integer from pg_catalog.pg_settings where name like 'supautils.%')
             as supautils_settings
      from pg_catalog.pg_roles r
     where r.rolname = current_user
  `;
  // La preuve ne vaut que sous le régime de la production : un rôle non superutilisateur, sous supautils.
  if (context.superuser !== false || context.supautils_settings === 0) {
    throw new Error(
      `cette base ne ressemble pas à la production : la preuve ne vaut pas (${JSON.stringify(context)})`,
    );
  }
  if ((await leftovers(0))[0].role !== 0) {
    throw new Error(`le rôle ${ROLE} existe déjà dans cette base : le test n'y touche pas.`);
  }

  await sql.unsafe(`
    create role ${ROLE} login;
    grant usage on schema public to ${ROLE};
    grant select on table public.auction_sales, public.tribunals, public.v_auction_sales_app to ${ROLE};
    grant execute on function app_private.public_sale_conditions(pg_catalog.jsonb) to ${ROLE};
    alter default privileges in schema public grant select on tables to ${ROLE};
  `);
  const [{ oid: roleOid }] = await sql`select oid from pg_catalog.pg_roles where rolname = ${ROLE}`;
  const [before] = await leftovers(roleOid);
  // Trois relations, une fonction, un schéma, un privilège par défaut.
  if (before.dependencies !== 6 || before.default_privileges !== 1) {
    throw new Error(`mise en place inattendue : ${JSON.stringify(before)}`);
  }

  await sql.unsafe(migration);

  const [after] = await leftovers(roleOid);
  if (Object.values(after).some((count) => count !== 0)) {
    throw new Error(`il reste quelque chose du rôle après la migration : ${JSON.stringify(after)}`);
  }
  console.log(
    JSON.stringify({ ok: true, migration: migrationFiles[0], ...context, before, after }),
  );
} catch (error) {
  console.error(
    `[role-drop-test] ÉCHEC : ${error?.message ?? error} (si le rôle ${ROLE} est resté dans la base locale, la recréer par supabase db reset)`,
  );
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
