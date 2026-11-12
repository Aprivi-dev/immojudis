import {
  operations,
  runConcurrentIndexOperations,
} from "../apply-supabase-concurrent-index-operations.mjs";

const managedConcurrentIndexDefinitions = new Set(
  operations.map((operation) => normalizeConcurrentIndexDefinition(operation.createSql)),
);

// Partial, expression and unique indexes (fact registry, 20261117100450): the diff tool prints their
// predicate and expression its own way (redundant parentheses, `::text` casts on string constants, an
// optional `USING btree`), which cannot be pinned to one text. For these operations only, the match is
// made on a canonical form that ignores exactly those three things and nothing else: the index name,
// table, uniqueness, columns, operators and constants still have to be the reviewed ones. A `::text`
// cast is ignored only right after a string constant ('…'::text): a cast of a column or of an
// expression (`(id)::text`, or the predicate column cast to text) is another index and stays in the
// diff.
// The physical index is verified separately, word for word, against the catalog
// (verifyConcurrentIndexes).
const managedConcurrentIndexCanonicalDefinitions = new Set(
  operations
    .filter((operation) => operation.predicate || operation.expressions)
    .map((operation) => canonicalConcurrentIndexDefinition(operation.createSql)),
);

// Applies `rewrite(code, position)` to the SQL outside string constants. A constant ('…', with '' for an
// apostrophe) is data: it is compared as written, never lower-cased, re-spaced or rewritten.
function rewriteOutsideStringConstants(sql, rewrite) {
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((piece, position) => (position % 2 === 0 ? rewrite(piece, position) : piece))
    .join("");
}

function normalizeConcurrentIndexDefinition(value) {
  const statement = String(value)
    .trim()
    .replace(
      /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?/i,
      (_match, unique) => `create ${unique ? "unique " : ""}index `,
    )
    .replace(/;\s*$/, "");
  return rewriteOutsideStringConstants(statement, (code) =>
    code
      .replace(/"([a-z_][a-z0-9_]*)"/g, "$1")
      .replace(/\s+/g, " ")
      .toLowerCase(),
  ).trim();
}

function canonicalConcurrentIndexDefinition(value) {
  return rewriteOutsideStringConstants(
    normalizeConcurrentIndexDefinition(value),
    (code, position) =>
      // Past the first piece, the code comes right after a string constant: a leading `::text` is its cast.
      (position === 0 ? code : code.replace(/^::text\b/, ""))
        .replace(/\s+using\s+btree\b/g, "")
        .replace(/[()]/g, " ")
        .replace(/\s+/g, " "),
  ).trim();
}

function isManagedConcurrentIndexDefinition(value) {
  return (
    managedConcurrentIndexDefinitions.has(normalizeConcurrentIndexDefinition(value)) ||
    managedConcurrentIndexCanonicalDefinitions.has(canonicalConcurrentIndexDefinition(value))
  );
}

async function verifyConcurrentIndexes(databaseUrl, runCheck = runConcurrentIndexOperations) {
  await runCheck({ checkOnly: true, databaseUrl });
}

const sourceUrlCheck = (column) =>
  `CHECK (((char_length(${column}) >= 1) AND (char_length(${column}) <= 4096) AND (${column} ~ '^https://'::text)))`;
const fieldKeyCheck = String.raw`CHECK (((char_length(field_key) >= 2) AND (char_length(field_key) <= 128) AND (field_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$'::text)))`;
const emailRegex = String.raw`'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text`;

