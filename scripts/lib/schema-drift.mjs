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

function normalizeDiff(value) {
  return String(value)
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
  isManagedConcurrentIndexDefinition,
  managedConcurrentIndexDefinitions,
  normalizeConcurrentIndexDefinition,
  normalizeDiff,
  verifyConcurrentIndexes,
};
