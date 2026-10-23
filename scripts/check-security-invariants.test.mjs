import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxes = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * Le script lit tout par rapport à son propre emplacement : on le copie dans un dépôt factice dont
 * les migrations sont celles du dépôt, plus les fichiers `extraMigrations`.
 */
function runInvariants(extraMigrations = {}, omittedMigrations = []) {
  const root = mkdtempSync(join(tmpdir(), "immojudis-invariants-"));
  sandboxes.push(root);
  for (const entry of readdirSync(repo)) {
    if (["scripts", "supabase", "node_modules", ".git", ".claude"].includes(entry)) continue;
    symlinkSync(join(repo, entry), join(root, entry));
  }
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    join(repo, "scripts/check-security-invariants.mjs"),
    join(root, "scripts/check-security-invariants.mjs"),
  );
  mkdirSync(join(root, "supabase/migrations"), { recursive: true });
  for (const file of readdirSync(join(repo, "supabase/migrations"))) {
    if (omittedMigrations.includes(file)) continue;
    symlinkSync(join(repo, "supabase/migrations", file), join(root, "supabase/migrations", file));
  }
  for (const [name, sql] of Object.entries(extraMigrations)) {
    writeFileSync(join(root, "supabase/migrations", name), sql);
  }
  return spawnSync(process.execPath, [join(root, "scripts/check-security-invariants.mjs")], {
    encoding: "utf8",
  });
}

const accessFunction = (condition) => `
create or replace function app_private.has_active_analysis_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select app_private.launch_offer_active()${condition};
$function$;
`;

describe("invariants de sécurité : offre de lancement", () => {
  it("passe sur les migrations du dépôt", () => {
    const result = runInvariants();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuse une fonction d'accès, postérieure à l'email confirmé, qui ignore l'éligibilité", () => {
    const result = runInvariants({
      "99990101000000_bad_access.sql": accessFunction(""),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "99990101000000_bad_access.sql redefines has_active_analysis_access without launch_offer_account_eligible",
    );
  });

  it("accepte la même fonction quand elle appelle launch_offer_account_eligible(", () => {
    const result = runInvariants({
      "99990101000000_good_access.sql": accessFunction(
        "\n  and app_private.launch_offer_account_eligible(p_user_id)",
      ),
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

const invokerCaller = `
create or replace function app_private.zz_invoker_helper(p numeric)
returns numeric
language sql
immutable
set search_path = ''
as $function$
  select p;
$function$;

create or replace function public.zz_invoker_caller(p numeric)
returns numeric
language sql
stable
set search_path = ''
as $function$
  select app_private.zz_invoker_helper(p);
$function$;

grant execute on function public.zz_invoker_caller(numeric) to service_role;
`;

describe("invariants de sécurité : fonctions appelées par une fonction non definer", () => {
  it("refuse une fonction app_private appelée par service_role sans droit d'exécution", () => {
    const result = runInvariants({ "99990101000000_invoker.sql": invokerCaller });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.zz_invoker_caller(numeric) -> app_private.zz_invoker_helper(numeric): the callee is not granted to service_role",
    );
  });

  it("accepte la même fonction une fois accordée à service_role", () => {
    const result = runInvariants({
      "99990101000000_invoker.sql": `${invokerCaller}
grant execute on function app_private.zz_invoker_helper(numeric) to service_role;
`,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("échoue sans la migration qui accorde starting_price_band à service_role", () => {
    const result = runInvariants({}, ["20261031100600_grant_starting_price_band.sql"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("-> app_private.starting_price_band(numeric): the callee");
  });

  const overload = `
create or replace function app_private.zz_invoker_helper(p text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select p;
$function$;
`;

  it("voit une surcharge non accordée quand l'autre l'est (clé par signature)", () => {
    const result = runInvariants({
      "99990101000000_invoker.sql": `${invokerCaller}${overload}
grant execute on function app_private.zz_invoker_helper(numeric) to service_role;
`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.zz_invoker_caller(numeric) -> app_private.zz_invoker_helper(text): the callee is not granted to service_role",
    );
    expect(result.stderr).not.toContain("zz_invoker_helper(numeric): the callee");
  });

  it("accepte les deux surcharges une fois chacune accordée, quelle que soit l'écriture des types", () => {
    const result = runInvariants({
      "99990101000000_invoker.sql": `${invokerCaller}${overload}
grant execute on function app_private.zz_invoker_helper(p numeric) to service_role;
grant execute on function app_private.zz_invoker_helper(text) to service_role;
`,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("normalise les alias de types (int, double precision, varchar(n), tableaux, OUT)", () => {
    const sql = `
create or replace function app_private.zz_alias_helper(a int, b float8, c varchar(10), d timestamptz[], out e text)
returns record
language sql
set search_path = ''
as $function$ select 1, 'x'; $function$;

create or replace function public.zz_alias_caller()
returns integer
language sql
set search_path = ''
as $function$ select 1 from app_private.zz_alias_helper(1, 1, 'x', null); $function$;

grant execute on function public.zz_alias_caller() to service_role;
`;
    const refused = runInvariants({ "99990101000000_alias.sql": sql });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "app_private.zz_alias_helper(integer,double precision,character varying,timestamp with time zone[])",
    );
    const granted = runInvariants({
      "99990101000000_alias.sql": `${sql}
grant execute on function app_private.zz_alias_helper(integer, double precision, character varying(10), timestamp with time zone[]) to service_role;
`,
    });
    expect(granted.stderr).toBe("");
    expect(granted.status).toBe(0);
  });
});