// Postgres 17.11 (production, read on 2026-10-13) deparses `col BETWEEN a AND b
// AND c` as one flat three-term conjunction. The Supabase CLI 2.110.0 replays the
// migrations on a shadow database running supabase/postgres 17.6.1.143 (Postgres
// 17.6), where the BETWEEN stays nested as `((col >= a) AND (col <= b)) AND c`.
// For the same migration SQL, pg-delta therefore sees two different texts and
// proposes a DROP + ADD of each of the twelve CHECK constraints below (run 79 of
// "Apply Supabase Migrations"). They are the only constraints of the schema whose
// BETWEEN leads the conjunction.
//
// Each entry pins the exact production pg_get_constraintdef text, by table and
// name. A DROP + ADD pair is ignored only when the ADD definition is logically
// equal to that pin (see canonicalCheckCondition), so a renamed, loosened or
// otherwise altered constraint, or any constraint not listed here, still fails
// the check. Remove an entry once the shadow image reaches the production minor
// version. `migration` names the file whose SQL the pin was reviewed against.
const RECONCILED_CHECK_CONSTRAINTS = Object.freeze([
  {
    table: "public.auction_ai_review_case_status",
    name: "auction_ai_review_case_status_source_url_check",
    productionDefinition: sourceUrlCheck("source_url"),
    migration: "20260929103000_ai_review_projection_guard.sql",
  },
  {
    table: "public.auction_ai_review_projections",
    name: "auction_ai_review_projections_field_key_check",
    productionDefinition: fieldKeyCheck,
    migration: "20260929103000_ai_review_projection_guard.sql",
  },
  {
    table: "public.auction_ai_review_projections",
    name: "auction_ai_review_projections_source_url_check",
    productionDefinition: sourceUrlCheck("source_url"),
    migration: "20260929103000_ai_review_projection_guard.sql",
  },
  {
    table: "public.auction_fact_claims",
    name: "auction_fact_claims_conflict_group_check",
    productionDefinition:
      "CHECK (((conflict_group IS NULL) OR ((char_length(conflict_group) >= 1) AND (char_length(conflict_group) <= 200) AND (NULLIF(btrim(conflict_group), ''::text) IS NOT NULL))))",
    migration: "20260928140000_auction_fact_claims.sql",
  },
  {
    table: "public.auction_fact_claims",
    name: "auction_fact_claims_field_key_check",
    productionDefinition: fieldKeyCheck,
    migration: "20260928140000_auction_fact_claims.sql",
  },
  {
    table: "public.auction_fact_claims",
    name: "auction_fact_claims_source_url_check",
    productionDefinition:
      "CHECK (((source_url IS NULL) OR ((char_length(source_url) >= 1) AND (char_length(source_url) <= 4096) AND (source_url ~ '^https://'::text))))",
    migration: "20260928140000_auction_fact_claims.sql",
  },
  {
    table: "public.information_agent_cases",
    name: "information_agent_cases_recipient_email_check",
    productionDefinition: `CHECK (((char_length(recipient_email) >= 3) AND (char_length(recipient_email) <= 320) AND (recipient_email ~* ${emailRegex}) AND (normalized_recipient_email = lower(btrim(recipient_email)))))`,
    migration: "20260825103748_centralize_information_agent_cases.sql",
  },
  {
    table: "public.information_agent_contacts",
    name: "information_agent_contacts_email_check",
    productionDefinition: `CHECK (((char_length(btrim(email)) >= 3) AND (char_length(btrim(email)) <= 320) AND (email ~* ${emailRegex})))`,
    migration: "20260928160000_information_agent_contact_registry.sql",
  },
  {
    table: "public.information_agent_email_templates",
    name: "information_agent_email_templates_subject_template_check",
    productionDefinition: String.raw`CHECK (((char_length(subject_template) >= 3) AND (char_length(subject_template) <= 200) AND (subject_template !~ '[\r\n]'::text)))`,
    migration: "20260825131959_information_agent_email_templates.sql",
  },
  {
    table: "public.information_agent_missions",
    name: "information_agent_missions_recipient_email_check",
    productionDefinition: `CHECK (((char_length(recipient_email) >= 3) AND (char_length(recipient_email) <= 320) AND (recipient_email ~* ${emailRegex})))`,
    migration: "20260824151027_supervised_information_agent.sql",
  },
  {
    table: "public.information_agent_missions",
    name: "information_agent_missions_reply_to_email_check",
    productionDefinition: `CHECK (((reply_to_email IS NULL) OR ((char_length(reply_to_email) >= 3) AND (char_length(reply_to_email) <= 320) AND (reply_to_email ~* ${emailRegex}))))`,
    migration: "20260824151027_supervised_information_agent.sql",
  },
  {
    table: "public.justice_jurisdiction_activity_imports",
    name: "justice_jurisdiction_activity_imports_period_check",
    productionDefinition:
      "CHECK (((period_start_year >= 1900) AND (period_start_year <= 2100) AND (period_end_year = period_start_year)))",
    migration: "20260824160007_justice_jurisdiction_activity.sql",
  },
]);

