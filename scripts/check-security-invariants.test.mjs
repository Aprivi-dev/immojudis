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
import { afterAll, describe, expect, it } from "vitest";

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
