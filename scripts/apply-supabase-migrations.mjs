#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(root, "supabase", "migrations");

// Supabase's historical schema_migrations rows for these eight versions have
// no statements array. They are accepted only when both the immutable version
// and name match and the checked-in file still has this exact SHA-256 digest.
// A missing digest for any other version remains a hard failure.
const LEGACY_NO_STATEMENT_MIGRATIONS = Object.freeze({
  ["20260520202829"]: Object.freeze({
    name: "add_geo_index",
    localContentSha256: "a411cc06e2a4365b2afc1eb511b86b33d7184c08558d8c0c11f00786f4de8e23",
  }),
  ["20260527160000"]: Object.freeze({
    name: "scoring_evidence",
    localContentSha256: "20823027e61b624d822d5289ab6b37a4470369b808abeab4d352d9d68e5c7dd2",
  }),
  ["20260527193000"]: Object.freeze({
    name: "harden_public_grants",
    localContentSha256: "b221fd749d1788f56e098fd3d9fa8a28aa8cbbe8c4455ba4341e691af4b9e863",
  }),
  ["20260601103000"]: Object.freeze({
    name: "investor_read_model",
    localContentSha256: "ade0f1686d5aaec9522c24d6c7e9703a7e44810b42a68aca425faba9d3f92e02",
  }),
  ["20260604120840"]: Object.freeze({
    name: "map_pins_read_model",
    localContentSha256: "3565ddcb7fd37acecf6a49c411fee7bf43f6693137325c672ab039554fe1eaa2",
  }),
  ["20260604183000"]: Object.freeze({
    name: "require_auth_for_auction_reads",
    localContentSha256: "d46f78716ad69549b7057f1e44e0f51e44924c0ed70c7b7b5473bbc4b7293bee",
  }),
  ["20260630180814"]: Object.freeze({
    name: "restrict_sales_detail_to_authenticated",
    localContentSha256: "26233de6d73b94340b677e3ca1891c7f3b836037fa22e1282fb14af8a50a9100",
  }),
  ["20260630181544"]: Object.freeze({
    name: "use_admin_app_metadata",
    localContentSha256: "5abeb976acf20de0c302ecbce85cf50bcde677817236ce25f64f42db065562d5",
  }),
});