// Body of a `CHECK (...)` definition, as printed by pg_get_constraintdef.
function checkBody(definition) {
  return /^CHECK \(([\s\S]*)\)$/.exec(String(definition).trim())?.[1] ?? "";
}

// Reduces a CHECK condition to its logical shape so that purely textual
// variants compare equal: whitespace, redundant parentheses, `::text` casts and
// the nesting of AND/OR (`(a AND b) AND c` is `a AND b AND c`). Operators,
// operands, string literals (case included) and the AND/OR grouping stay
// significant, so `(a OR b) AND c` never equals `a OR (b AND c)`.
function canonicalCheckCondition(value) {
  return serializeCondition(parseCondition(collapseSqlWhitespace(String(value))));
}

function collapseSqlWhitespace(text) {
  let result = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      result += character;
      if (character === "'") {
        if (text[index + 1] === "'") {
          result += "'";
          index += 1;
        } else {
          quoted = false;
        }
      }
    } else if (character === "'") {
      quoted = true;
      result += character;
    } else if (/\s/.test(character)) {
      if (!result.endsWith(" ")) result += " ";
    } else {
      result += character;
    }
  }
  return result.trim();
}

function wrapsWholeExpression(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "'") {
        if (text[index + 1] === "'") index += 1;
        else quoted = false;
      }
      continue;
    }
    if (character === "'") quoted = true;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0 && index < text.length - 1) return false;
    }
  }
  return depth === 0;
}

