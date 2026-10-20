#!/usr/bin/env node
// Garde-fou SQL : n'autorise que des requêtes en lecture sur l'outil MCP Supabase execute_sql.
// Déclaré au niveau du projet (.claude/settings.json) et dans l'en-tête de l'agent qualite-donnees.
// Code de sortie 2 = requête bloquée. Test : scripts/supabase-lecture-seule.test.mjs.
//
// Trois couches, toutes en refus par défaut :
//  1. la requête doit commencer par SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES ;
//  2. aucun mot-clé d'écriture (INSERT, UPDATE, INTO, FOR SHARE…) n'est toléré, même dans une CTE ;
//  3. tout appel de fonction `nom(` ou `schéma.nom(` doit figurer dans une liste blanche de
//     fonctions de lecture pure. Un SELECT peut en effet écrire ou agir via une fonction
//     (`select public.run_data_retention()`, `set_config`, `pg_terminate_backend`, `nextval`,
//     `dblink_exec`, `lo_import`…) : tout ce qui n'est pas listé est refusé.
//
// Échec fermé : toute erreur du script, entrée illisible ou requête vide sort en code 2. Seul le
// code 2 bloque côté Claude Code (tout autre code non nul laisse passer) : les commandes déclarées
// dans les réglages ajoutent donc `|| exit 2`, ce qui couvre aussi `node` absent ou script
// introuvable (voir .claude/hooks/README.md). Le script ne peut pas corriger ce dernier cas.

import { pathToFileURL } from "node:url";

const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|upsert|drop|create|alter|truncate|grant|revoke|comment|copy|vacuum|analyze|reindex|cluster|refresh|call|do|lock|set|reset|listen|notify|into|execute|prepare)\b/i;
// FOR UPDATE est déjà couvert par `update` ; FOR SHARE et FOR KEY SHARE posent aussi des verrous.
const ROW_LOCK = /\bfor\s+(?:no\s+key\s+update|key\s+share|share)\b/i;
const READ_START = /^\s*(select|with|explain|show|table|values)\b/i;

const words = (list) => list.split(/\s+/).filter(Boolean);

// Fonctions de lecture pure autorisées, par leur nom nu ou préfixées de `pg_catalog.`.
const ALLOWED_FUNCTIONS = new Set([
  // agrégats
  ...words(
    "count sum min max avg array_agg string_agg jsonb_agg json_agg bool_and bool_or " +
      "percentile_cont percentile_disc mode",
  ),
  // scalaires : comparaisons, texte, nombres, dates
  ...words(
    "coalesce nullif greatest least lower upper length char_length trim btrim ltrim rtrim " +
      "substring substr replace split_part position strpos concat concat_ws format left right " +
      "regexp_replace regexp_match regexp_matches abs round ceil floor trunc sqrt power now " +
      "current_date date_trunc date_part extract age to_char to_date to_timestamp make_interval",
  ),
  // JSON
  ...words(
    "jsonb_array_length jsonb_array_elements jsonb_array_elements_text jsonb_each " +
      "jsonb_each_text jsonb_object_keys jsonb_typeof jsonb_extract_path " +
      "jsonb_extract_path_text jsonb_path_exists jsonb_build_object json_build_object to_jsonb",
  ),
  // fenêtres, séries, tableaux, hachage
  ...words(
    "row_number rank dense_rank lag lead first_value last_value ntile generate_series unnest " +
      "array_length cardinality md5 encode sha256 convert_to pg_typeof",
  ),
  // catalogue : privilèges, définitions, tailles, descriptions, réglages en lecture
  ...words(
    "has_table_privilege has_function_privilege has_column_privilege pg_get_functiondef " +
      "pg_get_function_result pg_get_function_arguments pg_get_triggerdef pg_get_indexdef " +
      "pg_get_constraintdef pg_get_viewdef pg_relation_size pg_total_relation_size " +
      "pg_size_pretty obj_description col_description format_type current_setting exists",
  ),
]);

// Modificateurs de type : `numeric(10, 2)`, `varchar(20)`, `timestamp(3)` (conversions, pas des appels).
const TYPE_NAMES = new Set(
  words(
    "numeric decimal varchar char character bpchar timestamp timestamptz time timetz bit varbit",
  ),
);

// Mots-clés SQL pouvant précéder une parenthèse sans être des appels de fonction.
const SQL_KEYWORDS = new Set(
  words(
    "in any all some values cast case when then else filter over partition within group by sets " +
      "as and or not exists select from where on using lateral interval array row explain " +
      "distinct having join union intersect except limit offset materialized between like ilike is",
  ),
);

// Fonctions Immojudis de lecture : `stable`/`immutable`, sans écriture, vérifiées dans les migrations
// (dernière définition de chacune ; les fonctions qu'elles appellent sont elles aussi stables).
// Toujours qualifiées du schéma : un nom nu n'est jamais accepté pour celles-ci.
const ALLOWED_PROJECT_FUNCTIONS = new Set([
  // 20261003170000_catalogue_materialized_visibility_performance.sql
  "app_private.auction_sale_is_publicly_visible",
  "app_private.sale_catalogue_entry_is_live_materialized",
  // 20261028200000_public_market_gap_band.sql (public) et 20261029120000_..._hardened.sql (app_private)
  "public.get_public_sale_market_gap_band",
  "app_private.get_public_sale_market_gap_band",
  // 20261029180100_public_sale_summary_tribunal_code.sql
  "public.get_public_sale_summary",
  // 20261028100400_public_catalogue_verified_at.sql
  "public.get_public_catalogue_verified_at",
  // 20260912183031_pipeline_freshness_single_scan.sql et 20261008102328_health_source_check_links.sql
  "public.auction_source_freshness",
  "public.auction_all_source_freshness",
]);

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

