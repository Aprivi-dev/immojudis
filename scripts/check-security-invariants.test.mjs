import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// Chaque test lance le script d'invariants sur un dépôt factice (un processus Node, 2,5 à 5,5 s à vide) : sous
// charge, le délai par défaut de 5 s est trop juste. 20 s pour tout le fichier.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandboxes = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * `src/` du dépôt factice : les dossiers qui mènent à un fichier remplacé ou ajouté sont réels, tout le
 * reste est un lien vers le dépôt.
 */
function mirrorSource(root, overrides) {
  const directories = new Set(["src"]);
  for (const path of Object.keys(overrides)) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      directories.add(parts.slice(0, depth).join("/"));
    }
  }
  const mirror = (relative) => {
    mkdirSync(join(root, relative), { recursive: true });
    const real = new Set(directories);
    const entries = (() => {
      try {
        return readdirSync(join(repo, relative));
      } catch {
        return [];
      }
    })();
    for (const entry of entries) {
      const child = `${relative}/${entry}`;
      if (real.has(child)) mirror(child);
      else symlinkSync(join(repo, child), join(root, child));
    }
    for (const child of directories) {
      if (child.startsWith(`${relative}/`) && !child.slice(relative.length + 1).includes("/")) {
        if (!entries.includes(child.slice(relative.length + 1))) mirror(child);
      }
    }
  };
  mirror("src");
  for (const [path, content] of Object.entries(overrides)) {
    const target = join(root, path);
    try {
      unlinkSync(target);
    } catch {
      // fichier nouveau
    }
    writeFileSync(target, content);
  }
}

/**
 * Le script lit tout par rapport à son propre emplacement : on le copie dans un dépôt factice dont
 * les migrations sont celles du dépôt, plus les fichiers `extraMigrations`.
 */
function runInvariants(extraMigrations = {}, omittedMigrations = [], sourceOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "immojudis-invariants-"));
  sandboxes.push(root);
  const overridden = Object.keys(sourceOverrides);
  for (const entry of readdirSync(repo)) {
    if (["scripts", "supabase", "node_modules", ".git", ".claude"].includes(entry)) continue;
    if (entry === "src" && overridden.length) continue;
    symlinkSync(join(repo, entry), join(root, entry));
  }
  if (overridden.length) mirrorSource(root, sourceOverrides);
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