function splitTopLevel(text, keyword) {
  const parts = [];
  const token = ` ${keyword} `;
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === "'") {
        if (text[index + 1] === "'") index += 1;
        else quoted = false;
      }
      continue;
    }
    if (character === "'") quoted = true;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (
      depth === 0 &&
      character === " " &&
      text.slice(index, index + token.length).toUpperCase() === token
    ) {
      parts.push(text.slice(start, index));
      start = index + token.length;
      index = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function normalizeAtom(text) {
  // Code (even pieces) is lower-cased and loses its `::text` casts; string
  // literals (odd pieces) are kept verbatim.
  return text
    .split(/('(?:[^']|'')*')/)
    .map((piece, index) =>
      index % 2 === 0 ? piece.replace(/::text\b/gi, "").toLowerCase() : piece,
    )
    .join("");
}

function parseCondition(input) {
  let text = input.trim();
  while (wrapsWholeExpression(text)) text = text.slice(1, -1).trim();
  for (const [keyword, operator] of [
    ["OR", "or"],
    ["AND", "and"],
  ]) {
    const parts = splitTopLevel(text, keyword);
    if (parts.length > 1) {
      const items = parts.flatMap((part) => {
        const child = parseCondition(part);
        return child.operator === operator ? child.items : [child];
      });
      return { operator, items };
    }
  }
  return { operator: "atom", text: collapseSqlWhitespace(normalizeAtom(text)) };
}

function serializeCondition(node) {
  if (node.operator === "atom") return node.text;
  return `${node.operator.toUpperCase()}[${node.items.map(serializeCondition).join(" ; ")}]`;
}

function bareIdentifier(value) {
  return String(value).replaceAll('"', "").toLowerCase();
}

// Removes, from the diff text, each DROP CONSTRAINT / ADD CONSTRAINT ... CHECK
// pair that RECONCILED_CHECK_CONSTRAINTS names and whose production definition
// is logically the pinned one. Anything else is left in the diff. `unused` lists
// the entries for which the diff holds no DROP + ADD pair at all (dead entries).
function removeReconciledCheckConstraints(text) {
  const identifier = String.raw`[\w".]+`;
  const dropPattern = new RegExp(
    String.raw`^[ \t]*ALTER TABLE (?:ONLY )?(${identifier})\s+DROP CONSTRAINT (${identifier})\s*;[ \t]*$`,
    "gim",
  );
  const addPattern = new RegExp(
    String.raw`^[ \t]*ALTER TABLE (?:ONLY )?(${identifier})\s+ADD CONSTRAINT (${identifier})\s+CHECK\s*\(([\s\S]*?)\)\s*;[ \t]*$`,
    "gim",
  );
  const spans = (pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      key: `${bareIdentifier(match[1])}#${bareIdentifier(match[2])}`,
      start: match.index,
      end: match.index + match[0].length,
      definition: match[3],
    }));
  const drops = spans(dropPattern);
  const adds = spans(addPattern);

  const removals = [];
  const unused = [];
  for (const reconciled of RECONCILED_CHECK_CONSTRAINTS) {
    const key = `${reconciled.table}#${reconciled.name}`;
    const drop = drops.find((candidate) => candidate.key === key);
    const add = adds.find((candidate) => candidate.key === key);
    if (!drop || !add) {
      if (!drop && !add) unused.push(reconciled.name);
      continue;
    }
    if (
      canonicalCheckCondition(add.definition) !==
      canonicalCheckCondition(checkBody(reconciled.productionDefinition))
    ) {
      continue;
    }
    removals.push(drop, add);
  }

  let result = text;
  for (const { start, end } of removals.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, start)}${result.slice(end)}`;
  }
  return { text: result, unused };
}

function normalizeDiff(value) {
  return normalizeDiffWithNotes(value).diff;
}

// Same as normalizeDiff, plus the names of the RECONCILED_CHECK_CONSTRAINTS
// entries that matched nothing in the diff, so callers can warn that the list is
// stale (for instance once the shadow image reaches the production minor).
function normalizeDiffWithNotes(value) {
  const { text, unused } = removeReconciledCheckConstraints(String(value));
  return { diff: filterDiffLines(text), unusedReconciledChecks: unused };
}

// The diff tool wraps a long statement over several lines (production, 2026-11-12: each fact registry
// index came on two lines, its WHERE on an indented line of its own). An index is therefore matched as a
// whole statement, from `CREATE [UNIQUE] INDEX` at the start of a line to the next semicolon, never line
// by line. The statement is removed only when all of it is a reviewed definition
// (isManagedConcurrentIndexDefinition): a line added, changed or missing leaves every line in the diff.
// The semicolon has to end its line, and an index printed without one is left in the diff.
//
// One pass over the semicolons, each paired with the first `CREATE INDEX` line that follows the
// previous semicolon: the time stays proportional to the text, even when it holds no semicolon at all.
const CREATE_INDEX_START = /^[ \t]*CREATE\s+(?:UNIQUE\s+)?INDEX\s/gim;

function removeManagedConcurrentIndexStatements(text) {
  const starts = Array.from(text.matchAll(CREATE_INDEX_START), (match) => match.index);
  let result = "";
  let copied = 0;
  let next = 0;
  for (
    let from = 0, semicolon = text.indexOf(";");
    semicolon !== -1;
    from = semicolon + 1, semicolon = text.indexOf(";", from)
  ) {
    while (next < starts.length && starts[next] < from) next += 1;
    if (next === starts.length) break;
    const start = starts[next];
    if (start > semicolon) continue;
    let end = semicolon + 1;
    while (text[end] === " " || text[end] === "\t") end += 1;
    const endsItsLine = end === text.length || text[end] === "\n" || text[end] === "\r";
    if (endsItsLine && isManagedConcurrentIndexDefinition(text.slice(start, end))) {
      result += text.slice(copied, start);
      copied = end;
    }
  }
  return result + text.slice(copied);
}

// The only statements ignored for the connector role `lovable_readonly`, each alone on its line, with
// this role as sole grantee and nothing after it (no WITH GRANT OPTION). What the role holds in
// production was read on 2026-11-12: SELECT on tables, EXECUTE on functions, and one default privilege
// set by `postgres` (SELECT on the future tables of `public`).
const CONNECTOR_ROLE_READ_GRANTS = (() => {
  const identifier = String.raw`(?:"[^"]+"|\w+)`;
  const object = String.raw`${identifier}(?:\.${identifier})?`;
  const role = String.raw`"?lovable_readonly"?\s*;$`;
  return Object.freeze([
    // SELECT, and nothing else, on one table, view or sequence, or on some of its columns.
    new RegExp(
      String.raw`^(?:GRANT|REVOKE)\s+SELECT(?:\s*\([^();]*\))?\s+ON\s+(?:(?:TABLE|SEQUENCE)\s+)?${object}\s+(?:TO|FROM)\s+${role}`,
      "i",
    ),
    // EXECUTE on one function, whose argument types may hold one level of parentheses (numeric(10,2)).
    new RegExp(
      String.raw`^(?:GRANT|REVOKE)\s+EXECUTE\s+ON\s+FUNCTION\s+${object}\s*\((?:[^();]|\([^();]*\))*\)\s+(?:TO|FROM)\s+${role}`,
      "i",
    ),
    // The default privilege: SELECT on the future tables of `public`, set by `postgres` or unnamed.
    new RegExp(
      String.raw`^ALTER\s+DEFAULT\s+PRIVILEGES\s+(?:FOR\s+ROLE\s+"?postgres"?\s+)?IN\s+SCHEMA\s+"?public"?\s+GRANT\s+SELECT\s+ON\s+TABLES\s+TO\s+${role}`,
      "i",
    ),
  ]);
})();

