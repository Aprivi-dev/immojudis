import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isReadOnlyQuery } from "../.claude/hooks/supabase-lecture-seule.mjs";

const hook = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.claude/hooks/supabase-lecture-seule.mjs",
);

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
  ])("laisse passer %j", (query) => {
    expect(isReadOnlyQuery(query)).toBe(true);
  });

  it.each([
    "create temp view x as select 1; select 1",
    "select 1; create temp view x as select 1",
    "with x as (delete from public.auction_sales returning *) select * from x",
    "with x as (insert into t values (1) returning *) select * from x",
    "select * into new_table from public.auction_sales",
    "select 1 for update",
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
  ])("bloque %j", (query) => {
    expect(isReadOnlyQuery(query)).toBe(false);
  });

  it("sort en 0 pour une lecture et en 2 pour une écriture, quel que soit le répertoire courant", () => {
    expect(runHook(call("select 1"), "/").status).toBe(0);
    const blocked = runHook(call("create temp view x as select 1; select 1"), "/");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/Bloqué/);
  });

  it("bloque une entrée illisible ou sans requête", () => {
    expect(runHook("pas du json").status).toBe(2);
    expect(runHook(JSON.stringify({ tool_input: {} })).status).toBe(2);
  });
});
