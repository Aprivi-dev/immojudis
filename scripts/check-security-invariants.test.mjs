import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { removeSandboxes, repo, runInvariants } from "./check-security-invariants-harness.mjs";

// Chaque test lance le script d'invariants sur un dépôt factice (un processus Node, 2,5 à 5,5 s à vide) : sous
// charge, le délai par défaut de 5 s est trop juste. 20 s pour tout le fichier.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

// Le ménage des dépôts factices a pris 24 s pour 69 dépôts sur une machine chargée : délai propre au hook.
afterAll(removeSandboxes, 120_000);

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

describe("invariants de sécurité : colonnes brutes de auction_sales fermées à authenticated", () => {
  it("refuse que la migration d'application disparaisse (les colonnes resteraient lisibles)", () => {
    const result = runInvariants({}, ["20261110120000_hide_catalogue_raw_columns.sql"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "20261110120000_hide_catalogue_raw_columns.sql must execute app_private.set_catalogue_raw_columns_hidden(true)",
    );
  });

  it("refuse une migration ultérieure qui rend les colonnes à authenticated", () => {
    const result = runInvariants({
      "99990101000000_regrant.sql":
        "grant select (raw_payload, observations) on table public.auction_sales to authenticated;\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "99990101000000_regrant.sql grants raw_payload/observations/lawyer_contact back to authenticated",
    );
  });

  it("refuse une migration ultérieure qui remet la vue du catalogue en security_invoker", () => {
    const result = runInvariants({
      "99990101000000_invoker_view.sql":
        "do $$ begin execute 'create or replace view public.v_auction_sales_app with (security_invoker = true) as select 1'; end $$;\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "99990101000000_invoker_view.sql redefines v_auction_sales_app as an invoker view",
    );
  });

  it("n'écarte pas la vue de recherche, qui reste une vue invoker", () => {
    const result = runInvariants({
      "99990101000000_search_view.sql":
        "create or replace view public.v_auction_sales_app_search with (security_invoker = true) as select 1;\n",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuse une révocation sans vue definer gardée par la politique de lecture", () => {
    const result = runInvariants({
      "99990101000000_revoke.sql":
        "revoke select (raw_payload) on table public.auction_sales from authenticated;\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "99990101000000_revoke.sql revokes raw_payload/observations/lawyer_contact from authenticated without making v_auction_sales_app a definer view guarded by the read policy predicate",
    );
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

describe("invariants de sécurité : marché local de la règle pepite-v1.2", () => {
  const file = "20261109130100_commune_market_trends.sql";

  it("passe sur les sources et la migration du dépôt", () => {
    const result = runInvariants();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuse un module qui nomme l'agrégat privé hors du module de lecture de la règle", () => {
    const result = runInvariants({}, [], {
      "src/lib/rogue-market-reader.ts": 'export const table = "commune_market_trends";\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/lib/rogue-market-reader.ts names the private commune_market_trends aggregate",
    );
  });

  // Un cas par test (chacun lance le script une fois, sous son propre délai) : cinq lancements dans un même
  // test dépassaient le délai de 20 s sur un runner chargé.
  it.each([
    ["src/lib/pepite-badges.ts", "investment_score"],
    ["src/lib/pepite-copro.ts", "lawyer_name"],
    ["src/lib/pepite-energy.ts", "paid_placement_status"],
    ["src/lib/pepite-market.ts", "sponsored"],
    ["src/lib/pepite-context.server.ts", "referenced_lawyers"],
  ])(
    "refuse que les nouveaux modules de la règle lisent un avocat, un sponsoring ou investment_score : %s (%s)",
    (module, column) => {
      const result = runInvariants({}, [], {
        [module]: `export const column = "${column}";\n`,
      });
      expect(result.status, module).toBe(1);
      expect(result.stderr, module).toContain(module);
    },
  );

  it("refuse la migration de l'agrégat sans row level security", () => {
    const bad = migration(file).replace(
      /alter table app_private\.commune_market_trends enable row level security;/i,
      "",
    );
    expect(bad).not.toBe(migration(file));
    const result = runInvariants({ [file]: bad }, [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} does not enable row level security on the aggregate`);
  });

  it("refuse un droit donné à anon, authenticated ou public sur l'agrégat ou ses fonctions", () => {
    for (const role of ["anon", "authenticated", "public"]) {
      const bad = `${migration(file)}\ngrant select on table app_private.commune_market_trends to ${role};\n`;
      const result = runInvariants({ [file]: bad }, [file]);
      expect(result.status, role).toBe(1);
      expect(result.stderr).toContain(
        `${file} grants a right on the commune market trends objects to anon, authenticated or public`,
      );
    }
  });

  it("refuse un recalcul qui n'est pas SECURITY DEFINER à chemin de recherche vide", () => {
    const bad = migration(file).replace(
      /(create or replace function app_private\.refresh_commune_market_trends[\s\S]*?)security definer\n/,
      "$1",
    );
    expect(bad).not.toBe(migration(file));
    const result = runInvariants({ [file]: bad }, [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "app_private.refresh_commune_market_trends must be SECURITY DEFINER with an empty search_path",
    );
  });

  it("refuse la lecture publique en SECURITY DEFINER", () => {
    const bad = migration(file).replace(
      /(create or replace function public\.get_commune_market_trends[\s\S]*?)security invoker/,
      "$1security definer",
    );
    expect(bad).not.toBe(migration(file));
    const result = runInvariants({ [file]: bad }, [file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.get_commune_market_trends must not be SECURITY DEFINER",
    );
  });
});

describe("invariants de sécurité : le rôle lovable_readonly reste supprimé", () => {
  const dropMigration = "20261117110000_drop_lovable_readonly_role.sql";
  const conditionalGrant = `
do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'lovable_readonly') then
    execute 'grant select on public.auction_sales to lovable_readonly';
  end if;
end $$;
`;

  it("refuse une migration postérieure qui nomme le rôle, même sous condition d'existence", () => {
    const result = runInvariants({ "99990101000000_regrant.sql": conditionalGrant });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `99990101000000_regrant.sql names the role lovable_readonly, dropped by ${dropMigration}`,
    );
  });

  it("refuse le nom du rôle dans un simple commentaire d'une migration postérieure", () => {
    const result = runInvariants({
      "99990101000000_comment.sql": "-- comme pour LOVABLE_READONLY\nselect 1;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("99990101000000_comment.sql names the role lovable_readonly");
  });

  it("ne reproche rien aux migrations antérieures ni à une migration postérieure qui ne le nomme pas", () => {
    const result = runInvariants({
      "20261117109999_before.sql": "-- droits de lovable_readonly\nselect 1;",
      "99990101000000_after.sql": "select 1;",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuse le dépôt sans la migration de suppression", () => {
    const result = runInvariants({}, [dropMigration]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${dropMigration} must exist and drop the role lovable_readonly`,
    );
  });

  it("refuse une migration de suppression dont le drop role n'est qu'en commentaire", () => {
    const result = runInvariants(
      {
        [dropMigration]:
          "-- drop role lovable_readonly;\n/* drop role lovable_readonly; */\nselect 1;",
      },
      [dropMigration],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${dropMigration} must exist and drop the role lovable_readonly (outside comments)`,
    );
  });

  it.each([
    "supabase/repairs/99990101000000_regrant.sql",
    "supabase/maintenance/99990101000000_regrant.sql",
    "supabase/functions/demo/index.ts",
  ])("refuse le nom du rôle dans %s", (path) => {
    const result = runInvariants({}, [], {}, { [path]: "-- grant select to lovable_readonly\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path} names the role lovable_readonly`);
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
      /(export async function listAdminSignups[\s\S]*?\{\n)\s*(?:const auth = )?await assertAdminAuth\(authToken\);/,
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

describe("invariants de sécurité : journal et noyau de publication de l'agent d'information", () => {
  it("refuse une écriture accordée au rôle de service sur le journal", () => {
    const result = runInvariants({
      "99990101000000_publication_journal_insert.sql":
        "grant insert, update on table public.information_agent_fact_publications to service_role;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "grants more than SELECT to service_role on public.information_agent_fact_publications",
    );
  });

  it("refuse une politique qui ouvrirait le journal", () => {
    const result = runInvariants({
      "99990101000000_publication_journal_policy.sql":
        "create policy journal_read on public.information_agent_fact_publications for select to authenticated using (true);",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "opens public.information_agent_fact_publications with a policy",
    );
  });

  it("refuse un noyau de publication exécutable par un rôle de l'API", () => {
    const result = runInvariants({
      "99990101000000_publication_core_grant.sql":
        "grant execute on function app_private.apply_information_agent_fact(uuid, text, uuid, text) to service_role;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "grants app_private.apply_information_agent_fact to an API role",
    );
  });
});

describe("invariants de sécurité : un seul chemin de publication automatique (étape 6)", () => {
  const coreCall = (call) => `
create or replace function app_private.publish_automatically(p_fact_id uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  ${call}
end;
$$;`;

  it.each([
    [
      "'auto'",
      "return app_private.apply_information_agent_fact(p_fact_id, 'auto', null, 'v1');",
      "with actor 'auto'",
    ],
    [
      "une variable",
      "return app_private.apply_information_agent_fact(p_fact_id, p_kind, null, 'v1');",
      "with actor p_kind",
    ],
    [
      "un identifiant entre guillemets",
      `return app_private."apply_information_agent_fact"(p_fact_id, 'auto', null, 'v1');`,
      "with actor 'auto'",
    ],
    [
      "un appel non qualifié (search_path)",
      "return apply_information_agent_fact(p_fact_id, 'auto', null, 'v1');",
      "with actor 'auto'",
    ],
    [
      "'admin' caché dans un argument imbriqué",
      "return app_private.apply_information_agent_fact(coalesce(p_fact_id, 'admin'), p_kind, null, 'v1');",
      "with actor p_kind",
    ],
  ])("refuse un appel du noyau avec %s", (_label, call, message) => {
    const result = runInvariants({ "99990101000000_auto_publish.sql": coreCall(call) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`calls app_private.apply_information_agent_fact ${message}`);
  });

  it("refuse le nom du noyau, même partiel, dans du SQL dynamique", () => {
    const result = runInvariants({
      "99990101000000_auto_publish_dynamic.sql": coreCall(
        "execute format('select app_private.%I($1, %L, null, %L)', 'apply_information_agent_' || 'fact', 'auto', 'v1') using p_fact_id;",
      ),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("in dynamic SQL (execute)");
  });

  it.each([
    [
      "le retrait du verrou du mode automatique hors de la migration de l'étape 6",
      "alter table public.information_agent_auto_publication_settings drop constraint information_agent_auto_publication_settings_auto_locked;",
      "drops or renames information_agent_auto_publication_settings_auto_locked: the locks of step 3 are lifted by 20261211100000_information_agent_auto_publication_live.sql only",
    ],
    [
      "le retrait entre guillemets",
      'alter table public.information_agent_auto_publication_settings drop constraint "information_agent_auto_publication_settings_auto_locked";',
      "drops or renames information_agent_auto_publication_settings_auto_locked: the locks of step 3 are lifted by 20261211100000_information_agent_auto_publication_live.sql only",
    ],
    [
      "le renommage puis le retrait",
      "alter table public.information_agent_auto_publication_settings rename constraint information_agent_auto_publication_settings_auto_locked to tmp_lock; alter table public.information_agent_auto_publication_settings drop constraint tmp_lock;",
      "drops or renames information_agent_auto_publication_settings_auto_locked: the locks of step 3 are lifted by 20261211100000_information_agent_auto_publication_live.sql only",
    ],
    [
      "le retrait du verrou des publications hors de la migration de l'étape 6",
      "alter table public.information_agent_fact_publications drop constraint if exists information_agent_fact_publications_auto_locked;",
      "drops or renames information_agent_fact_publications_auto_locked: the locks of step 3 are lifted by 20261211100000_information_agent_auto_publication_live.sql only",
    ],
    [
      "le retrait de la forme des publications automatiques",
      "alter table public.information_agent_fact_publications drop constraint if exists information_agent_fact_publications_auto_shape;",
      "drops the automatic publication lock information_agent_fact_publications_auto_shape",
    ],
    [
      "la suppression de la table du réglage",
      "drop table if exists public.information_agent_auto_publication_settings cascade;",
      "drops or renames public.information_agent_auto_publication_settings",
    ],
    [
      "le mode automatique écrit par une migration",
      "update public.information_agent_auto_publication_settings set mode = 'auto' where singleton;",
      "writes public.information_agent_auto_publication_settings outside set_information_agent_auto_publication_mode",
    ],
    [
      "le mode composé (concat) écrit par une migration",
      "update public.information_agent_auto_publication_settings set mode = concat('au', 'to') where singleton;",
      "writes public.information_agent_auto_publication_settings outside set_information_agent_auto_publication_mode",
    ],
    [
      "une seconde ligne du réglage insérée par une migration",
      "insert into public.information_agent_auto_publication_settings (singleton, mode) values (true, 'off') on conflict (singleton) do update set mode = excluded.mode;",
      "writes public.information_agent_auto_publication_settings outside set_information_agent_auto_publication_mode",
    ],
    [
      "le réglage fusionné par une migration",
      "merge into public.information_agent_auto_publication_settings settings using (select true as singleton) source on settings.singleton = source.singleton when matched then update set mode = 'simulation';",
      "writes public.information_agent_auto_publication_settings outside set_information_agent_auto_publication_mode",
    ],
    [
      "le défaut de la colonne du mode changé",
      "alter table public.information_agent_auto_publication_settings alter column mode set default 'auto';",
      "writes public.information_agent_auto_publication_settings outside set_information_agent_auto_publication_mode",
    ],
    [
      "le réglage écrit par une autre fonction",
      "create or replace function app_private.switch_mode() returns void language plpgsql security definer set search_path = '' as $$ begin update public.information_agent_auto_publication_settings set mode = 'simulation' where singleton; end; $$;",
      "writes public.information_agent_auto_publication_settings outside set_information_agent_auto_publication_mode",
    ],
    [
      "le réglage écrit par du SQL dynamique",
      "do $$ begin execute 'update public.' || 'information_agent_auto_publication_settings set mode = ' || quote_literal('au' || 'to'); end; $$;",
      "writes public.information_agent_auto_publication_settings outside set_information_agent_auto_publication_mode",
    ],
    [
      "une seconde source de lignes du journal des publications",
      "create or replace function app_private.forge_publication(p_fact uuid) returns void language plpgsql security definer set search_path = '' as $$ begin insert into public.information_agent_fact_publications (fact_id, actor_kind, policy_version) values (p_fact, 'auto', 'auto_publication_v2'); end; $$;",
      "writes public.information_agent_fact_publications outside app_private.apply_information_agent_fact (app_private.forge_publication)",
    ],
    [
      "une ligne du journal des publications insérée par une migration",
      "insert into public.information_agent_fact_publications (fact_id, actor_kind, policy_version) select id, 'auto', 'auto_publication_v2' from public.information_agent_fact_candidates;",
      "writes public.information_agent_fact_publications outside app_private.apply_information_agent_fact (migration body)",
    ],
    [
      "un auteur de publication réécrit après coup (m14)",
      "update public.information_agent_fact_publications set actor_kind = 'admin', policy_version = null where actor_kind = 'auto';",
      "rewrites public.information_agent_fact_publications beyond sale_id",
    ],
    [
      "le fait d'une publication réécrit, avec un alias",
      "update public.information_agent_fact_publications publication set sale_id = publication.sale_id, fact_id = gen_random_uuid();",
      "rewrites public.information_agent_fact_publications beyond sale_id",
    ],
    [
      "la garde du journal des publications retirée",
      "drop trigger information_agent_fact_publications_guard on public.information_agent_fact_publications;",
      "removes or disables the guard of public.information_agent_fact_publications",
    ],
    [
      "la garde du journal des publications désactivée",
      "alter table public.information_agent_fact_publications disable trigger all;",
      "removes or disables the guard of public.information_agent_fact_publications",
    ],
    [
      "la garde du journal des publications vidée de son contrôle",
      "create or replace function app_private.information_agent_fact_publications_guard() returns trigger language plpgsql security definer set search_path = '' as $$ begin return coalesce(new, old); end; $$;",
      "public.information_agent_fact_publications must keep its guard",
    ],
    [
      "la RPC de publication donnée à un compte du navigateur",
      "grant execute on function public.publish_information_agent_fact_auto(uuid, text, text, text) to authenticated;",
      "grants public.publish_information_agent_fact_auto to a browser role",
    ],
    [
      "la RPC du journal des décisions donnée à un compte du navigateur",
      "grant execute on function public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text) to authenticated;",
      "grants public.record_information_agent_auto_publication_decision to a browser role",
    ],
    [
      "la RPC des verdicts donnée à un visiteur",
      "grant execute on function public.record_information_agent_auto_publication_arbitration(uuid, numeric, text, boolean, text, numeric, text, text, text) to anon;",
      "grants public.record_information_agent_auto_publication_arbitration to a browser role",
    ],
    [
      "la liste des faits à juger donnée à un compte du navigateur",
      "grant execute on function public.list_information_agent_facts_to_arbitrate(text, integer) to public;",
      "grants public.list_information_agent_facts_to_arbitrate to a browser role",
    ],
    [
      "une fonction qui enveloppe la RPC de publication",
      "create or replace function public.publish_for_me(p_fact uuid) returns jsonb language sql security definer set search_path = '' as $$ select public.publish_information_agent_fact_auto(p_fact, 'surface_m2', 'auto_publication_v2') $$;",
      "names publish_information_agent_fact_auto",
    ],
    [
      "le renommage de la table qui porte un verrou",
      "alter table public.information_agent_fact_publications rename to information_agent_fact_publications_old;",
      "drops or renames public.information_agent_fact_publications",
    ],
  ])("refuse %s", (_label, sql, message) => {
    const result = runInvariants({ "99990101000000_unlock.sql": sql });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each([
    "information_agent_auto_publication_decisions",
    "information_agent_auto_publication_settings",
    "information_agent_auto_publication_mode_changes",
    "information_agent_auto_publication_arbitrations",
  ])("refuse une écriture accordée au rôle de service sur %s", (table) => {
    const result = runInvariants({
      "99990101000000_grant_write.sql": `grant insert, delete on table public.${table} to service_role;`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`grants more than SELECT to service_role on public.${table}`);
  });

  it("refuse un appel de la revue administrateur hors de son module", () => {
    const result = runInvariants({}, [], {
      "src/lib/sneaky-publish.ts":
        'export const rpc = "review_information_agent_fact_candidate";\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/lib/sneaky-publish.ts calls review_information_agent_fact_candidate",
    );
  });

  it("refuse une RPC de publication qui lit le jeton d'un compte, ou publie avant de relire le mode", () => {
    const step6 = migration("20261211100000_information_agent_auto_publication_live.sql");
    const readsToken = step6.replace(
      "  v_evidence text;\nbegin\n",
      "  v_evidence text;\nbegin\n  if (select auth.uid()) is null then\n    return null;\n  end if;\n",
    );
    expect(readsToken).not.toBe(step6);
    const tokenResult = runInvariants({
      "99990101000000_publish_reads_token.sql": readsToken.slice(
        readsToken.indexOf("create or replace function public.publish_information_agent_fact_auto"),
      ),
    });
    expect(tokenResult.status).toBe(1);
    expect(tokenResult.stderr).toContain(
      "public.publish_information_agent_fact_auto must be SECURITY DEFINER with an empty search_path, read the mode under a shared lock",
    );
    const noGuard = step6.replace(
      "  if v_mode is distinct from 'auto' then\n    return pg_catalog.jsonb_build_object('status', 'inactive');\n  end if;\n",
      "",
    );
    expect(noGuard).not.toBe(step6);
    const guardResult = runInvariants({
      "99990101000000_publish_without_mode.sql": noGuard.slice(
        noGuard.indexOf("create or replace function public.publish_information_agent_fact_auto"),
      ),
    });
    expect(guardResult.status).toBe(1);
    expect(guardResult.stderr).toContain("require 'auto' before any write and before the core");
  });

  it("refuse un module autre que le moteur qui appelle la RPC de publication automatique", () => {
    const result = runInvariants({}, [], {
      "src/lib/sneaky-auto.ts": 'export const rpc = "publish_information_agent_fact_auto";\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/lib/sneaky-auto.ts names public.publish_information_agent_fact_auto: only src/lib/information-agent/auto-publication-store.ts may",
    );
  });

  it("refuse un module qui nomme la décision automatique du registre", () => {
    const result = runInvariants({}, [], {
      "src/lib/sneaky-registry.ts":
        'export const rpc = "accept_information_agent_claim_automatically";\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/lib/sneaky-registry.ts names app_private.accept_information_agent_claim_automatically",
    );
  });

  it.each([
    ["un script", "scripts/publish-now.mjs", 'await rpc("publish_information_agent_fact_auto");\n'],
    [
      "une fonction Edge",
      "supabase/functions/publish-now/index.ts",
      'await rpc("accept_information_agent_claim_automatically");\n',
    ],
    [
      "un workflow",
      ".github/workflows/publish-now.yml",
      'jobs:\n  run:\n    steps:\n      - run: curl -X POST "$URL/rest/v1/rpc/publish_information_agent_fact_auto"\n',
    ],
  ])("refuse %s qui atteint le chemin de publication automatique", (_label, path, content) => {
    const result = runInvariants({}, [], {}, { [path]: content });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path} names`);
    expect(result.stderr).toContain("reach the automatic publication path");
  });

  it("refuse un module qui nomme le noyau de publication", () => {
    const result = runInvariants({}, [], {
      "src/lib/sneaky-core.ts": 'export const core = "apply_information_agent_fact";\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/lib/sneaky-core.ts names app_private.apply_information_agent_fact",
    );
  });
});

describe("invariants de sécurité : achat d'une vente à l'unité", () => {
  it("refuse une lecture de sale_unlock_purchases accordée au compte", () => {
    const result = runInvariants({
      "99990101000000_open_purchases.sql":
        "grant select on table public.sale_unlock_purchases to authenticated;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "99990101000000_open_purchases.sql grants a right on public.sale_unlock_purchases to a browser role",
    );
  });

  it("refuse grant_purchased_sale_unlock accordé au compte", () => {
    const result = runInvariants({
      "99990101000000_open_grant.sql":
        "grant execute on function public.grant_purchased_sale_unlock(uuid, uuid, uuid, text, text, integer, text, text, timestamptz) to authenticated;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.grant_purchased_sale_unlock is granted to a browser role (service_role only)",
    );
  });

  it("refuse une redéfinition de grant_purchased_sale_unlock qui n'est plus SECURITY DEFINER", () => {
    const result = runInvariants({
      "99990101000000_invoker_grant.sql": `
create or replace function public.grant_purchased_sale_unlock(p_purchase_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  select true;
$$;
`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.grant_purchased_sale_unlock is not a SECURITY DEFINER function with an empty search_path",
    );
  });

  it("refuse redeem_sale_unlock_credit ouvert à anon", () => {
    const result = runInvariants({
      "99990101000000_anon_redeem.sql":
        "grant execute on function public.redeem_sale_unlock_credit(uuid) to anon;",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "public.redeem_sale_unlock_credit is granted to public or anon",
    );
  });
});

describe("invariants de sécurité : origine « lecture automatique des pièces » (lot V3b-2)", () => {
  const name = "20261210100000_public_sale_document_fact_sources.sql";
  const original = readFileSync(join(repo, "supabase/migrations", name), "utf8");
  const mutated = (from, to) => {
    expect(original).toContain(from);
    return runInvariants({ [name]: original.replace(from, to) }, [name]);
  };
  const readerFilter = "and trace.value ->> 'reader' = 'document_vision'";
  const digest = "pg_catalog.sha256(pg_catalog.convert_to(trace.value ->> 'document_url', 'UTF8'))";
  const accessGate =
    "and ((select public.has_analysis_access()) or app_private.current_user_unlocked_sale(s.id))";

  it.each([
    [
      "une lecture de la citation",
      readerFilter,
      `${readerFilter} and trace.value ->> 'evidence' is not null`,
      "get_public_sale_document_fact_sources reads evidence from a trace, outside the allow-list",
    ],
    [
      "la trace entière en texte",
      readerFilter,
      `${readerFilter} and trace.value::text <> ''`,
      "from a trace, outside the allow-list",
    ],
    [
      "une clé de la trace par indice",
      readerFilter,
      `${readerFilter} and trace.value['evidence'] is null`,
      "from a trace, outside the allow-list",
    ],
    [
      "les traces des autres lecteurs",
      readerFilter,
      "",
      "get_public_sale_document_fact_sources reads traces of other readers",
    ],
    [
      "l'adresse de la pièce en clair",
      digest,
      "pg_catalog.convert_to(trace.value ->> 'document_url', 'UTF8')",
      "get_public_sale_document_fact_sources must only return a digest of the piece address",
    ],
    [
      "l'empreinte servie à tout appelant",
      accessGate,
      "",
      "get_public_sale_document_fact_sources must only return a digest of the piece address",
    ],
    [
      "la suppression de security definer",
      "stable\nsecurity definer\nset search_path = ''\nas $function$\n  select\n    trace.key",
      "stable\nset search_path = ''\nas $function$\n  select\n    trace.key",
      "get_public_sale_document_fact_sources is not SECURITY DEFINER with an empty search_path",
    ],
    [
      "une table de retour élargie",
      "returns table (fact_key text, document_type text, page_number integer, document_key text)\nlanguage sql\nstable\nsecurity definer",
      "returns table (fact_key text, document_type text, page_number integer, document_key text, evidence text)\nlanguage sql\nstable\nsecurity definer",
      "get_public_sale_document_fact_sources returns more than the four mention columns",
    ],
    [
      "un droit donné à public",
      "grant execute on function public.get_public_sale_document_fact_sources(uuid)\n  to anon, authenticated, service_role;",
      "grant execute on function public.get_public_sale_document_fact_sources(uuid)\n  to public, anon, authenticated, service_role;",
      "get_public_sale_document_fact_sources is granted to public",
    ],
  ])("refuse %s", (_label, from, to, failure) => {
    const result = mutated(from, to);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(failure);
  });

  it("contrôle la dernière définition de la fonction, toutes migrations confondues", () => {
    const reader =
      /create or replace function app_private\.get_public_sale_document_fact_sources[\s\S]*?\$function\$;/.exec(
        original,
      )?.[0];
    expect(reader).toBeTruthy();
    const result = runInvariants({
      "99990101000000_document_fact_sources_redefined.sql": reader.replace(
        readerFilter,
        `${readerFilter} and trace.value ->> 'evidence' is not null`,
      ),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "get_public_sale_document_fact_sources reads evidence from a trace, outside the allow-list",
    );
  });
});