// These are the only sixteen one-statement historical rows whose exact
// production statement digest differs from the current checked-in file. Each
// pair was reviewed against the exact remote statement on 2026-10-08. The
// local file is retained so it remains the restoration/source-of-truth file;
// this registry is an explicit, per-version reconciliation rather than a
// general bypass for changed migration content. Each entry is accepted only
// after reviewing its exact SQL difference and proving the final live object
// state; a future entry without that proof remains a hard failure.
const HISTORICAL_CONTENT_DRIFT = Object.freeze({
  ["20260614162839"]: Object.freeze({
    name: "perf_rls_initplan_dedupe_indexes",
    remoteStatementSha256: "c8678879608d2845ec6357662f18f63359a69e31bdc6b2213ca50d4ce5c7ab0a",
    localContentSha256: "e873e293a2d66cdc75cf662e4348e041627bc1c9c0728d372f251ad935cb4d4a",
    category: "semantic",
    reason:
      "The remote statement created the FK index directly; the local replay-safe variant guards it with to_regclass. Production has auction_observations and the canonical_source_url index, so the final state is present without a convergence migration.",
    review:
      "Reviewed the exact remote statement and checked the live final state: public.auction_observations exists and idx_auction_observations_canonical_source_url exists.",
    requiresFutureMigration: false,
  }),
  ["20260614164833"]: Object.freeze({
    name: "drop_unused_auction_sales_app_read",
    remoteStatementSha256: "ea38afa3d2d484c1b6a059bd1f7687c9143e6040c2e46b7ce181cf72f620bd72",
    localContentSha256: "49e142e84601709aad49b6c369ebfefe4f9083b40c192d21339beda73e30b611",
    category: "semantic",
    reason:
      "The remote statement only dropped auction_sales_app_read; the local history also recreated v_auction_map_pins. Later migrations 20260729084500 and 20260729085000 define that view and grants explicitly, and the obsolete table is absent in production.",
    review:
      "Reviewed the exact remote statement and checked the live final state: auction_sales_app_read is absent and v_auction_map_pins has the canonical 15-column definition with authenticated SELECT.",
    requiresFutureMigration: false,
  }),
  ["20260618093052"]: Object.freeze({
    name: "add_sale_media_to_app_view",
    remoteStatementSha256: "7c6ca570e93d275cf85b8e5709254b233fa3fc97fe9b2f26065339a3dbadcbd6",
    localContentSha256: "3f171f92171e744d9e7f3caef59fcc5acf0aab7f34edb42638c9766d4df23d2d",
    category: "semantic",
    reason:
      "The remote statement retained the older application view; later view migrations carry forward source_blocks and the media filtering into the final public view definition.",
    review:
      "Reviewed the exact remote view definition and checked the live final state: v_auction_sales_app exposes source_blocks, about_description, source metadata, and media filtering markers.",
    requiresFutureMigration: false,
  }),
  ["20260618095542"]: Object.freeze({
    name: "restore_app_view_source_grants",
    remoteStatementSha256: "a6aa9c0c32658090b2549388cc9e20857862fc4182b162d928153e4a7f7729f8",
    localContentSha256: "e6ac30820c0ded472e6cc2228771d572523a783b2495ed6ef1e85a2c430f81c8",
    category: "formatting",
    reason: "The checked-in file adds explanatory comments while retaining the same grants.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260619073859"]: Object.freeze({
    name: "add_source_blocks_to_app_view",
    remoteStatementSha256: "6011786e8a993b562aaa893fcfb9f7dde8411a4e9ace665eb65c07d4d2e3af77",
    localContentSha256: "d50e80e8edffac81a15193772d41ade959f86b8986122f21db0bbb25168e2e30",
    category: "semantic",
    reason:
      "The local placeholder replaced an old full view statement because later migrations define the final source_blocks-aware view; it does not erase the later schema history.",
    review:
      "Reviewed the exact remote view definition and verified later view migrations are recorded in production; the live v_auction_sales_app has the final source_blocks-aware shape.",
    requiresFutureMigration: false,
  }),
  ["20260630144617"]: Object.freeze({
    name: "add_about_description_to_app_view",
    remoteStatementSha256: "0e38813d2408246b078dfb3bdbaa8ef10f78e6653053b143fa5f1e76a7d3a039",
    localContentSha256: "ce1439ffb29e915dfba2c518d985563934ed9f7ee621ae5df9fde0e2cc9c6dc1",
    category: "semantic",
    reason:
      "The remote statement retained the older application view; later migrations extend it with source_blocks, descriptions, catalogue visibility and source checks.",
    review:
      "Reviewed the exact remote view definition and checked the live final state: v_auction_sales_app includes source_blocks, about_description, source_presence and source checks.",
    requiresFutureMigration: false,
  }),
  ["20260710145100"]: Object.freeze({
    name: "search_auction_sales_preview",
    remoteStatementSha256: "231a2c8fd0db8c01e6ea99d119056032328fa431056d8b289b10512c690ea786",
    localContentSha256: "6d37d00cfc964e656dfb33953bad63938690da79e2afee27027478d9264abe97",
    category: "semantic",
    reason:
      "The remote statement has the earlier search signature; 20260710145505 and later safety/catalogue migrations carry the expanded filters into the live base function and versioned v2-v4 functions.",
    review:
      "Reviewed the exact remote function definition and checked the live final state: app_private.search_auction_sales_preview has the expanded signature, while v2, v3 and v4 are also present with the later sale/date filters.",
    requiresFutureMigration: false,
  }),
  ["20260710145505"]: Object.freeze({
    name: "expand_search_auction_sales_preview_filters",
    remoteStatementSha256: "eeae2f26f31214bdfcb60ba954b5d82aed44597801aff76a22df041533ca44b2",
    localContentSha256: "4b15cbe80437ad3cb63900f98de8ecc4680f72d91f891383688b76e2dfe52bc1",
    category: "formatting",
    reason: "The checked-in file adds explanatory comments before the same drops.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260714162824"]: Object.freeze({
    name: "grant_service_role_lawyer_marketplace",
    remoteStatementSha256: "2ef828f84b35d84fabd2f5adfacd13acfe9e5be9b4d3bf55b73b98c9116df034",
    localContentSha256: "ff2d275f8b4e59eea3a1566a6e45ff36576b74ce5a6d21edd16749ea63108251",
    category: "formatting",
    reason: "The checked-in file adds explanatory comments before the same grants.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260820133258"]: Object.freeze({
    name: "fix_outcome_bridge_reattachment",
    remoteStatementSha256: "57bd182ad38df0a21ebd76383a9620f48fd6364ca0087adca7cf58903175188b",
    localContentSha256: "fe43712652e73a7471eb8f1195ee855b6f25d04a282e220aad5c108dd1827178",
    category: "formatting",
    reason: "The checked-in file adds an explanatory comment before the same SQL.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260825103748"]: Object.freeze({
    name: "centralize_information_agent_cases",
    remoteStatementSha256: "04163767ea00dd099818a7f3fbe101e5b326a56c726cbd5d0d5b02ce1c83cc49",
    localContentSha256: "0e9884c0bd53db9aadacb492825ece0fbc513f76e418526a47b14410cd13e6e8",
    category: "formatting",
    reason: "The checked-in file adds a version-alignment comment before the same SQL.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260825131944"]: Object.freeze({
    name: "analyze_information_agent_evidence",
    remoteStatementSha256: "91a88ccb078ee3a17b91ebd88ef419056366e86ac5effb9e535d22b6d2f32d4f",
    localContentSha256: "c21f7b303211b965a0e60893deb1015c63cc9b6700aac6548a4eb54364d24ba8",
    category: "formatting",
    reason: "The checked-in file adds a version-alignment comment before the same SQL.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260825131959"]: Object.freeze({
    name: "information_agent_email_templates",
    remoteStatementSha256: "f092d7a60e3bb534823fb5f5db813eb7a1dfacb4763875757c386e91f1be30a1",
    localContentSha256: "aeaeffad937336e967f036eb645a348c8c57e4c4b28bf5b18a19f072dcdb896b",
    category: "formatting",
    reason: "The checked-in file adds a version-alignment comment before the same SQL.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260825132113"]: Object.freeze({
    name: "index_information_agent_foreign_keys",
    remoteStatementSha256: "c0066f1bea2a5dbf6234f861bc3bd9f644206ba269435e1ea1b30cb04a31f583",
    localContentSha256: "bff1d0b55e2c1496751b3c73356d2972f8b7d28f0704c7ca7ee6cd09fbea8815",
    category: "formatting",
    reason: "The checked-in file adds a version-alignment comment before the same SQL.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260910160206"]: Object.freeze({
    name: "enforce_manual_collection_and_enrichment",
    remoteStatementSha256: "c18d89b3a2095ccc7a10e3d1782d2ebee5660a6aac7528ae581b2fe89165ac16",
    localContentSha256: "b6bb0c2c92306061ae2bf1b78f69ee2ab66fc57ad35cbee2ecc8385877da50db",
    category: "formatting",
    reason: "The checked-in file adds one explanatory comment before the same SQL.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
  ["20260916135700"]: Object.freeze({
    name: "compact_auction_sale_history",
    remoteStatementSha256: "114f88e61ad9a25a98b1ede678b6a8efd68f423a570fbd97fa3dead00a7e683c",
    localContentSha256: "306b7f2ab653ddfb83325135770ed56ddf273391e12e1ecbcd58a5352e20ef3e",
    category: "formatting",
    reason: "The checked-in file adds explanatory comments before the same SQL.",
    review:
      "Reviewed the exact remote statement and ignored comments only; executable SQL is unchanged.",
    requiresFutureMigration: false,
  }),
});

async function main() {
  loadEnvironmentFiles();

  const runOnlyIfEnabled = process.argv.includes("--if-enabled");
  const dryRun = process.argv.includes("--dry-run");
  const checkOnly = process.argv.includes("--check");

  if (runOnlyIfEnabled && !isTruthy(process.env.RUN_SUPABASE_MIGRATIONS_ON_BUILD)) {
    console.log("[supabase-migrations] Skipped; RUN_SUPABASE_MIGRATIONS_ON_BUILD is not enabled.");
    process.exit(0);
  }

  const migrations = collectMigrations(migrationsDir);

  if (!migrations.length) {
    console.error("[supabase-migrations] No migration files found.");
    process.exit(1);
  }

  const migrationsByVersion = Map.groupBy(migrations, (migration) => migration.version);
  const duplicateVersions = [...migrationsByVersion.entries()].filter(
    ([, versionMigrations]) => versionMigrations.length > 1,
  );

  if (duplicateVersions.length) {
    console.error("[supabase-migrations] Duplicate local migration versions detected:");
    for (const [version, versionMigrations] of duplicateVersions) {
      console.error(`  - ${version}: ${versionMigrations.map(({ file }) => file).join(", ")}`);
    }
    console.error("[supabase-migrations] Assign one unique timestamp to every migration.");
    process.exit(1);
  }

  if (checkOnly) {
    console.log(
      `[supabase-migrations] ${migrations.length} migration files have unique local versions.`,
    );
    process.exit(0);
  }

  const dbUrl = firstFilledEnv(
    process.env.SUPABASE_DB_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.POSTGRES_URL,
  );

  if (!dbUrl) {
    console.error(
      "[supabase-migrations] SUPABASE_DB_URL, POSTGRES_URL_NON_POOLING or POSTGRES_URL is required.",
    );
    process.exit(1);
  }

  const runner = await createRunner(dbUrl);
  try {
    const remoteMigrations = await runner.listAppliedMigrations();
    const historyIssues = validateMigrationHistory(migrations, remoteMigrations);
    if (historyIssues.length) {
      console.error("[supabase-migrations] Migration history integrity checks failed:");
      for (const issue of historyIssues) console.error(`  - ${issue}`);
      throw new Error("Migration history integrity checks failed.");
    }

    for (const migration of migrations) {
      const remote = remoteMigrations.find(({ version }) => version === migration.version);
      const baseline = LEGACY_NO_STATEMENT_MIGRATIONS[migration.version];
      if (
        remote &&
        baseline &&
        (remote.statementDigests == null || remote.statementDigests.length === 0) &&
        baseline.name === migration.name &&
        baseline.localContentSha256 === migration.contentSha256
      ) {
        console.warn(
          `[supabase-migrations] Legacy compatibility: ${migration.file} has no remote statement digest; local baseline ${migration.contentSha256} matches. Remote SQL remains unverifiable.`,
        );
      }

      const drift = HISTORICAL_CONTENT_DRIFT[migration.version];
      if (
        remote &&
        drift &&
        remote.name === migration.name &&
        remote.statementDigests?.length === 1 &&
        remote.statementDigests[0] === drift.remoteStatementSha256 &&
        migration.contentSha256 === drift.localContentSha256
      ) {
        console.warn(
          `[supabase-migrations] Explicit historical reconciliation: ${migration.file} category=${drift.category}; ${drift.reason} Future migration required=${drift.requiresFutureMigration}.`,
        );
      }
    }

    const remoteVersions = new Set(remoteMigrations.map(({ version }) => version));

    const pending = migrations.filter((migration) => !remoteVersions.has(migration.version));
    if (!pending.length) {
      console.log("[supabase-migrations] Remote migration history is up to date.");
      return;
    }

    console.log(
      `[supabase-migrations] Pending migrations: ${pending.map((m) => m.file).join(", ")}`,
    );
    if (dryRun) {
      console.log("[supabase-migrations] Dry run complete; no SQL was applied.");
      return;
    }

    for (const migration of pending) {
      console.log(`[supabase-migrations] Applying ${migration.file}`);
      await applyMigrationAtomically(runner, migration);
    }

    console.log("[supabase-migrations] Applied all pending migrations.");
  } finally {
    await runner.close();
  }
}

async function applyMigrationAtomically(runner, migration) {
  const source = readFileSync(migration.path, "utf8");
  const body = stripOuterTransactionWrappers(source);
  const statement = `
begin;
${body}
insert into supabase_migrations.schema_migrations (version, name, statements, created_by)
  values (${sqlLiteral(migration.version)}, ${sqlLiteral(migration.name)}, ${sqlArray([source])}, 'github-actions')
on conflict (version) do nothing;
commit;
`;
  try {
    await runner.command(statement);
  } catch (error) {
    try {
      await runner.command("rollback;");
    } catch {
      // A disconnected runner has already caused PostgreSQL to roll back.
    }
    throw error;
  }
}

function stripOuterTransactionWrappers(source) {
  const value = String(source);
  const masked = maskSqlNonCode(value);
  if (/\b(?:create\s+(?:unique\s+)?index|drop\s+index)\s+concurrently\b/i.test(masked)) {
    throw new Error(
      "Cannot wrap a migration containing an index CONCURRENTLY operation in the atomic apply-and-record transaction.",
    );
  }
  const opening = /^\s*begin\s*;/i.exec(masked);
  if (!opening) return value;
  const closing = /\bcommit\s*;/i.exec(masked.slice(opening[0].length));
  if (!closing) return value;

  const commitStart = opening[0].length + closing.index;
  const suffixStart = commitStart + closing[0].length;
  // The existing SQL lexer consumes comments and quoted payloads once. Avoid
  // ambiguous repeated comment regexes, and inspect only executable tokens.
  const suffixCode = masked.slice(suffixStart).trim();
  if (suffixCode && !/^notify\s+pgrst\s*,\s*;$/i.test(suffixCode)) {
    throw new Error(
      "Cannot safely remove the migration transaction wrapper because executable statements follow COMMIT.",
    );
  }

  const body = value.slice(opening[0].length, commitStart).trimEnd() + value.slice(suffixStart);
  return body;
}

// Replace SQL comments and quoted values/identifiers with whitespace while
// preserving newlines and executable text. This keeps the CONCURRENTLY guard
// focused on SQL tokens instead of words in migration comments or literals.
function maskSqlNonCode(source) {
  const value = String(source);
  const masked = value.split("");

  const blank = (index) => {
    if (value[index] !== "\n" && value[index] !== "\r") masked[index] = " ";
  };

  const blankRange = (start, end) => {
    for (let index = start; index < end; index += 1) blank(index);
  };

  const maskSingleQuotedString = (start, escaped) => {
    let index = start;
    blank(index);
    index += 1;

    while (index < value.length) {
      if (escaped && value[index] === "\\") {
        blank(index);
        if (index + 1 < value.length) blank(index + 1);
        index += 2;
        continue;
      }
      if (value[index] === "'") {
        blank(index);
        if (value[index + 1] === "'") {
          blank(index + 1);
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      blank(index);
      index += 1;
    }

    return index;
  };

  const maskDoubleQuotedIdentifier = (start) => {
    let index = start;
    blank(index);
    index += 1;

    while (index < value.length) {
      if (value[index] === '"') {
        blank(index);
        if (value[index + 1] === '"') {
          blank(index + 1);
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      blank(index);
      index += 1;
    }

    return index;
  };

  const maskBlockComment = (start) => {
    let index = start;
    let depth = 0;

    while (index < value.length) {
      if (value[index] === "/" && value[index + 1] === "*") {
        depth += 1;
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (value[index] === "*" && value[index + 1] === "/") {
        blank(index);
        blank(index + 1);
        index += 2;
        depth -= 1;
        if (depth === 0) break;
        continue;
      }
      blank(index);
      index += 1;
    }

    return index;
  };

  const dollarQuoteDelimiter = (start) => {
    const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(value.slice(start));
    if (!match) return null;
    const previous = value[start - 1];
    if (previous && /[A-Za-z0-9_$]/.test(previous)) return null;
    return match[0];
  };

  for (let index = 0; index < value.length; ) {
    if (value[index] === "-" && value[index + 1] === "-") {
      const relativeLineEnd = value.slice(index + 2).search(/[\r\n]/);
      const end = relativeLineEnd === -1 ? value.length : index + 2 + relativeLineEnd;
      blankRange(index, end);
      index = end;
      continue;
    }

    if (value[index] === "/" && value[index + 1] === "*") {
      index = maskBlockComment(index);
      continue;
    }

    if (
      (value[index] === "E" || value[index] === "e") &&
      value[index + 1] === "'" &&
      (!value[index - 1] || !/[A-Za-z0-9_$]/.test(value[index - 1]))
    ) {
      blank(index);
      index = maskSingleQuotedString(index + 1, true);
      continue;
    }

    if (value[index] === "'") {
      index = maskSingleQuotedString(index, false);
      continue;
    }

    if (value[index] === '"') {
      index = maskDoubleQuotedIdentifier(index);
      continue;
    }

    if (value[index] === "$") {
      const delimiter = dollarQuoteDelimiter(index);
      if (delimiter) {
        const end = value.indexOf(delimiter, index + delimiter.length);
        const after = end === -1 ? value.length : end + delimiter.length;
        blankRange(index, after);
        index = after;
        continue;
      }
    }

    index += 1;
  }

  return masked.join("");
}

function loadEnvironmentFiles() {
  const initialEnv = new Set(
    Object.keys(process.env).filter((name) => !isMissing(process.env[name])),
  );

  for (const file of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    ".env.vercel-production.local",
  ]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (!match || initialEnv.has(match[1])) continue;
      const value = unquote(match[2].trim());
      if (!isMissing(value) || isMissing(process.env[match[1]])) process.env[match[1]] = value;
    }
  }
}

function collectMigrations(directory = migrationsDir) {
  return readdirSync(directory)
    .map((file) => {
      const match = /^(\d{14})_(.+)\.sql$/.exec(file);
      if (!match) return null;
      const path = join(directory, file);
      const source = readFileSync(path, "utf8");
      return {
        file,
        path,
        version: match[1],
        name: match[2],
        contentSha256: sha256(canonicalMigrationText(source)),
        contentSha256Candidates: migrationContentSha256Candidates(source),
        statementDigests: statementDigestsFromSql(source),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.version.localeCompare(b.version));
}

function validateMigrationHistory(localMigrations, remoteMigrations) {
  const issues = [];
  const localByVersion = new Map(
    localMigrations.map((migration) => [migration.version, migration]),
  );
  const remoteByVersion = new Map();

  for (const remote of remoteMigrations) {
    const version = String(remote?.version || "").trim();
    if (!version) {
      issues.push("Remote migration history contains a row without a version.");
      continue;
    }
    if (remoteByVersion.has(version)) {
      issues.push(`Remote migration history contains duplicate version ${version}.`);
      continue;
    }
    remoteByVersion.set(version, remote);

    if (!localByVersion.has(version)) {
      const name = normalizeMigrationName(remote.name);
      issues.push(
        `Remote migration ${version}${name ? `_${name}` : ""} is missing from the local migration directory.`,
      );
    }
  }

  for (const local of localMigrations) {
    const remote = remoteByVersion.get(local.version);
    if (!remote) continue;

    const remoteName = normalizeMigrationName(remote.name);
    if (remoteName !== local.name) {
      issues.push(
        `Migration ${local.version} name differs: remote=${JSON.stringify(remoteName)}, local=${JSON.stringify(local.name)}.`,
      );
    }

    const remoteDigests = remote.statementDigests;
    if (remoteDigests == null || (Array.isArray(remoteDigests) && remoteDigests.length === 0)) {
      const baseline = LEGACY_NO_STATEMENT_MIGRATIONS[local.version];
      if (
        !baseline ||
        baseline.name !== local.name ||
        baseline.localContentSha256 !== local.contentSha256
      ) {
        issues.push(
          `Migration ${local.version}_${local.name} has no verifiable remote statement digest and does not match the fixed legacy baseline; refusing to treat it as applied.`,
        );
      }
      continue;
    }

    if (!isSha256Array(remoteDigests)) {
      issues.push(
        `Migration ${local.version}_${local.name} has malformed remote statement digests; refusing to treat it as applied.`,
      );
      continue;
    }

    if (remoteDigests.length === 1) {
      const localContentDigests = local.contentSha256Candidates || [local.contentSha256];
      const matchesCurrentFile = localContentDigests.includes(remoteDigests[0]);
      const historicalDrift = HISTORICAL_CONTENT_DRIFT[local.version];
      const matchesApprovedHistoricalDrift =
        historicalDrift &&
        historicalDrift.name === local.name &&
        historicalDrift.remoteStatementSha256 === remoteDigests[0] &&
        historicalDrift.localContentSha256 === local.contentSha256 &&
        historicalDrift.requiresFutureMigration === false &&
        typeof historicalDrift.reason === "string" &&
        historicalDrift.reason.trim().length > 0 &&
        typeof historicalDrift.review === "string" &&
        historicalDrift.review.trim().length > 0;
      if (!matchesCurrentFile && !matchesApprovedHistoricalDrift) {
        issues.push(
          `Migration ${local.version}_${local.name} content digest differs: remote=${remoteDigests[0]}, local_candidates=${localContentDigests.join(",")}.`,
        );
      }
      continue;
    }

    const localDigests = local.statementDigests;
    if (!isSha256Array(localDigests) || !sameDigestSequence(remoteDigests, localDigests)) {
      issues.push(
        `Migration ${local.version}_${local.name} statement digest sequence differs: remote_count=${remoteDigests.length}, local_count=${localDigests?.length ?? 0}, remote_sequence=${digestSequenceSha256(remoteDigests)}, local_sequence=${digestSequenceSha256(localDigests || [])}.`,
      );
    }
  }

  return issues;
}

function normalizeMigrationName(value) {
  return String(value || "").trim();
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function getDatabaseConnectTimeoutSeconds() {
  return Math.min(
    900,
    Math.max(15, Number.parseInt(process.env.PGCONNECT_TIMEOUT || "60", 10) || 60),
  );
}

function getDatabaseConnectRetries() {
  return Math.min(
    60,
    Math.max(1, Number.parseInt(process.env.SUPABASE_MIGRATION_CONNECT_RETRIES || "1", 10) || 1),
  );
}

function getDatabaseRetryDelaySeconds() {
  return Math.min(
    60,
    Math.max(5, Number.parseInt(process.env.SUPABASE_MIGRATION_RETRY_DELAY || "15", 10) || 15),
  );
}

function getDatabaseRetryBudgetSeconds() {
  return Math.min(
    2_400,
    Math.max(
      30,
      Number.parseInt(process.env.SUPABASE_MIGRATION_RETRY_BUDGET_SECONDS || "2_400", 10) || 2_400,
    ),
  );
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  return `array[${values.map(sqlLiteral).join(", ")}]::text[]`;
}

function canonicalMigrationText(value) {
  return String(value).replace(/\r\n?/g, "\n").trimEnd();
}

function canonicalStatement(value) {
  return String(value).replace(/\r\n?/g, "\n").trim();
}

function fileSha256(path) {
  return sha256(canonicalMigrationText(readFileSync(path, "utf8")));
}

function migrationContentSha256Candidates(source) {
  const canonical = canonicalMigrationText(source);
  const candidates = [canonical, canonicalStatement(canonical)];
  const withoutTransactionWrappers = canonical
    .replace(/^begin;\s*/i, "")
    .replace(/\s*commit;\s*$/i, "")
    .trimEnd();
  if (withoutTransactionWrappers !== canonical) {
    candidates.push(withoutTransactionWrappers, canonicalStatement(withoutTransactionWrappers));
  }
  return [...new Set(candidates.map(sha256))];
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function hexToUtf8(value) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[a-f0-9]*$/i.test(value)) {
    throw new Error("Postgres returned an invalid UTF-8 hex statement value.");
  }
  return Buffer.from(value, "hex").toString("utf8");
}

function statementsSha256(statements) {
  if (!Array.isArray(statements) || statements.length === 0) return null;
  if (statements.some((statement) => typeof statement !== "string")) {
    throw new Error("Migration statements must be strings.");
  }
  return statements.map((statement) =>
    createHash("sha256").update(canonicalStatement(statement)).digest("hex"),
  );
}

function statementDigestsFromSql(sql) {
  return statementsSha256(splitSqlStatements(sql));
}

function splitSqlStatements(sql) {
  const source = String(sql).replace(/\r\n?/g, "\n");
  const statements = [];
  let start = 0;
  let index = 0;
  let quote = null;
  let backslashEscapes = false;
  let dollarTag = null;
  let lineComment = false;
  let blockCommentDepth = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      index += 1;
      if (character === "\n") lineComment = false;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (character === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        dollarTag = null;
      } else {
        index += 1;
      }
      continue;
    }

    if (quote === "'") {
      if (backslashEscapes && character === "\\") {
        index += Math.min(2, source.length - index);
      } else if (character === "'" && next === "'") {
        index += 2;
      } else if (character === "'") {
        quote = null;
        backslashEscapes = false;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (quote === '"') {
      if (character === '"' && next === '"') {
        index += 2;
      } else if (character === '"') {
        quote = null;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      lineComment = true;
      index += 2;
      continue;
    }

    if (character === "/" && next === "*") {
      blockCommentDepth = 1;
      index += 2;
      continue;
    }

    if (character === "'") {
      quote = "'";
      const previous = source[index - 1] ?? "";
      const beforePrevious = source[index - 2] ?? "";
      backslashEscapes =
        (previous === "e" || previous === "E") && !/[A-Za-z0-9_]/.test(beforePrevious);
      index += 1;
      continue;
    }

    if (character === '"') {
      quote = '"';
      backslashEscapes = false;
      index += 1;
      continue;
    }

    if (character === "$" && next !== undefined) {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(source.slice(index));
      if (match) {
        dollarTag = match[0];
        index += dollarTag.length;
        continue;
      }
    }

    if (character === ";") {
      const statement = canonicalStatement(source.slice(start, index));
      if (statement) statements.push(statement);
      start = index + 1;
    }
    index += 1;
  }

  const trailing = canonicalStatement(source.slice(start));
  if (trailing) statements.push(trailing);
  return statements;
}

function isSha256Array(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isSha256);
}

function sameDigestSequence(left, right) {
  return left.length === right.length && left.every((digest, index) => digest === right[index]);
}

function digestSequenceSha256(digests) {
  return createHash("sha256").update(JSON.stringify(digests)).digest("hex");
}

function unquote(value) {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

function firstFilledEnv(...values) {
  return values.find((value) => !isMissing(value))?.trim();
}

function isMissing(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return (
    !normalized ||
    normalized.startsWith("your-") ||
    ["changeme", "placeholder", "todo", "null", "undefined"].includes(normalized)
  );
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

async function createRunner(dbUrl) {
  const requestedRunner = String(process.env.SUPABASE_MIGRATION_RUNNER || "auto")
    .trim()
    .toLowerCase();

  if (requestedRunner === "postgres-js") return createPostgresJsRunner(dbUrl);

  if (!["auto", "psql"].includes(requestedRunner)) {
    throw new Error(
      `[supabase-migrations] Unsupported SUPABASE_MIGRATION_RUNNER: ${requestedRunner}`,
    );
  }

  const psqlBin = resolvePsqlBin();
  if (psqlBin) return createPsqlRunner(dbUrl, psqlBin);
  if (requestedRunner === "psql") {
    throw new Error("[supabase-migrations] psql runner requested but psql is unavailable.");
  }
  return createPostgresJsRunner(dbUrl);
}

function createPsqlRunner(dbUrl, psqlBin) {
  const connectionUrl = withDatabaseConnectTimeout(dbUrl);
  console.log(`[supabase-migrations] Using psql runner: ${psqlBin}`);
  return {
    listAppliedMigrations() {
      return Promise.resolve(
        psql(connectionUrl, psqlBin, [
          "--tuples-only",
          "--no-align",
          "--command",
          `select json_build_object(
            'version', version,
            'name', coalesce(name, ''),
            'statementHexes', case
              when statements is null or cardinality(statements) = 0 then null
              else (
                select json_agg(
                  encode(convert_to(statement, 'UTF8'), 'hex')
                  order by ordinal
                )
                from unnest(statements) with ordinality as item(statement, ordinal)
              )
            end
          )::text
          from supabase_migrations.schema_migrations
          order by version;`,
        ])
          .stdout.trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ).then((lines) =>
        lines.map((line) => {
          const row = JSON.parse(line);
          return {
            version: String(row.version || "").trim(),
            name: normalizeMigrationName(row.name),
            statementDigests:
              row.statementHexes == null
                ? null
                : Array.isArray(row.statementHexes)
                  ? statementsSha256(row.statementHexes.map(hexToUtf8))
                  : null,
          };
        }),
      );
    },
    command(statement) {
      psql(connectionUrl, psqlBin, ["--set=ON_ERROR_STOP=1", "--command", statement]);
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

async function createPostgresJsRunner(dbUrl) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(withMigrationSessionSettings(dbUrl), {
    max: 1,
    connect_timeout: getDatabaseConnectTimeoutSeconds(),
    ssl: resolvePostgresSslOptions(dbUrl),
  });

  console.log("[supabase-migrations] Using Postgres.js runner.");

  return {
    async listAppliedMigrations() {
      const rows = await retryTransientConnection(
        () => sql`
          select version, coalesce(name, '') as name, statements
          from supabase_migrations.schema_migrations
          order by version
        `,
      );
      return rows
        .map((row) => ({
          version: String(row.version).trim(),
          name: String(row.name || "").trim(),
          statementDigests: statementsSha256(row.statements),
        }))
        .filter(({ version }) => Boolean(version));
    },
    async command(statement) {
      await sql.unsafe(statement);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

async function retryTransientConnection(operation) {
  const retries = getDatabaseConnectRetries();
  const retryDelaySeconds = getDatabaseRetryDelaySeconds();
  const deadline = Date.now() + getDatabaseRetryBudgetSeconds() * 1000;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isTransientConnectionError(error)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= retryDelaySeconds * 1000) {
        throw new Error(
          `[supabase-migrations] Database connection retry budget exhausted after ${getDatabaseRetryBudgetSeconds()}s.`,
          { cause: error },
        );
      }
      console.warn(
        `[supabase-migrations] Database unavailable; retrying connection in ${retryDelaySeconds}s (${attempt}/${retries}).`,
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelaySeconds * 1000));
    }
  }
}

function isTransientConnectionError(error) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();
  return (
    code.startsWith("08") ||
    ["53300", "57P03", "ECONNRESET", "ETIMEDOUT"].includes(code) ||
    message.includes("authentication query failed") ||
    message.includes("echeckouttimeout") ||
    message.includes("unable to check out connection from the pool") ||
    message.includes("connection to database not available") ||
    message.includes("connection terminated due to connection timeout") ||
    message.includes("circuit breaker open")
  );
}

function withMigrationSessionSettings(dbUrl) {
  const url = new URL(dbUrl);
  if (url.hostname.endsWith(".pooler.supabase.com")) {
    url.port = "5432";
  }
  const existingOptions = url.searchParams.get("options")?.trim();
  const statementTimeoutOption = "-c statement_timeout=0";
  if (!existingOptions?.includes("statement_timeout")) {
    url.searchParams.set(
      "options",
      [existingOptions, statementTimeoutOption].filter(Boolean).join(" "),
    );
  }
  return url.toString();
}

function psql(dbUrl, psqlBin, args, options = {}) {
  const result = spawnSync(psqlBin, [dbUrl, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: String(getDatabaseConnectTimeoutSeconds()),
    },
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    if (!options.inherit) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }

  return result;
}

function withDatabaseConnectTimeout(dbUrl) {
  const url = new URL(withMigrationSessionSettings(dbUrl));
  url.searchParams.set("connect_timeout", String(getDatabaseConnectTimeoutSeconds()));
  const sslMode = String(process.env.POSTGRES_SSL || "")
    .trim()
    .toLowerCase();
  if (sslMode === "disable") {
    if (!isExplicitLocalDatabaseUrl(url.toString())) {
      throw new Error(
        "POSTGRES_SSL=disable is allowed only for an explicit local database connection.",
      );
    }
    url.searchParams.set("sslmode", "disable");
  } else {
    if (sslMode && !["require", "verify-full"].includes(sslMode)) {
      throw new Error("POSTGRES_SSL must be unset, require, verify-full, or disable.");
    }
    url.searchParams.set("sslmode", "verify-full");
    const rootCertificatePath = String(
      process.env.PGSSLROOTCERT || process.env.POSTGRES_SSL_CA_FILE || "",
    ).trim();
    if (rootCertificatePath) url.searchParams.set("sslrootcert", rootCertificatePath);
  }
  return url.toString();
}

function resolvePostgresSslOptions(dbUrl) {
  const mode = String(process.env.POSTGRES_SSL || "")
    .trim()
    .toLowerCase();
  if (mode === "disable") {
    if (!isExplicitLocalDatabaseUrl(dbUrl)) {
      throw new Error(
        "POSTGRES_SSL=disable is allowed only for an explicit local database connection.",
      );
    }
    return false;
  }
  if (mode && !["require", "verify-full"].includes(mode)) {
    throw new Error("POSTGRES_SSL must be unset, require, verify-full, or disable.");
  }

  const rootCertificatePath = String(process.env.PGSSLROOTCERT || "").trim();
  const configuredCertificate = String(
    process.env.POSTGRES_SSL_CA || process.env.SUPABASE_DB_SSL_CA || "",
  ).trim();
  const ca = rootCertificatePath
    ? readFileSync(rootCertificatePath, "utf8")
    : configuredCertificate || undefined;

  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

function isExplicitLocalDatabaseUrl(dbUrl) {
  const hostname = new URL(dbUrl).hostname.toLowerCase();
  return ["localhost", "127.0.0.1", "::1"].includes(hostname) || hostname.endsWith(".localhost");
}

function resolvePsqlBin() {
  const candidates = [
    process.env.PSQL_BIN,
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) return candidate;
  }
  return undefined;
}

function isMainModule() {
  return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) await main();

export {
  canonicalMigrationText,
  collectMigrations,
  fileSha256,
  HISTORICAL_CONTENT_DRIFT,
  LEGACY_NO_STATEMENT_MIGRATIONS,
  applyMigrationAtomically,
  splitSqlStatements,
  statementDigestsFromSql,
  statementsSha256,
  stripOuterTransactionWrappers,
  resolvePostgresSslOptions,
  validateMigrationHistory,
  withDatabaseConnectTimeout,
  withMigrationSessionSettings,
};