function filterDiffLines(text) {
  return removeManagedConcurrentIndexStatements(text)
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim();
      if (!normalized) return false;

      // Supabase installs pg_net in a non-relocatable platform-selected schema.
      // Its presence and behavior are covered by pgTAP, so schema placement is
      // intentionally outside the application-owned drift boundary.
      if (/^CREATE EXTENSION pg_net WITH SCHEMA public;$/i.test(normalized)) return false;

      // This read-only connector role is managed outside migrations (it exists in production, not in
      // the shadow database, where the migrations skip its grants). Ignore its grants without masking
      // changes to application roles or objects: only the read-only statements of
      // CONNECTOR_ROLE_READ_GRANTS. Any other statement that names the role (a write privilege, a
      // policy, a grant shared with another role, a role membership, WITH GRANT OPTION) stays in the diff.
      if (CONNECTOR_ROLE_READ_GRANTS.some((pattern) => pattern.test(normalized))) return false;

      return !(
        /^-- Migration unit \d+:/i.test(normalized) ||
        /^-- (Transaction mode|Boundary reason):/i.test(normalized) ||
        /^SET check_function_bodies = false;$/i.test(normalized)
      );
    })
    .join("\n")
    .trim();
}

// What is kept of each output of the diff tool when it fails: its last lines, and no more than this
// many characters of them. The tool can print far more than a CI log shows (a job log was cut at
// 64 KiB, before the real error): only the end, where the error is, is useful.
const DIFF_TOOL_FAILURE_TAIL_LINES = 200;
const DIFF_TOOL_FAILURE_TAIL_CHARACTERS = 100_000;

const MASKED = "[masqué]";

// The tool is given the connection URL and may print it back. Removes the given URLs, their password
// (as written in the URL and decoded) and anything that looks like a Postgres connection URL.
function maskDatabaseUrls(text, databaseUrls) {
  const secrets = new Set();
  for (const databaseUrl of databaseUrls) {
    secrets.add(databaseUrl);
    try {
      const { password } = new URL(databaseUrl);
      secrets.add(password);
      secrets.add(decodeURIComponent(password));
    } catch {
      // Not a URL, or a password that is not valid percent-encoding: the text itself is still masked.
    }
  }
  return [...secrets]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((masked, secret) => masked.replaceAll(secret, MASKED), text)
    .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, MASKED);
}

// Everything the script prints when the diff tool failed, as one text: the `[schema-drift]` diagnosis
// first, so that it is read whatever the length of what follows, then the end of each output of the
// tool. That output is foreign text copied into a CI log: connection URLs are masked, and every copied
// line starts with `> `, so that none can be read as a GitHub workflow command (`::error::`,
// `::add-mask::`, `##[…]`), which must start its line.
function diffToolFailureReport({
  result,
  attempts,
  transient,
  githubActions = false,
  databaseUrls = [],
}) {
  const message = transient
    ? `TOOL UNREACHABLE: the diff tool could not connect to the database after ${attempts} attempts. The schema was not compared: this is NOT a schema drift. Re-run the workflow, or run "npm run check:schema-drift -- --remote".`
    : "DIFF TOOL FAILED: the diff tool exited with an error that is not a connection timeout (not retried). The schema was not compared.";
  const lines = [`[schema-drift] ${message}`];
  if (githubActions)
    lines.push(
      `::error title=${transient ? "Schema drift tool unreachable" : "Schema drift tool failed"}::${message}`,
    );
  const quote = (text) =>
    maskDatabaseUrls(String(text ?? ""), databaseUrls)
      .trimEnd()
      .split(/\r\n|\r|\n/);
  if (result.error)
    lines.push(
      result.error.code === "ENOBUFS"
        ? "[schema-drift] OUTPUT TRUNCATED BY THE BUFFER: the tool printed more than the script can hold and was stopped (ENOBUFS). What follows is the end of what was received, not the end of what the tool had to say."
        : `[schema-drift] Diff tool not run to its end: ${quote(result.error.message).join(" ")}`,
    );
  for (const stream of ["stdout", "stderr"]) {
    const output = quote(result[stream]);
    if (output.length === 1 && !output[0]) continue;
    const lastLines = output.slice(-DIFF_TOOL_FAILURE_TAIL_LINES).join("\n");
    const kept = lastLines.slice(-DIFF_TOOL_FAILURE_TAIL_CHARACTERS).split("\n");
    lines.push(
      `[schema-drift] Diff tool ${stream}, last ${kept.length} of ${output.length} line(s)${lastLines.length > DIFF_TOOL_FAILURE_TAIL_CHARACTERS ? `, cut to their last ${DIFF_TOOL_FAILURE_TAIL_CHARACTERS} characters` : ""}:`,
      ...kept.map((line) => `> ${line}`),
    );
  }
  return lines.join("\n");
}

