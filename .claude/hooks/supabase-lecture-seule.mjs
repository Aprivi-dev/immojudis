#!/usr/bin/env node
// Garde-fou SQL : n'autorise que des requêtes en lecture sur l'outil MCP Supabase execute_sql.
// Déclaré au niveau du projet (.claude/settings.json) et dans l'en-tête de l'agent qualite-donnees.
// Code de sortie 2 = requête bloquée. Test : scripts/supabase-lecture-seule.test.mjs.

import { pathToFileURL } from "node:url";

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|upsert|drop|create|alter|truncate|grant|revoke|comment|copy|vacuum|analyze|reindex|cluster|refresh|call|do|lock|set|reset|listen|notify|into)\b/i;
const READ_START = /^\s*(select|with|explain|show|table|values)\b/i;

// Un seul passage sur le texte : les commentaires (-- et /* */ imbriqués) deviennent un espace et
// les littéraux ('...', E'...', $tag$...$tag$) un '' vide. Retirer les commentaires avant les
// chaînes laisserait passer `select '--'; drop table x`, et l'inverse `select /* ' */ 1; drop …`.
export function stripCommentsAndStrings(query) {
  let out = "";
  let i = 0;
  while (i < query.length) {
    const c = query[i];
    const next = query[i + 1];
    if (c === "-" && next === "-") {
      while (i < query.length && query[i] !== "\n") i += 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < query.length && depth > 0) {
        const pair = query.slice(i, i + 2);
        if (pair === "/*") depth += 1;
        else if (pair === "*/") depth -= 1;
        i += pair === "/*" || pair === "*/" ? 2 : 1;
      }
      out += " ";
    } else if (c === "'" || c === '"') {
      // E'...' : le antislash échappe aussi (sinon, les guillemets doublés suffisent).
      const escapes = c === "'" && /[eE]$/.test(out) && !/[\w$][eE]$/.test(out);
      i += 1;
      while (i < query.length) {
        if (escapes && query[i] === "\\") i += 2;
        else if (query[i] === c && query[i + 1] === c) i += 2;
        else if (query[i] === c) break;
        else i += 1;
      }
      i += 1;
      out += c === "'" ? "''" : '"x"';
    } else if (c === "$") {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(query.slice(i))?.[0];
      if (tag && !/[\w$]$/.test(out)) {
        const end = query.indexOf(tag, i + tag.length);
        i = end === -1 ? query.length : end + tag.length;
        out += "''";
      } else {
        out += c;
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export function isReadOnlyQuery(query) {
  const statements = stripCommentsAndStrings(query)
    .split(";")
    .filter((part) => part.trim() !== "");
  return (
    statements.length > 0 &&
    statements.every((part) => READ_START.test(part) && !WRITE_KEYWORDS.test(part))
  );
}

function run() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    let query = "";
    try {
      query = String(JSON.parse(input)?.tool_input?.query ?? "");
    } catch {
      process.stderr.write("Bloqué : entrée du hook illisible.\n");
      process.exit(2);
    }
    if (!isReadOnlyQuery(query)) {
      process.stderr.write(
        "Bloqué : seules les requêtes SQL en lecture (SELECT, WITH, EXPLAIN) sont autorisées.\n",
      );
      process.exit(2);
    }
    process.exit(0);
  });
}

// Importé par le test sans lire l'entrée standard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
