import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  applyMigrationAtomically,
  HISTORICAL_CONTENT_DRIFT,
  LEGACY_NO_STATEMENT_MIGRATIONS,
  canonicalMigrationText,
  collectMigrations,
  splitSqlStatements,
  statementDigestsFromSql,
  statementsSha256,
  stripOuterTransactionWrappers,
  resolvePostgresSslOptions,
  validateMigrationHistory,
  withDatabaseConnectTimeout,
  withMigrationSessionSettings,
} from "./apply-supabase-migrations.mjs";

function withEnvironment(values, callback) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function localMigration(version, name, source) {
  const canonical = canonicalMigrationText(source);
  const withoutTransactionWrappers = canonical
    .replace(/^begin;\s*/i, "")
    .replace(/\s*commit;\s*$/i, "")
    .trimEnd();
  return {
    file: `${version}_${name}.sql`,
    path: `/tmp/${version}_${name}.sql`,
    version,
    name,
    contentSha256: createHash("sha256").update(canonical).digest("hex"),
    contentSha256Candidates: [canonical, withoutTransactionWrappers]
      .filter((value, index, values) => values.indexOf(value) === index)
      .map((value) => createHash("sha256").update(value).digest("hex")),
    statementDigests: statementDigestsFromSql(source),
  };
}

function remoteMigration(version, name, source) {
  return {
    version,
    name,
    statementDigests: [createHash("sha256").update(canonicalMigrationText(source)).digest("hex")],
  };
}