// Waits (seconds) before the 2 extra attempts that follow a transient connection
// failure of the diff tool: 3 attempts in total.
const TRANSIENT_RETRY_DELAYS_SECONDS = Object.freeze([20, 40]);

// Signatures of "the tool could not reach the database". They are matched only on
// the output of a diff run that FAILED (non-zero exit). A diff that completed is
// never retried, so a real drift cannot be hidden by this list. A bare
// PGDELTA_SCRIPT_ERROR is deliberately not enough: pg-delta also reports genuine
// SQL errors under that code, which must fail at once.
const TRANSIENT_CONNECTION_PATTERNS = Object.freeze([
  /timeout exceeded when trying to connect/i,
  /connection terminated due to connection timeout/i,
  /connection terminated unexpectedly/i,
  /server closed the connection unexpectedly/i,
  /unable to check out connection from the pool/i,
  /connect(?:ion)? (?:to .{0,200} )?timed out/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/,
  /failed to connect to .{0,300}(?:timeout|refused|unreachable|reset)/is,
  /dial tcp .{0,200}(?:i\/o timeout|connection refused|no route to host)/i,
]);

function isTransientConnectionFailure(output) {
  const text = String(output ?? "");
  return TRANSIENT_CONNECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// Runs `attempt()` (resolving to { status, stdout, stderr }) and re-runs it only
// when it failed AND its output is a transient connection failure, waiting
// `delaysSeconds[i]` before retry i + 1. Any other outcome, success or failure,
// is returned immediately. Resolves to { result, attempts, transient }, where
// `transient` tells that the last failure was a connection failure (the tool
// never produced a verdict on the schema).
async function runWithTransientRetry({
  attempt,
  delaysSeconds = TRANSIENT_RETRY_DELAYS_SECONDS,
  sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
  log = () => {},
}) {
  const maxAttempts = delaysSeconds.length + 1;
  for (let number = 1; ; number += 1) {
    const result = await attempt(number);
    if (result.status === 0) return { result, attempts: number, transient: false };
    const transient = isTransientConnectionFailure(
      `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    );
    if (!transient) return { result, attempts: number, transient: false };
    if (number >= maxAttempts) return { result, attempts: number, transient: true };
    const delay = delaysSeconds[number - 1];
    log(
      `Diff tool could not reach the database (attempt ${number}/${maxAttempts}); retrying in ${delay}s.`,
    );
    await sleep(delay);
  }
}

export {
  DIFF_TOOL_FAILURE_TAIL_CHARACTERS,
  DIFF_TOOL_FAILURE_TAIL_LINES,
  TRANSIENT_RETRY_DELAYS_SECONDS,
  diffToolFailureReport,
  isTransientConnectionFailure,
  runWithTransientRetry,
  RECONCILED_CHECK_CONSTRAINTS,
  canonicalCheckCondition,
  canonicalConcurrentIndexDefinition,
  checkBody,
  isManagedConcurrentIndexDefinition,
  managedConcurrentIndexDefinitions,
  normalizeConcurrentIndexDefinition,
  normalizeDiff,
  normalizeDiffWithNotes,
  verifyConcurrentIndexes,
};