describe("invariants de sécurité : indépendance de la règle des pépites", () => {
  const reasons = (extra) => ({
    "src/lib/pepite-reasons.ts": `${extra}\nexport const placeholder = 1;\n`,
  });

  it("passe sur les sources du dépôt", () => {
    const run = runInvariants();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("refuse un module atteint dont un dossier du chemin évoque les avocats", () => {
    const run = runInvariants({}, [], {
      ...reasons('import "@/lib/lawyers/rank";'),
      "src/lib/lawyers/rank.ts": "export const rank = 1;\n",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("src/lib/lawyers/rank.ts");
  });

  it.each(["sponsored-boost", "featured-sales", "placement-order"])(
    "refuse un module atteint nommé %s",
    (name) => {
      const run = runInvariants({}, [], {
        ...reasons(`import "./${name}";`),
        [`src/lib/${name}.ts`]: "export const value = 1;\n",
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`src/lib/${name}.ts`);
    },
  );

  it("refuse que la règle atteigne le contrôle d'indépendance de l'administration", () => {
    const run = runInvariants({}, [], reasons('import "@/lib/admin-pepites";'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("src/lib/admin-pepites.ts");
  });

  it("refuse la lecture de investment_score dans un module de calcul atteint, pas seulement dans l'entrée", () => {
    const run = runInvariants({}, [], {
      ...reasons('import "./pepite-extra";'),
      "src/lib/pepite-extra.ts": 'export const column = "investment_score";\n',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("src/lib/pepite-extra.ts");
    expect(run.stderr).toContain("investment_score");
  });

  it("refuse la lecture d'une colonne d'avocat dans un module de calcul atteint", () => {
    const run = runInvariants({}, [], {
      ...reasons('import "./pepite-extra";'),
      "src/lib/pepite-extra.ts": 'export const column = "lawyer_name";\n',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("src/lib/pepite-extra.ts");
  });

  it("ignore un commentaire qui cite investment_score", () => {
    const run = runInvariants({}, [], {
      ...reasons('import "./pepite-extra";'),
      "src/lib/pepite-extra.ts": "// jamais investment_score\nexport const value = 1;\n",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("n'examine pas le texte d'un module atteint hors du calcul (types générés, par exemple)", () => {
    const run = runInvariants({}, [], {
      ...reasons('import "./generated-types";'),
      "src/lib/generated-types.ts": "export type Row = { investment_score: number };\n",
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("échoue sur un import « @/ » qui ne se résout pas", () => {
    const run = runInvariants({}, [], reasons('import "@/lib/module-introuvable";'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("@/lib/module-introuvable");
    expect(run.stderr).toContain("cannot be resolved");
  });

  it("échoue sur un import relatif qui ne se résout pas", () => {
    const run = runInvariants({}, [], reasons('import "./module-introuvable";'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("./module-introuvable");
  });
});

describe("invariants de sécurité : aucun montant de pépite sans le droit", () => {
  const routePath = "src/app/api/sales/[id]/pepite/route.ts";
  const route = readFileSync(join(repo, routePath), "utf8");
  const mutate = (apply) => {
    const mutated = apply(route);
    // Une mutation qui ne change rien ne prouverait rien.
    expect(mutated).not.toBe(route);
    return runInvariants({}, [], { [routePath]: mutated });
  };

  it("passe sur les sources du dépôt", () => {
    const run = runInvariants();
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("M1 : refuse une clé de droit changée", () => {
    const run = mutate((text) => text.replace('"property.bidCeiling"', '"property.valueEstimate"'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("property.bidCeiling");
  });

  it("M2 : refuse un contrôle de droit sans await (la promesse ne serait pas attendue)", () => {
    const run = mutate((text) =>
      text.replace("await assertFeatureEntitlementVia(", "assertFeatureEntitlementVia("),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("await assertFeatureEntitlementVia");
  });

  it("M3 : refuse un contrôle de droit qui ne porte plus la vente ({ saleId })", () => {
    const run = mutate((text) => text.replace("{ saleId },", "{},"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("{ saleId }");
  });

  it("M4 : refuse un détail servi avec l'en-tête public", () => {
    const run = mutate((text) =>
      text.replace("{ headers: PRIVATE_HEADERS }", "{ headers: PUBLIC_HEADERS }"),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("PRIVATE_HEADERS only");
  });

  it("M4 bis : refuse un en-tête privé qui n'interdit plus le cache partagé", () => {
    const run = mutate((text) => text.replace('"private, no-store"', '"public, max-age=60"'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("private, no-store");
  });

  it("M5 : refuse un contrôle de droit sorti du bloc detailRequested", () => {
    const run = mutate((text) =>
      text
        .replace(/await assertFeatureEntitlementVia\([\s\S]*?\{ saleId \},?\s*\);/, "")
        .replace(
          "const saleId = saleIdSchema",
          'await assertFeatureEntitlementVia(auth, "property.bidCeiling", "x", { saleId });\n    const saleId = saleIdSchema',
        ),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("inside its first detailRequested block");
  });

  it("refuse une route qui monte le détail hors d'un bloc detailRequested", () => {
    const run = mutate((text) =>
      text.replace(
        "if (detailRequested) {\n      // Le détail ne part que d'ici",
        "{\n      // Le détail ne part que d'ici",
      ),
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("outside a detailRequested block");
  });

  it("refuse une route qui lit la ligne privée avant de vérifier le droit", () => {
    const run = mutate((text) =>
      text.replace(
        "if (detailRequested) {",
        "await readStoredPepite(saleId);\n    if (detailRequested) {",
      ),
    );
    expect(run.status).toBe(1);
  });

  it("liste blanche : refuse un autre fichier de src/ qui nomme la table privée", () => {
    const run = runInvariants({}, [], {
      "src/lib/zz-offender.ts": 'export const table = "auction_sale_pepites";\n',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("src/lib/zz-offender.ts names the private table");
  });

  it("liste blanche : accepte un commentaire, et les tests", () => {
    const run = runInvariants({}, [], {
      "src/lib/zz-comment.ts":
        "// la table auction_sale_pepites est privée\nexport const value = 1;\n",
      "src/lib/zz-offender.test.ts": 'export const table = "auction_sale_pepites";\n',
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("cartes de référence privées : refuse un autre fichier de src/ qui nomme la table des loyers", () => {
    for (const table of ["anil_rents", "commune_housing_tension"]) {
      const run = runInvariants({}, [], {
        "src/lib/zz-rents.ts": `export const table = "${table}";\n`,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("src/lib/zz-rents.ts names a private reference table");
    }
  });

  it("cartes de référence privées : accepte un commentaire et les tests", () => {
    const run = runInvariants({}, [], {
      "src/lib/zz-comment.ts": "// la table anil_rents est privée\nexport const value = 1;\n",
      "src/lib/zz-rents.test.ts": 'export const table = "anil_rents";\n',
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("refuse que la liste publique lise la table privée ou son détail", () => {
    const run = runInvariants({}, [], {
      "src/lib/pepite-sale-ids.ts":
        'export const read = () => supabaseAdmin.from("auction_sale_pepites").select("details");\n',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("src/lib/pepite-sale-ids.ts reads the private pepite table");
  });

  it("refuse qu'un module du navigateur importe la règle ou un module serveur", () => {
    const run = runInvariants({}, [], {
      "src/components/sale-detail/PepiteBlock.tsx":
        'import { PEPITE_CRITERIA } from "@/lib/pepite-policy";\nexport const PepiteBlock = () => null;\n',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("PepiteBlock.tsx imports the pepite rule or a server module");
  });
});

const migration = (name) => readFileSync(join(repo, "supabase/migrations", name), "utf8");

describe("invariants de sécurité : risque d'inondation", () => {
  it("refuse un module qui importe le magasin de la table d'inondation hors liste blanche", () => {
    const result = runInvariants({}, [], {
      "src/lib/rogue-flood-reader.ts":
        'import { readStoredFloodRisks } from "@/lib/flood-risk-store.server";\nexport const rows = readStoredFloodRisks;\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/lib/rogue-flood-reader.ts imports the flood risk store: only the flood batch, the commune sync and the pepite batch may",
    );
  });

  it("refuse un module qui nomme la table privée d'inondation", () => {
    const result = runInvariants({}, [], {
      "src/lib/rogue-flood-table.ts": 'export const table = "auction_sale_flood_risk";\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/lib/rogue-flood-table.ts names the private table auction_sale_flood_risk",
    );
  });

  it("refuse la migration de la table d'inondation sans row level security", () => {
    const file = "20261106100200_sale_flood_risk.sql";
    const bad = migration(file).replace(
      /alter table public\.auction_sale_flood_risk enable row level security;/i,
      "",
    );
    expect(bad).not.toBe(migration(file));
    const result = runInvariants({ [file]: bad }, [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${file} does not enable row level security on public.auction_sale_flood_risk`,
    );
  });

  it("refuse un droit donné à anon ou authenticated sur la table d'inondation", () => {
    const file = "20261106100200_sale_flood_risk.sql";
    for (const role of ["anon", "authenticated"]) {
      const bad = `${migration(file)}\ngrant select on table public.auction_sale_flood_risk to ${role};\n`;
      const result = runInvariants({ [file]: bad }, [file]);
      expect(result.status, role).toBe(1);
      expect(result.stderr).toContain(
        `${file} grants a right on the flood risk objects to anon, authenticated or public`,
      );
    }
  });

  it("refuse l'enveloppe publique des pépites exposées en SECURITY DEFINER", () => {
    const file = "20261106100400_pepite_flood_exposed_ids.sql";
    const original = migration(file);
    const bad = original.replace(
      /(create or replace function public\.list_public_pepite_flood_exposed_ids\(\)\nreturns setof uuid\nlanguage sql\nstable\n)/,
      "$1security definer\n",
    );
    expect(bad).not.toBe(original);
    const result = runInvariants({ [file]: bad }, [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.list_public_pepite_flood_exposed_ids must not be SECURITY DEFINER",
    );
  });

  it("refuse une fonction SECURITY DEFINER dans la migration du bail", () => {
    const file = "20261106100500_sale_flood_risk_lease.sql";
    const bad = migration(file).replace(/security invoker/, "security definer");
    const result = runInvariants({ [file]: bad }, [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} must not define SECURITY DEFINER functions`);
  });
});

describe("invariants de sécurité : surfaces ajoutées après le 03/11/2026", () => {
  const source = (path) => readFileSync(join(repo, path), "utf8");
  const table = (name, extra = "") => `
create table if not exists public.${name} (
  id uuid primary key default gen_random_uuid()
);
${extra}
`;

  it("accepte une table récente en RLS, accessible au seul rôle de service", () => {
    const result = runInvariants({
      "99990101000000_ok_table.sql": table(
        "demo_private",
        "alter table public.demo_private enable row level security;\ngrant select on table public.demo_private to service_role;",
      ),
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuse une table récente sans row level security", () => {
    const result = runInvariants({ "99990101000000_no_rls.sql": table("demo_open") });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "99990101000000_no_rls.sql creates public.demo_open without enabling row level security",
    );
  });

  it.each(["anon", "authenticated", "public", "service_role, authenticated"])(
    "refuse un droit donné à %s sur une table récente",
    (role) => {
      const result = runInvariants({
        "99990101000000_client_grant.sql": table(
          "demo_grant",
          `alter table public.demo_grant enable row level security;\ngrant select on table public.demo_grant to ${role};`,
        ),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("grants a right on public.demo_grant");
    },
  );

  it("refuse un droit donné plus tard, dans une autre migration", () => {
    const result = runInvariants({
      "99990101000000_late_table.sql": table(
        "demo_late",
        "alter table public.demo_late enable row level security;",
      ),
      "99990102000000_late_grant.sql": "grant select on public.demo_late to anon;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "99990102000000_late_grant.sql grants a right on public.demo_late",
    );
  });

  it("ne reproche pas aux tables antérieures au 04/11/2026 leurs droits historiques", () => {
    const result = runInvariants({
      "20261103999999_old_table.sql": table(
        "demo_old",
        "grant select on public.demo_old to authenticated;",
      ),
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuse une route de cron sans authentification", () => {
    const result = runInvariants({}, [], {
      "src/app/api/cron/rogue/route.ts":
        "export async function GET() {\n  return Response.json({ ok: true });\n}\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/app/api/cron/rogue/route.ts does not authenticate: call runMonitoredCron( or cronRequestAuthorized(",
    );
  });

  it("accepte une route de cron qui appelle cronRequestAuthorized(", () => {
    const result = runInvariants({}, [], {
      "src/app/api/cron/guarded/route.ts":
        "export async function GET(request: Request) {\n  if (!cronRequestAuthorized(request)) return new Response(null, { status: 401 });\n  return Response.json({ ok: true });\n}\n",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuse admin-signups sans assertAdminAuth en tête de la lecture", () => {
    const original = source("src/lib/admin-signups.ts");
    const bad = original.replace(
      /(export async function listAdminSignups[\s\S]*?\{\n)\s*await assertAdminAuth\(authToken\);/,
      "$1",
    );
    expect(bad).not.toBe(original);
    const result = runInvariants({}, [], { "src/lib/admin-signups.ts": bad });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("listAdminSignups does not call assertAdminAuth");
  });

  it("refuse admin-signups qui lit des données avant assertAdminAuth", () => {
    const original = source("src/lib/admin-signups.ts");
    const bad = original.replace(
      /(export async function extendAdminSignupTrials[\s\S]*?\{\n)(\s*const auth = await assertAdminAuth)/,
      '$1  await supabaseAdmin.from("user_subscriptions").select("user_id");\n$2',
    );
    expect(bad).not.toBe(original);
    const result = runInvariants({}, [], { "src/lib/admin-signups.ts": bad });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("extendAdminSignupTrials reads data before assertAdminAuth");
  });

  it("refuse une fin d'essai qui lit les métadonnées du compte", () => {
    const result = runInvariants({
      "99990101000000_trial_metadata.sql": `
create or replace function app_private.signup_trial_ends_at(p_user_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path to ''
as $function$
  select (u.raw_user_meta_data ->> 'trial_ends_at')::timestamptz from auth.users u where u.id = p_user_id;
$function$;
`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("signup_trial_ends_at reads user metadata");
  });
});