describe("Supabase migration history integrity", () => {
  const version = "20261008120000";
  const source = "create table public.release_fixture (id uuid primary key);\n";

  it("accepts a matching version, name, and canonicalized content", () => {
    const local = [localMigration(version, "release_fixture", source)];
    const remote = [remoteMigration(version, "release_fixture", source.replaceAll("\n", "\r\n"))];

    expect(validateMigrationHistory(local, remote)).toEqual([]);
  });

  it("rejects a renamed migration even when its SQL is unchanged", () => {
    const local = [localMigration(version, "release_fixture", source)];
    const remote = [remoteMigration(version, "different_name", source)];

    expect(validateMigrationHistory(local, remote)).toEqual([
      expect.stringContaining("name differs"),
    ]);
  });

  it("rejects changed SQL under an already-applied version", () => {
    const local = [localMigration(version, "release_fixture", source)];
    const remote = [
      remoteMigration(version, "release_fixture", "drop table public.release_fixture;\n"),
    ];

    expect(validateMigrationHistory(local, remote)).toEqual([
      expect.stringContaining("content digest differs"),
    ]);
  });

  it("rejects an applied migration that has no verifiable content digest", () => {
    const local = [localMigration(version, "release_fixture", source)];
    const remote = [{ version, name: "release_fixture", statementDigests: null }];

    expect(validateMigrationHistory(local, remote)).toEqual([
      expect.stringContaining("fixed legacy baseline"),
    ]);
  });

  it("does not treat an empty remote statements array as verified content", () => {
    const local = [localMigration(version, "release_fixture", source)];
    const remote = [{ version, name: "release_fixture", statementDigests: [] }];

    expect(validateMigrationHistory(local, remote)).toEqual([
      expect.stringContaining("fixed legacy baseline"),
    ]);
  });

  it("rejects remote history entries that are absent locally", () => {
    const remote = [remoteMigration(version, "release_fixture", source)];

    expect(validateMigrationHistory([], remote)).toEqual([
      expect.stringContaining("missing from the local migration directory"),
    ]);
  });

  it("rejects duplicate remote versions instead of choosing one silently", () => {
    const local = [localMigration(version, "release_fixture", source)];
    const remote = [
      remoteMigration(version, "release_fixture", source),
      remoteMigration(version, "release_fixture", source),
    ];

    expect(validateMigrationHistory(local, remote)).toEqual([
      expect.stringContaining("duplicate version"),
    ]);
  });

  it("compares multi-statement migrations by ordered statement digests", () => {
    const multiStatementSource = `begin;
create table public.release_fixture_multi (id integer);
comment on table public.release_fixture_multi is $$contains ; inside text$$;
commit;
`;
    const local = [localMigration(version, "release_fixture", multiStatementSource)];
    const statements = splitSqlStatements(multiStatementSource);

    expect(statements).toHaveLength(4);
    expect(
      validateMigrationHistory(local, [
        {
          version,
          name: "release_fixture",
          statementDigests: statementsSha256(statements),
        },
      ]),
    ).toEqual([]);
  });

  it("distinguishes standard strings from E strings when splitting backslashes", () => {
    const standard = "select 'path\\'; select 2;";
    const escaped = "select E'path\\'; select 2;";

    expect(splitSqlStatements(standard)).toEqual(["select 'path\\'", "select 2"]);
    expect(splitSqlStatements(escaped)).toEqual(["select E'path\\'; select 2;"]);
  });

  it("accepts a one-element digest with only the outer transaction wrappers canonicalized", () => {
    const wrappedSource = `begin;

create table public.release_fixture_wrapped (id integer);

commit;
`;
    const local = [localMigration(version, "release_fixture", wrappedSource)];
    const unwrapped = wrappedSource
      .replace(/^begin;\s*/i, "")
      .replace(/\s*commit;\s*$/i, "")
      .trimEnd();

    expect(
      validateMigrationHistory(local, [
        {
          version,
          name: "release_fixture",
          statementDigests: [createHash("sha256").update(unwrapped).digest("hex")],
        },
      ]),
    ).toEqual([]);
  });

  it("allows only the eight fixed historical no-content baselines", () => {
    const localByVersion = new Map(
      collectMigrations().map((migration) => [migration.version, migration]),
    );

    for (const [version, baseline] of Object.entries(LEGACY_NO_STATEMENT_MIGRATIONS)) {
      const local = localByVersion.get(version);
      expect(local?.name).toBe(baseline.name);
      expect(local?.contentSha256).toBe(baseline.localContentSha256);
      expect(
        validateMigrationHistory(
          [local],
          [{ version, name: baseline.name, statementDigests: null }],
        ),
      ).toEqual([]);
    }
  });

  it("anchors all sixteen exact historical content reconciliations", () => {
    const localByVersion = new Map(
      collectMigrations().map((migration) => [migration.version, migration]),
    );

    for (const [version, baseline] of Object.entries(HISTORICAL_CONTENT_DRIFT)) {
      const local = localByVersion.get(version);
      expect(local?.name).toBe(baseline.name);
      expect(local?.contentSha256).toBe(baseline.localContentSha256);
      expect(baseline.reason).toBeTruthy();
      expect(baseline.review).toBeTruthy();
      expect(["semantic", "formatting"]).toContain(baseline.category);
      const issues = validateMigrationHistory(
        [local],
        [{ version, name: baseline.name, statementDigests: [baseline.remoteStatementSha256] }],
      );
      expect(issues).toEqual([]);
    }
  });

  it("rejects a historical reconciliation when either anchored digest changes", () => {
    const [version, baseline] = Object.entries(HISTORICAL_CONTENT_DRIFT)[0];
    const local = localMigration(version, baseline.name, "changed historical SQL;\n");

    expect(
      validateMigrationHistory(
        [local],
        [{ version, name: baseline.name, statementDigests: [baseline.remoteStatementSha256] }],
      ),
    ).toEqual([expect.stringContaining("content digest differs")]);
    expect(
      validateMigrationHistory(
        [localMigration(version, baseline.name, "changed historical SQL;\n")],
        [{ version, name: baseline.name, statementDigests: ["0".repeat(64)] }],
      ),
    ).toEqual([expect.stringContaining("content digest differs")]);
  });

  it("rejects a changed local file under a fixed historical no-content version", () => {
    const [version, baseline] = Object.entries(LEGACY_NO_STATEMENT_MIGRATIONS)[0];
    const local = localMigration(version, baseline.name, "changed historical SQL;\n");

    expect(
      validateMigrationHistory([local], [{ version, name: baseline.name, statementDigests: null }]),
    ).toEqual([expect.stringContaining("fixed legacy baseline")]);
  });

  it("rejects malformed remote statement digest arrays", () => {
    const local = [localMigration(version, "release_fixture", source)];

    expect(
      validateMigrationHistory(
        [local[0]],
        [{ version, name: "release_fixture", statementDigests: ["not-a-sha256"] }],
      ),
    ).toEqual([expect.stringContaining("malformed remote statement digests")]);
  });

  it("strips only safe outer transaction wrappers for atomic execution", () => {
    expect(stripOuterTransactionWrappers("\nBEGIN;\nselect 1;\nCOMMIT;\n")).toBe("\nselect 1;\n");
    expect(stripOuterTransactionWrappers("select 1;\n")).toBe("select 1;\n");
    expect(
      stripOuterTransactionWrappers("begin;\nselect 1;\ncommit;\nnotify pgrst, 'reload schema';\n"),
    ).toBe("\nselect 1;\nnotify pgrst, 'reload schema';\n");
    expect(() =>
      stripOuterTransactionWrappers("begin;\ncreate index concurrently ix on t (id);\ncommit;"),
    ).toThrow("CONCURRENTLY");
    expect(() => stripOuterTransactionWrappers("begin;\nselect 1;\ncommit;\nselect 2;")).toThrow(
      "executable statements follow COMMIT",
    );
  });

  it("ignores concurrent-index words in comments and quoted SQL while scanning for DDL", () => {
    const source = `begin;
-- create index concurrently comment_only on public.example (id);
select 'create index concurrently string_only on public.example (id)';
select E'escaped \\'create index concurrently\\'';
select $$create index concurrently dollar_quoted$$;
select "create index concurrently identifier";
commit;
`;

    expect(stripOuterTransactionWrappers(source)).toContain("string_only");
  });

  it("bounds repeated SQL comments before and after the trailing notification", () => {
    const moduleUrl = new URL("./apply-supabase-migrations.mjs", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { stripOuterTransactionWrappers } from ${JSON.stringify(moduleUrl)};
        for (const prefix of ["", "notify\\tpgrst, 'reload schema';"]) {
          const suffix = prefix + "/*" + "*//*".repeat(40) + "*/select 2;";
          let rejected = false;
          try { stripOuterTransactionWrappers("begin;select 1;commit;" + suffix); }
          catch (error) { rejected = error.message.includes("executable statements follow COMMIT"); }
          if (!rejected) process.exit(1);
        }
      `,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  }, 15000);

  it("keeps quoted COMMIT text and commented notification payloads intact", () => {
    const body = "\nselect 'commit;';\ndo $$begin perform 1; end$$;";
    const suffix = "\n/* outer /* nested */ comment */ notify pgrst, 'reload; schema'; -- done\n";
    expect(stripOuterTransactionWrappers(`begin;${body}\ncommit;${suffix}`)).toBe(body + suffix);
  });

  it.each(["é", "漢字", "𐐀", "tagé_1"])(
    "preserves transaction boundaries around a non-ASCII dollar tag: %s",
    (tag) => {
      const body = `\nselect $${tag}$\ncommit;\n$x$\n$${tag}$;`;
      const source = `begin;${body}\ncommit;`;
      expect(stripOuterTransactionWrappers(source)).toBe(body);
      expect(splitSqlStatements(source)).toEqual(["begin", body.trim().slice(0, -1), "commit"]);
      expect(() => stripOuterTransactionWrappers(source + "\nselect 2;")).toThrow(
        "executable statements follow COMMIT",
      );
    },
  );

  it("does not read dollar signs within SQL identifiers as string delimiters", () => {
    const body = "\nselect 1 as é$tag$;\nselect 2 as identifier$tag$;";
    const source = `begin;${body}\ncommit;`;
    expect(stripOuterTransactionWrappers(source)).toBe(body);
    expect(splitSqlStatements(source)).toHaveLength(4);
    expect(() => stripOuterTransactionWrappers(source + "\nselect 3;")).toThrow(
      "executable statements follow COMMIT",
    );
  });

  it("accepts the migration whose allowlisted concurrent-index SQL is stored as data", () => {
    const migration = collectMigrations().find(
      ({ file }) => file === "20261008121940_hot_identity_and_collection_lookup_indexes.sql",
    );

    expect(migration).toBeDefined();
    expect(() => stripOuterTransactionWrappers(readFileSync(migration.path, "utf8"))).not.toThrow();
  });

  it("scans every checked-in migration without a comment or string false positive", () => {
    const failures = [];
    for (const migration of collectMigrations()) {
      try {
        stripOuterTransactionWrappers(readFileSync(migration.path, "utf8"));
      } catch (error) {
        failures.push({ file: migration.file, message: error.message });
      }
    }

    expect(failures).toEqual([]);
  });

  it("still rejects executable concurrent-index DDL with comments between tokens", () => {
    expect(() =>
      stripOuterTransactionWrappers(
        "begin;\ncreate /* keep writes available */ index concurrently ix on t (id);\ncommit;",
      ),
    ).toThrow("CONCURRENTLY");
    expect(() =>
      stripOuterTransactionWrappers("begin;\ndrop /* comment */ index concurrently ix;\ncommit;"),
    ).toThrow("CONCURRENTLY");
  });

  it("uses verified TLS and session-mode URLs for both migration runners", () => {
    withEnvironment(
      {
        POSTGRES_SSL: undefined,
        PGSSLROOTCERT: undefined,
        POSTGRES_SSL_CA: undefined,
        SUPABASE_DB_SSL_CA: undefined,
      },
      () => {
        const poolerUrl =
          "postgres://user:password@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";
        expect(new URL(withMigrationSessionSettings(poolerUrl)).port).toBe("5432");
        expect(new URL(withDatabaseConnectTimeout(poolerUrl)).searchParams.get("sslmode")).toBe(
          "verify-full",
        );
        expect(resolvePostgresSslOptions(poolerUrl)).toEqual({ rejectUnauthorized: true });
      },
    );
  });

  it("allows disabled TLS only for explicit local migration connections", () => {
    withEnvironment({ POSTGRES_SSL: "disable", IMMOJUDIS_LOCAL_INTEGRATION: undefined }, () => {
      const localUrl = "postgres://user:password@127.0.0.1:5432/postgres";
      expect(resolvePostgresSslOptions(localUrl)).toBe(false);
      expect(new URL(withDatabaseConnectTimeout(localUrl)).searchParams.get("sslmode")).toBe(
        "disable",
      );
      expect(() =>
        resolvePostgresSslOptions("postgres://user:password@db.example:5432/postgres"),
      ).toThrow("explicit local");
    });
  });

  it("accepts the dedicated CA environment without exposing its contents", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
    withEnvironment(
      { POSTGRES_SSL: undefined, PGSSLROOTCERT: undefined, POSTGRES_SSL_CA: ca },
      () => {
        expect(
          resolvePostgresSslOptions("postgres://user:password@db.example:5432/postgres"),
        ).toEqual({ rejectUnauthorized: true, ca });
      },
    );
  });

  it("sends SQL and the schema history record as one command", async () => {
    const migration = collectMigrations()[0];
    const commands = [];
    await applyMigrationAtomically(
      {
        command: async (statement) => commands.push(statement),
      },
      migration,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^\s*begin;/i);
    expect(commands[0]).toContain("insert into supabase_migrations.schema_migrations");
    expect(commands[0]).toMatch(/commit;\s*$/i);
  });

  it("requests rollback when the atomic command fails", async () => {
    const migration = collectMigrations()[0];
    const commands = [];
    const runner = {
      command: async (statement) => {
        commands.push(statement);
        if (commands.length === 1) throw new Error("division by zero");
      },
    };

    await expect(applyMigrationAtomically(runner, migration)).rejects.toThrow("division by zero");
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe("rollback;");
  });
});
