import {
  operations,
  runConcurrentIndexOperations,
} from "../apply-supabase-concurrent-index-operations.mjs";

const managedConcurrentIndexDefinitions = new Set(
  operations.map((operation) => normalizeConcurrentIndexDefinition(operation.createSql)),
);

function normalizeConcurrentIndexDefinition(value) {
  return String(value)
    .trim()
    .replace(/^create\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?/i, "create index ")
    .replace(/"([a-z_][a-z0-9_]*)"/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

function isManagedConcurrentIndexDefinition(value) {
  return managedConcurrentIndexDefinitions.has(normalizeConcurrentIndexDefinition(value));
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
// "Apply Supabase Migrations"). They are the only constraints of the schema that
// combine a BETWEEN with another AND.
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
// is logically the pinned one. Anything else is left in the diff.
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
  for (const reconciled of RECONCILED_CHECK_CONSTRAINTS) {
    const key = `${reconciled.table}#${reconciled.name}`;
    const drop = drops.find((candidate) => candidate.key === key);
    const add = adds.find((candidate) => candidate.key === key);
    if (!drop || !add) continue;
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
  return result;
}

function normalizeDiff(value) {
  return removeReconciledCheckConstraints(String(value))
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim();
      if (!normalized) return false;

      if (isManagedConcurrentIndexDefinition(normalized)) return false;

      // Supabase installs pg_net in a non-relocatable platform-selected schema.
      // Its presence and behavior are covered by pgTAP, so schema placement is
      // intentionally outside the application-owned drift boundary.
      if (/^CREATE EXTENSION pg_net WITH SCHEMA public;$/i.test(normalized)) return false;

      // This read-only connector role is managed outside migrations. Ignore its
      // grants without masking changes to application roles or objects.
      if (/\blovable_readonly\b/i.test(normalized)) return false;

      return !(
        /^-- Migration unit \d+:/i.test(normalized) ||
        /^-- (Transaction mode|Boundary reason):/i.test(normalized) ||
        /^SET check_function_bodies = false;$/i.test(normalized)
      );
    })
    .join("\n")
    .trim();
}

export {
  RECONCILED_CHECK_CONSTRAINTS,
  canonicalCheckCondition,
  checkBody,
  isManagedConcurrentIndexDefinition,
  managedConcurrentIndexDefinitions,
  normalizeConcurrentIndexDefinition,
  normalizeDiff,
  verifyConcurrentIndexes,
};