// Segment d'identifiant : nu ou entre guillemets (déjà réduit à "x" par stripCommentsAndStrings).
const SEGMENT = String.raw`(?:[A-Za-z_\u0080-￿][\w$\u0080-￿]*|"x")`;
const CALL = new RegExp(
  String.raw`(?<![\w$.\u0080-￿])(${SEGMENT}(?:\s*\.\s*${SEGMENT})*)\s*\(`,
  "g",
);
// Liste de colonnes d'un alias ou d'une CTE : `as t(a, b)`, `with recursive t(n) as (…)`.
const COLUMN_LIST = new RegExp(String.raw`\s*${SEGMENT}(?:\s*,\s*${SEGMENT})*\s*\)`, "y");

function isAllowedCall(name) {
  const parts = name.split(".");
  if (parts.length === 1) {
    return ALLOWED_FUNCTIONS.has(name) || TYPE_NAMES.has(name) || SQL_KEYWORDS.has(name);
  }
  if (parts.length === 2 && parts[0] === "pg_catalog") {
    return ALLOWED_FUNCTIONS.has(parts[1]) || TYPE_NAMES.has(parts[1]);
  }
  return ALLOWED_PROJECT_FUNCTIONS.has(name);
}

// Premier appel de fonction hors liste blanche dans le texte déjà épuré, ou null.
// Un identifiant entre guillemets suivi d'une parenthèse est refusé par prudence.
function findDisallowedCall(stripped) {
  CALL.lastIndex = 0;
  for (let match = CALL.exec(stripped); match; match = CALL.exec(stripped)) {
    const name = match[1].replace(/\s+/g, "").toLowerCase();
    if (!name.includes('"') && isAllowedCall(name)) continue;
    // Seul cas où un identifiant nu suivi d'une parenthèse n'est pas un appel : la liste de colonnes
    // d'un alias (`as g(i)`) ou de la première CTE (`with [recursive] t(n)`). Ces mots ne peuvent
    // pas précéder un appel de fonction en SQL valide ; le contenu doit être une liste d'identifiants.
    if (!name.includes('"') && !name.includes(".")) {
      const before = stripped.slice(0, match.index);
      COLUMN_LIST.lastIndex = CALL.lastIndex;
      if (/(?:^|[^\w$])(?:as|with|recursive)\s*$/i.test(before) && COLUMN_LIST.test(stripped)) {
        continue;
      }
    }
    return name;
  }
  return null;
}

// Retourne null si la requête est une lecture autorisée, sinon la raison du refus.
export function refusalReason(query) {
  if (typeof query !== "string" || query.trim() === "") return "requête vide ou illisible.";
  const stripped = stripCommentsAndStrings(query);
  const statements = stripped.split(";").filter((part) => part.trim() !== "");
  if (statements.length === 0) return "requête vide ou illisible.";
  for (const part of statements) {
    if (!READ_START.test(part) || WRITE_KEYWORDS.test(part) || ROW_LOCK.test(part)) {
      return "seules les requêtes SQL en lecture (SELECT, WITH, EXPLAIN) sont autorisées.";
    }
  }
  const call = findDisallowedCall(stripped);
  if (call !== null) {
    return (
      `appel de fonction non autorisé : ${call}(). Seules les fonctions de lecture de la liste ` +
      "blanche de .claude/hooks/supabase-lecture-seule.mjs sont permises."
    );
  }
  return null;
}

export function isReadOnlyQuery(query) {
  return refusalReason(query) === null;
}

// Décision pour l'entrée brute du hook (JSON sur l'entrée standard). Échec fermé : toute erreur,
// entrée illisible ou requête absente est un refus.
export function decide(input) {
  try {
    const query = JSON.parse(input)?.tool_input?.query;
    const reason = refusalReason(query);
    return reason === null ? { allow: true } : { allow: false, reason };
  } catch (error) {
    return {
      allow: false,
      reason: `erreur du garde-fou ou entrée du hook illisible (${error?.message ?? error}).`,
    };
  }
}

function block(reason) {
  try {
    process.stderr.write(`Bloqué : ${reason}\n`);
  } finally {
    process.exit(2);
  }
}

function run() {
  try {
    process.on("uncaughtException", (error) => block(`erreur inattendue du garde-fou (${error}).`));
    process.on("unhandledRejection", (error) =>
      block(`erreur inattendue du garde-fou (${error}).`),
    );
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("error", () => block("entrée du hook illisible."));
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const verdict = decide(input);
      if (!verdict.allow) block(verdict.reason);
      process.exit(0);
    });
  } catch (error) {
    block(`erreur inattendue du garde-fou (${error}).`);
  }
}

// Importé par le test sans lire l'entrée standard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
