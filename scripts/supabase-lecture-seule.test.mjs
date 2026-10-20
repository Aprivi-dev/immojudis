import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decide,
  isReadOnlyQuery,
  refusalReason,
} from "../.claude/hooks/supabase-lecture-seule.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = resolve(root, ".claude/hooks/supabase-lecture-seule.mjs");

function runHook(stdin, cwd) {
  return spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8", cwd });
}
const call = (query) => JSON.stringify({ tool_input: { query } });

describe("crochet supabase-lecture-seule", () => {
  it.each([
    "select 1",
    "SELECT id FROM public.auction_sales LIMIT 10;",
    "with x as (select 1) select * from x",
    "explain select 1",
    "show search_path",
    "select 1; select 2",
    "select 1 -- drop table x",
    "/* delete from t */ select 1",
    "select /* update */ 1",
    "select 'delete me' as label",
    "select $$ drop table x; $$",
    // Mots d'écriture et noms de fonctions dans des chaînes : ce ne sont pas des appels.
    "select 'select public.run_data_retention()' as texte",
    "select 'for update' as texte",
  ])("laisse passer %j", (query) => {
    expect(refusalReason(query)).toBeNull();
    expect(isReadOnlyQuery(query)).toBe(true);
  });

  // Requêtes de lecture réalistes de l'agent qualite-donnees.
  it.each([
    // jointures, filtres, tri
    `select s.id, s.title, s.starting_price_eur, t.name
       from public.auction_sales s
       left join public.tribunals t on t.id = s.tribunal_id
      where s.status in ('upcoming', 'unknown') and s.sale_date >= now() - interval '1 day'
      order by s.sale_date desc nulls last
      limit 50`,
    // agrégats, FILTER, taux de champs manquants
    `select source_name, count(*) as total,
            count(*) filter (where surface_m2 is null) as sans_surface,
            round(100.0 * count(*) filter (where surface_m2 is null) / nullif(count(*), 0), 1) as pct
       from public.auction_sales group by source_name order by total desc`,
    // CTE multiples et fenêtres
    `with ventes as (select id, source_name, sale_date from public.auction_sales),
          dernieres as (
            select v.*, row_number() over (partition by source_name order by sale_date desc) as rang
              from ventes v)
     select * from dernieres where rang <= 3`,
    "select id, lag(starting_price_eur) over (order by sale_date) from public.auction_sales limit 20",
    // CTE récursive avec liste de colonnes
    "with recursive t(n) as (select 1 union all select n + 1 from t where n < 5) select * from t",
    // quantiles
    `select percentile_cont(0.5) within group (order by starting_price_eur) as mediane,
            percentile_disc(0.9) within group (order by starting_price_eur) as p90
       from public.auction_sales`,
    // JSON
    `select s.id, jsonb_typeof(s.raw_payload -> 'x'), jsonb_array_length(s.raw_payload -> 'lots')
       from public.auction_sales s where jsonb_path_exists(s.raw_payload, '$.lots[*]')`,
    `select s.id, k.key, k.value
       from public.auction_sales s, jsonb_each_text(s.raw_payload) as k(key, value) limit 10`,
    "select jsonb_object_keys(raw_payload) as cle, count(*) from public.auction_sales group by 1",
    "select jsonb_build_object('n', count(*)) from public.auction_sales",
    // séries, valeurs, alias avec colonnes, types paramétrés
    "select d::date from generate_series('2026-01-01'::date, '2026-01-10', interval '1 day') as g(d)",
    "select * from (values (1, 'a'), (2, 'b')) as t(n, label)",
    "select starting_price_eur::numeric(12, 2), cast(sale_date as timestamp(3)) from public.auction_sales",
    // dates, texte
    `select to_char(sale_date, 'DD/MM/YYYY'), date_part('year', sale_date), extract(epoch from now()),
            lower(trim(title)), substring(title from 1 for 10), split_part(address, ',', 1),
            coalesce(city, 'inconnue'), age(now(), created_at)
       from public.auction_sales limit 5`,
    // sous-requêtes
    `select * from public.auction_sales s
      where exists (select 1 from public.auction_observations o where o.canonical_source_url = s.source_url)
        and s.id = any (array['00000000-0000-0000-0000-000000000000']::uuid[])`,
    // EXPLAIN
    "explain select * from public.auction_sales where id = '00000000-0000-0000-0000-000000000000'",
    "explain (format json, costs off) select count(*) from public.auction_sales",
    // catalogue
    "select pg_get_functiondef('app_private.auction_sale_is_publicly_visible(uuid)'::regprocedure)",
    "select p.proname, pg_get_function_arguments(p.oid), pg_get_function_result(p.oid) from pg_proc p limit 5",
    "select pg_get_viewdef('public.auction_sales'::regclass, true)",
    "select pg_get_triggerdef(oid), pg_get_constraintdef(oid) from pg_trigger limit 1",
    "select pg_size_pretty(pg_total_relation_size('public.auction_sales'))",
    "select has_function_privilege('anon', 'public.run_data_retention()', 'execute')",
    "select has_table_privilege('anon', 'public.auction_sales', 'select')",
    "select current_setting('search_path')",
    // fonctions Immojudis de lecture, toujours qualifiées
    "select s.id, app_private.auction_sale_is_publicly_visible(s.id) from public.auction_sales s limit 10",
    "select public.get_public_sale_market_gap_band(s.id) from public.auction_sales s limit 10",
    "select app_private.get_public_sale_market_gap_band(id) from public.auction_sales limit 1",
    "select * from public.auction_source_freshness()",
    "select public.get_public_catalogue_verified_at()",
    // préfixe pg_catalog explicite
    "select pg_catalog.count(*), pg_catalog.lower('X') from public.auction_sales",
    // espaces et commentaires entre le nom et la parenthèse
    "select count /* c */ (*) from public.auction_sales",
    "select  COUNT  (*) from public.auction_sales",
  ])("laisse passer la lecture réaliste %#", (query) => {
    expect(refusalReason(query)).toBeNull();
  });

  it.each([
    "create temp view x as select 1; select 1",
    "select 1; create temp view x as select 1",
    "with x as (delete from public.auction_sales returning *) select * from x",
    "with x as (insert into t values (1) returning *) select * from x",
    "select * into new_table from public.auction_sales",
    "select 1 for update",
    "select 1 for share",
    "select 1 for no key update",
    "select 1 for key share",
    "select * from public.auction_sales for update skip locked",
    "drop table public.auction_sales",
    "update public.auction_sales set title = 'x'",
    "",
    "   ",
    "-- select 1",
    // Un commentaire ne doit pas masquer la suite : `--` dans une chaîne n'ouvre pas de commentaire.
    "select '--'; drop table x",
    "select '--' ; delete from t -- fin",
    "select /* ' */ 1; drop table x; select '",
    "select 1 /* /* imbriqué */ */; drop table x",
    "select E'\\'' ; drop table x; select '",
    "select $a$ x $a$; drop table x",
    // EXPLAIN ANALYZE exécute la requête : refusé, y compris sur une écriture.
    "explain analyze select 1",
    "explain (analyze) select 1",
    "explain analyze delete from public.auction_sales",
    "explain (analyze, buffers) update public.auction_sales set title = 'x'",
    "explain execute plan_prepare",
    "select 1; prepare p as select 1",
  ])("bloque %j", (query) => {
    expect(isReadOnlyQuery(query)).toBe(false);
  });

  // Cas de la relecture : un SELECT qui écrit ou agit par une fonction.
  it.each([
    "select public.run_data_retention()",
    "select app_private.withdraw_missing_source_sales('x', true)",
    "select set_config('request.jwt.claims', '{}', false)",
    "select pg_terminate_backend(123)",
    "select nextval('x')",
    "select setval('x', 1)",
    "select * from dblink_exec('host=x', 'delete from t')",
    "select * from dblink('host=x', 'select 1') as t(a int)",
    "select lo_import('/etc/passwd')",
    "select pg_read_file('/etc/passwd')",
    "select pg_sleep(60)",
    "select pg_cancel_backend(1)",
    "select pg_notify('c', 'p')",
    "select pg_reload_conf()",
    "select pg_advisory_lock(1)",
    "select query_to_xml('delete from t', true, true, '')",
    "select * from public.purge_expired_auction_sales()",
    "select public.enqueue_data_refresh_bounded()",
    // même fonction dans une CTE, une sous-requête, une clause WHERE
    "with x as (select public.run_data_retention()) select * from x",
    "select (select pg_terminate_backend(1))",
    "select 1 where pg_terminate_backend(1)",
    "select count(*) from t where id = any (array[nextval('s')])",
    "select case when true then set_config('a', 'b', false) end",
    "select distinct pg_terminate_backend(pid) from pg_stat_activity",
    // contournements de syntaxe
    "select pg_terminate_backend  (1)",
    "select pg_terminate_backend/* c */(1)",
    "select PG_TERMINATE_BACKEND(1)",
    "select pg_catalog.pg_terminate_backend(1)",
    "select pg_catalog . set_config('a', 'b', false)",
    "select public.count(*)",
    "select public.lower('X')",
    'select "run_data_retention"()',
    'select public."run_data_retention"()',
    'select "public"."run_data_retention"()',
    'select "count"(*) from t',
    "select a.b.c(1)",
    "select run_data_retention()",
    "select auction_sale_is_publicly_visible(id) from public.auction_sales",
    "select 1 as x(pg_terminate_backend(1))",
    "select * from generate_series(1, 2) g(i)",
    "with a as (select 1), b(x) as (select 2) select * from b",
    "select operator(pg_catalog.+)(1, 2)",
    "select * from rows from (pg_sleep(1))",
  ])("refuse l'appel de fonction %j", (query) => {
    const reason = refusalReason(query);
    expect(reason).not.toBeNull();
    expect(isReadOnlyQuery(query)).toBe(false);
  });

  it("nomme la fonction refusée", () => {
    expect(refusalReason("select public.run_data_retention()")).toMatch(
      /public\.run_data_retention\(\)/,
    );
  });

  it("sort en 0 pour une lecture et en 2 pour une écriture, quel que soit le répertoire courant", () => {
    expect(runHook(call("select 1"), "/").status).toBe(0);
    const blocked = runHook(call("create temp view x as select 1; select 1"), "/");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/Bloqué/);
  });

  it("sort en 2 pour un SELECT qui appelle une fonction hors liste blanche", () => {
    const blocked = runHook(call("select public.run_data_retention()"), "/");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/Bloqué.*run_data_retention/);
  });

  it("bloque une entrée illisible, vide ou sans requête", () => {
    expect(runHook("pas du json").status).toBe(2);
    expect(runHook("").status).toBe(2);
    expect(runHook("null").status).toBe(2);
    expect(runHook(JSON.stringify({ tool_input: {} })).status).toBe(2);
    expect(runHook(JSON.stringify({ tool_input: { query: "" } })).status).toBe(2);
    expect(runHook(JSON.stringify({ tool_input: { query: "  " } })).status).toBe(2);
    expect(runHook(JSON.stringify({ tool_input: { query: 42 } })).status).toBe(2);
    expect(runHook(JSON.stringify({ tool_input: { query: ["select 1"] } })).status).toBe(2);
  });

  it("refuse (échec fermé) quand l'analyse elle-même lève une erreur", () => {
    // Un objet dont la conversion en chaîne lève : JSON.parse reçoit une valeur non analysable.
    const hostile = {
      toString() {
        throw new Error("boom");
      },
    };
    const verdict = decide(hostile);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toMatch(/boom/);
    expect(decide(undefined).allow).toBe(false);
  });

  describe("commande déclarée dans les réglages", () => {
    const settings = JSON.parse(readFileSync(resolve(root, ".claude/settings.json"), "utf8"));
    const entry = settings.hooks.PreToolUse.find((hookEntry) =>
      hookEntry.matcher.split("|").includes("mcp__Supabase__execute_sql"),
    );
    const command = entry.hooks[0].command;

    function runCommand(stdin, env) {
      return spawnSync("/bin/sh", ["-c", command], {
        input: stdin,
        encoding: "utf8",
        cwd: "/",
        env: { CLAUDE_PROJECT_DIR: root, ...env },
      });
    }

    it("est de la forme `node … || exit 2` pour que tout échec bloque", () => {
      expect(command).toMatch(/\|\| exit 2$/);
      expect(command).toContain("${CLAUDE_PROJECT_DIR:-.}");
    });

    it("laisse passer une lecture et bloque une écriture", () => {
      const env = { PATH: dirname(process.execPath) };
      expect(runCommand(call("select 1"), env).status).toBe(0);
      expect(runCommand(call("select public.run_data_retention()"), env).status).toBe(2);
    });

    it("bloque (code 2) quand node est introuvable", () => {
      const result = runCommand(call("select 1"), { PATH: "/nonexistent" });
      expect(result.status).toBe(2);
    });

    it("bloque (code 2) quand le script est introuvable", () => {
      const result = runCommand(call("select 1"), {
        PATH: dirname(process.execPath),
        CLAUDE_PROJECT_DIR: "/nonexistent",
      });
      expect(result.status).toBe(2);
    });
  });
});
