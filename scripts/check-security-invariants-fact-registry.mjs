// Invariants du registre des pièces (lot R1 du plan du 11/11/2026, migrations 20261116100000 à 20261116100500 ;
// spécification : docs/equipe/annexes/2026-11-11-registre-des-pieces/03-base-de-donnees-arbitrage.md, section 7).
// Appelé par scripts/check-security-invariants.mjs, qui lui passe ses lectures partagées (migrations déjà lues,
// arborescences de code en cache) : ce module ne lit aucun fichier par lui-même.
//
// 1. fact-registry-tables-closed : les quatre tables du registre sont réservées au serveur en lecture seule
//    (RLS, aucune politique, tout retiré aux rôles de l'API, SELECT seul pour service_role).
// 2. fact-registry-append-only : le journal des décisions et la file d'évènements refusent UPDATE, DELETE et
//    TRUNCATE ; auction_fact_claims refuse TRUNCATE ; aucune migration ne retire ces déclencheurs.
// 3. held-fields-projection-only : auction_sales.held_fields n'est écrite que par la projection et la retenue ;
//    aucun code de l'application ni du pipeline ne la nomme ; aucun droit par colonne ne l'ouvre.
// 4. hold-trigger-present-early : le déclencheur de retenue garde sa forme (BEFORE UPDATE OF, clause WHEN), reste
//    passif et précède tous les autres déclencheurs BEFORE UPDATE de auction_sales (sauf la garde « aaaa_ »).
// 5. field-projection-not-callable-by-api : la projection n'est exécutable par aucun rôle de l'API et aucun code
//    de l'application ni du pipeline ne la nomme.
// 6. fact-claims-never-repointed : une observation n'est jamais rattachée à une autre vente ; sa garde
//    d'immuabilité garde la clause « détacher seulement ».
// 7. registry-no-fk-to-auction-sales : aucune clé étrangère du registre vers auction_sales (verrou sur la table
//    chaude, suppression en cascade qui perdrait l'audit).

export const factRegistryInvariantNames = [
  "fact-registry-tables-closed",
  "fact-registry-append-only",
  "held-fields-projection-only",
  "hold-trigger-present-early",
  "field-projection-not-callable-by-api",
  "fact-claims-never-repointed",
  "registry-no-fk-to-auction-sales",
];

const REGISTRY_TABLES = [
  "auction_fact_fields",
  "auction_fact_source_precedence",
  "auction_fact_claim_decisions",
  "auction_sale_field_hold_events",
];
const HOLD_TRIGGER = "aaab_auction_sales_hold_projected_fields";
const INSERT_GUARD_TRIGGER = "aaab_auction_sales_held_fields_insert_guard";
const RETENTION_GUARD_TRIGGER = "aaaa_auction_sales_retention_tombstone_guard_update";
const HOLD_FUNCTION = "app_private.hold_projected_sale_fields";
const PROJECTION_FUNCTION = "app_private.project_sale_fields";
const HELD_COLUMNS = [
  "surface_m2",
  "app_surface_m2",
  "app_surface_kind",
  "surface_source",
  "surface_confidence",
  "land_surface_m2",
  "rooms_count",
  "bedrooms_count",
  "occupancy_status",
  "visit_dates",
  "held_fields",
];
// Premières migrations du lot : avant elles, les tables, la colonne et les fonctions n'existent pas.
const FACT_CLAIMS_MIGRATION = "20260928140000";
const REGISTRY_MIGRATION = "20261116100000";
const HELD_FIELDS_MIGRATION = "20261116100300";
const PROJECTION_MIGRATION = "20261116100500";

const REGISTRY_OBJECT =
  /auction_fact_|auction_sale_field_hold_events|held_fields|project_sale_fields|hold_projected_sale_fields|fact_registry_append_only/;
const TRIGGER_CREATION = /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s/i;
// Mots qu'aucun code de l'application ni du pipeline ne doit nommer (cherchés avant tout autre traitement).
const FORBIDDEN_IN_CODE = ["held_fields", "project_sale_fields", "app.sale_field_projection"];

const stripSql = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/"([A-Za-z_][A-Za-z0-9_$]*)"/g, "$1");
const stripCode = (text) => text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/g, "");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Définitions `create [or replace] function` d'un fichier : nom qualifié, en-tête, corps, bornes. */
function functionDefinitions(sql) {
  const definitions = [];
  const header =
    /create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)\s*\(/gi;
  const bodyOpening = /\bas\s+(\$[a-z_]*\$)/gi;
  for (const match of sql.matchAll(header)) {
    bodyOpening.lastIndex = match.index;
    const opening = bodyOpening.exec(sql);
    if (!opening) continue;
    const bodyStart = opening.index + opening[0].length;
    const bodyEnd = sql.indexOf(opening[1], bodyStart);
    if (bodyEnd < 0) continue;
    definitions.push({
      name: match[1].toLowerCase(),
      head: sql.slice(match.index, bodyStart),
      body: sql.slice(bodyStart, bodyEnd),
      start: match.index,
      end: bodyEnd + opening[1].length,
    });
  }
  return definitions;
}

/**
 * @param {object} context
 * @param {Map<string, string>} context.migrationSources migrations déjà lues (nom de fichier -> SQL)
 * @param {(url: URL) => Promise<string[]>} context.readSourceTree lecture partagée d'une arborescence de code
 * @param {(url: URL) => Promise<string>} context.readSourceText lecture partagée d'un fichier de code
 * @param {string[]} context.failures liste des échecs du script appelant
 * @param {string} context.baseUrl adresse du script appelant (import.meta.url)
 */
export async function checkFactRegistryInvariants({
  migrationSources,
  readSourceTree,
  readSourceText,
  failures,
  baseUrl,
}) {
  // Seules les migrations qui peuvent toucher le registre sont analysées : celles qui nomment un de ses objets,
  // celles qui créent un déclencheur sur auction_sales (ordre des déclencheurs), et toutes celles qui suivent
  // l'ajout de held_fields (droits donnés en bloc). Les autres (plus de neuf sur dix) ne sont pas relues.
  const all = [];
  for (const [name, source] of migrationSources) {
    if (
      name >= HELD_FIELDS_MIGRATION ||
      REGISTRY_OBJECT.test(source) ||
      (source.includes("auction_sales") && TRIGGER_CREATION.test(source))
    ) {
      all.push([name, stripSql(source)]);
    }
  }
  const allSql = all.map(([, sql]) => sql).join("\n");
  const definitions = all.flatMap(([name, sql]) =>
    functionDefinitions(sql).map((definition) => ({ ...definition, migration: name })),
  );
  const lastDefinition = (name) => definitions.filter((entry) => entry.name === name).at(-1);

  // Un déclencheur protégé n'est ni désactivé, ni renommé, ni supprimé sans être recréé dans la même migration.
  // `since` : première migration qui crée le déclencheur (avant elle, des rattrapages désactivaient les
  // déclencheurs de la table le temps d'une réécriture, quand celui-ci n'existait pas).
  const checkTriggerKept = (trigger, table, invariant, since) => {
    const qualified = `(?:public\\.)?${table}`;
    for (const [name, sql] of all) {
      // Seules les migrations qui nomment la table peuvent toucher un de ses déclencheurs.
      if (name < since || !sql.includes(table)) continue;
      const drop = new RegExp(
        `drop\\s+trigger\\s+(?:if\\s+exists\\s+)?${trigger}\\s+on\\s+${qualified}\\b`,
        "gi",
      );
      for (const match of sql.matchAll(drop)) {
        const recreated = new RegExp(
          `create\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+${trigger}\\b`,
          "i",
        ).test(sql.slice(match.index));
        if (!recreated) {
          failures.push(
            `${name} drops the trigger ${trigger} of public.${table} without recreating it (${invariant})`,
          );
        }
      }
      if (
        new RegExp(
          `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${qualified}\\s+disable\\s+trigger\\s+(?:${trigger}|all|user)\\b`,
          "i",
        ).test(sql)
      ) {
        failures.push(`${name} disables the trigger ${trigger} of public.${table} (${invariant})`);
      }
      if (
        new RegExp(`alter\\s+trigger\\s+${trigger}\\s+on\\s+${qualified}\\s+rename\\b`, "i").test(
          sql,
        )
      ) {
        failures.push(`${name} renames the trigger ${trigger} of public.${table} (${invariant})`);
      }
    }
  };

  // 1. fact-registry-tables-closed ----------------------------------------------------------------------------
  for (const table of REGISTRY_TABLES) {
    const qualified = `public\\.${table}`;
    if (
      !new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${qualified}\\b`, "i").test(
        allSql,
      )
    ) {
      failures.push(`public.${table} is not created by a migration (fact registry)`);
      continue;
    }
    if (
      !new RegExp(`alter\\s+table\\s+${qualified}\\s+enable\\s+row\\s+level\\s+security`, "i").test(
        allSql,
      ) ||
      !new RegExp(
        `revoke\\s+all\\s+on\\s+table\\s+${qualified}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
        "i",
      ).test(allSql)
    ) {
      failures.push(`public.${table} is not closed to the API roles (RLS and revoke all)`);
    }
    for (const [name, sql] of all) {
      if (!sql.includes(table)) continue;
      if (
        new RegExp(
          `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?${table}\\s+disable\\s+row\\s+level\\s+security`,
          "i",
        ).test(sql)
      ) {
        failures.push(`${name} disables row level security on public.${table}`);
      }
      if (new RegExp(`create\\s+policy[^;]*\\b(?:public\\.)?${table}\\b`, "i").test(sql)) {
        failures.push(`${name} opens public.${table} with a policy`);
      }
      for (const statement of sql.split(";")) {
        if (!/^\s*grant\s/i.test(statement) || !new RegExp(`\\b${table}\\b`, "i").test(statement)) {
          continue;
        }
        if (
          !new RegExp(
            `^\\s*grant\\s+select\\s+on\\s+(?:table\\s+)?${qualified}\\s+to\\s+service_role\\s*$`,
            "i",
          ).test(statement)
        ) {
          failures.push(
            `${name} grants on public.${table} something else than SELECT to service_role alone (the fact registry is written only by its functions)`,
          );
        }
      }
    }
  }

  // 2. fact-registry-append-only --------------------------------------------------------------------------------
  const appendOnly = [
    {
      table: "auction_fact_claim_decisions",
      trigger: "auction_fact_claim_decisions_append_only",
      events: "before\\s+update\\s+or\\s+delete",
      scope: "for\\s+each\\s+row",
      fn: "app_private.fact_registry_append_only",
    },
    {
      table: "auction_fact_claim_decisions",
      trigger: "auction_fact_claim_decisions_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.fact_registry_append_only",
    },
    {
      table: "auction_sale_field_hold_events",
      trigger: "auction_sale_field_hold_events_append_only",
      events: "before\\s+update\\s+or\\s+delete",
      scope: "for\\s+each\\s+row",
      fn: "app_private.fact_registry_append_only",
    },
    {
      table: "auction_sale_field_hold_events",
      trigger: "auction_sale_field_hold_events_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.fact_registry_append_only",
    },
    {
      table: "auction_fact_claims",
      trigger: "auction_fact_claims_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.refuse_auction_fact_claims_truncate",
    },
  ];
  for (const guard of appendOnly) {
    const created = [
      ...allSql.matchAll(new RegExp(`create\\s+trigger\\s+${guard.trigger}\\s+([^;]*)`, "gi")),
    ].at(-1);
    if (
      !created ||
      !new RegExp(
        `^${guard.events}\\s+on\\s+public\\.${guard.table}\\s+${guard.scope}\\s+execute\\s+function\\s+${escapeRegExp(guard.fn)}\\(\\)\\s*$`,
        "i",
      ).test(created[1].trim())
    ) {
      failures.push(
        `the append-only trigger ${guard.trigger} of public.${guard.table} is missing or no longer refuses every row and statement`,
      );
    }
    checkTriggerKept(guard.trigger, guard.table, "append-only fact registry", REGISTRY_MIGRATION);
  }
  for (const fn of [
    "app_private.fact_registry_append_only",
    "app_private.refuse_auction_fact_claims_truncate",
  ]) {
    const definition = lastDefinition(fn);
    if (
      !definition ||
      !/raise\s+exception\s+using\s+errcode\s*=\s*'55000'/i.test(definition.body) ||
      /\breturn\b/i.test(definition.body)
    ) {
      failures.push(
        `${definition?.migration ?? "no migration"}: ${fn} no longer refuses every write (it must only raise 55000)`,
      );
    }
  }

  // 3. held-fields-projection-only ------------------------------------------------------------------------------
  const allowedWriters = new Set([PROJECTION_FUNCTION, HOLD_FUNCTION]);
  for (const [name, sql] of all) {
    if (name < HELD_FIELDS_MIGRATION && !sql.includes("held_fields")) continue;
    const inFile = definitions.filter((entry) => entry.migration === name);
    for (const match of sql.matchAll(/\bheld_fields\s*(?::=|=(?!=))/gi)) {
      const owner = inFile.find((entry) => match.index >= entry.start && match.index < entry.end);
      if (!owner || !allowedWriters.has(owner.name)) {
        failures.push(
          `${name} writes auction_sales.held_fields ${owner ? `in ${owner.name}` : "outside a function"}: only ${PROJECTION_FUNCTION} and ${HOLD_FUNCTION} may`,
        );
      }
    }
    for (const match of sql.matchAll(
      /insert\s+into\s+(?:public\.)?auction_sales\s*(?:as\s+[a-z_]+\s*)?\(([^)]*)\)/gi,
    )) {
      if (/\bheld_fields\b/i.test(match[1])) {
        failures.push(`${name} inserts auction_sales.held_fields: a new sale holds no field`);
      }
    }
    if (
      /grant\s[^;]*\([^)]*\bheld_fields\b[^)]*\)\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\b/i.test(
        sql,
      )
    ) {
      failures.push(`${name} grants a column privilege on auction_sales.held_fields`);
    }
    if (
      name >= HELD_FIELDS_MIGRATION &&
      /grant\s+(?:select|all)(?:\s+privileges)?\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\s+to\s+[^;]*\b(?:anon|authenticated|public)\b/i.test(
        sql,
      )
    ) {
      failures.push(
        `${name} grants a table-wide read of auction_sales to a browser role (it would expose held_fields)`,
      );
    }
  }
  if (
    !/alter\s+table\s+public\.auction_sales\s+add\s+column\s+if\s+not\s+exists\s+held_fields\s+jsonb\s*;/i.test(
      allSql,
    )
  ) {
    failures.push(
      "auction_sales.held_fields is not added as a nullable jsonb column without default",
    );
  }

  // 4. hold-trigger-present-early -------------------------------------------------------------------------------
  const holdTrigger = [
    ...allSql.matchAll(new RegExp(`create\\s+trigger\\s+${HOLD_TRIGGER}\\s+([^;]*)`, "gi")),
  ].at(-1);
  const holdShape =
    /^before\s+update\s+of\s+([a-z0-9_,\s]+?)\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*old\.held_fields\s+is\s+not\s+null\s+or\s+new\.held_fields\s+is\s+distinct\s+from\s+old\.held_fields\s*\)\s+execute\s+function\s+app_private\.hold_projected_sale_fields\(\)\s*$/i.exec(
      holdTrigger?.[1].trim() ?? "",
    );
  if (!holdShape) {
    failures.push(
      `the hold trigger ${HOLD_TRIGGER} is missing or lost its shape (before update of the held columns, with its WHEN clause)`,
    );
  } else {
    const columns = holdShape[1].split(",").map((column) => column.trim().toLowerCase());
    for (const column of HELD_COLUMNS) {
      if (!columns.includes(column)) {
        failures.push(`the hold trigger ${HOLD_TRIGGER} no longer fires on a write of ${column}`);
      }
    }
  }
  const insertGuard = [
    ...allSql.matchAll(new RegExp(`create\\s+trigger\\s+${INSERT_GUARD_TRIGGER}\\s+([^;]*)`, "gi")),
  ].at(-1);
  if (
    !/^before\s+insert\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*new\.held_fields\s+is\s+not\s+null\s*\)\s+execute\s+function\s+app_private\.refuse_inserted_held_fields\(\)\s*$/i.test(
      insertGuard?.[1].trim() ?? "",
    )
  ) {
    failures.push(`the insert guard ${INSERT_GUARD_TRIGGER} is missing or lost its shape`);
  }
  checkTriggerKept(HOLD_TRIGGER, "auction_sales", "hold of projected fields", PROJECTION_MIGRATION);
  checkTriggerKept(
    INSERT_GUARD_TRIGGER,
    "auction_sales",
    "hold of projected fields",
    PROJECTION_MIGRATION,
  );
  for (const [name, sql] of all) {
    for (const match of sql.matchAll(
      /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+([a-z0-9_]+)\s+before\s+([^;]*?)\s+on\s+(?:public\.)?auction_sales\b/gi,
    )) {
      const trigger = match[1].toLowerCase();
      if (!/\bupdate\b/i.test(match[2])) continue;
      if (trigger < HOLD_TRIGGER && trigger !== RETENTION_GUARD_TRIGGER) {
        failures.push(
          `${name} creates the BEFORE UPDATE trigger ${trigger} on auction_sales, which runs before ${HOLD_TRIGGER}: it would judge values that the hold then restores`,
        );
      }
    }
  }
  const holdFunction = lastDefinition(HOLD_FUNCTION);
  if (!holdFunction) {
    failures.push(`${HOLD_FUNCTION} is not defined by a migration`);
  } else {
    const passive = [
      [
        /to_jsonb\s*\(\s*(?:new|old)\s*\)/i,
        "converts the whole row (to_jsonb(new) or to_jsonb(old))",
      ],
      [/\braw_payload\b/i, "reads raw_payload"],
      [
        /\bauction_fact_claims\b|\bauction_fact_claim_decisions\b|\bauction_fact_source_precedence\b/i,
        "reads the claims, the decisions or the precedence",
      ],
      [/\bproject_sale_fields\s*\(/i, "calls the projection"],
    ];
    for (const [pattern, reason] of passive) {
      if (pattern.test(holdFunction.body)) {
        failures.push(
          `${holdFunction.migration}: ${HOLD_FUNCTION} ${reason}: the hold trigger must stay passive`,
        );
      }
    }
    if (
      !/raise\s+exception\s+using\s+errcode\s*=\s*'42501'/i.test(holdFunction.body) ||
      !/new\.held_fields\s+is\s+distinct\s+from\s+old\.held_fields/i.test(holdFunction.body)
    ) {
      failures.push(
        `${holdFunction.migration}: ${HOLD_FUNCTION} no longer refuses (42501) a write of held_fields outside the projection`,
      );
    }
  }

  // 5. field-projection-not-callable-by-api ---------------------------------------------------------------------
  const projection = lastDefinition(PROJECTION_FUNCTION);
  if (!projection) {
    failures.push(`${PROJECTION_FUNCTION} is not defined by a migration`);
  } else if (
    !/security\s+definer/i.test(projection.head) ||
    !/set\s+search_path\s*=\s*''/i.test(projection.head)
  ) {
    failures.push(
      `${projection.migration}: ${PROJECTION_FUNCTION} is not SECURITY DEFINER with an empty search_path`,
    );
  }
  for (const fn of [PROJECTION_FUNCTION, HOLD_FUNCTION]) {
    const signature = `${escapeRegExp(fn)}\\([^)]*\\)`;
    if (
      !new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+${signature}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`,
        "i",
      ).test(allSql)
    ) {
      failures.push(`${fn} is not revoked from public, anon, authenticated and service_role`);
    }
    for (const [name, sql] of all) {
      if (
        new RegExp(`grant\\s[^;]*\\bon\\s+function\\s+[^;]*\\b${escapeRegExp(fn)}\\b`, "i").test(
          sql,
        )
      ) {
        failures.push(`${name} grants a privilege on ${fn}: no API role may execute it`);
      }
    }
  }
  for (const [name, sql] of all) {
    if (
      name >= PROJECTION_MIGRATION &&
      /grant\s+(?:execute|all)(?:\s+privileges)?\s+on\s+all\s+(?:functions|routines)\s+in\s+schema\s+[^;]*\bapp_private\b/i.test(
        sql,
      )
    ) {
      failures.push(
        `${name} grants every function of app_private at once: it would open ${PROJECTION_FUNCTION}`,
      );
    }
  }

  // 3 et 5, côté code : ni l'application ni le pipeline ne nomment la colonne, la projection ou son marqueur.
  const codeRoots = [
    { url: "../src/", path: "src/" },
    { url: "../services/data-pipeline/src/", path: "services/data-pipeline/src/" },
  ];
  const forbiddenInCode = [
    [
      /\bheld_fields\b/,
      "names auction_sales.held_fields (written and read by the database only at this stage)",
    ],
    [
      /\bproject_sale_fields\b/,
      `names ${PROJECTION_FUNCTION} (no application or pipeline code calls the projection)`,
    ],
    [/app\.sale_field_projection/, "names the transaction marker of the projection"],
  ];
  for (const root of codeRoots) {
    let entries;
    try {
      entries = await readSourceTree(new URL(root.url, baseUrl));
    } catch (error) {
      failures.push(
        `${root.path} cannot be read to check the fact registry (${error.code ?? "error"})`,
      );
      continue;
    }
    for (const entry of entries) {
      const name = String(entry);
      if (!/\.(?:ts|tsx|mjs|cjs|js|py)$/.test(name)) continue;
      if (/\.test\.[cm]?[jt]sx?$/.test(name) || /(?:^|\/)test_[^/]*\.py$/.test(name)) continue;
      const relative = `${root.path}${name}`;
      // Types générés depuis le schéma : la colonne y figure forcément.
      if (relative === "src/integrations/supabase/types.ts") continue;
      const raw = await readSourceText(new URL(`${root.url}${name}`, baseUrl));
      // Presque aucun fichier ne contient ces mots : les commentaires ne sont retirés que pour ceux-là.
      if (!FORBIDDEN_IN_CODE.some((word) => raw.includes(word))) continue;
      const source = stripCode(raw);
      for (const [pattern, reason] of forbiddenInCode) {
        if (pattern.test(source)) failures.push(`${relative} ${reason}`);
      }
    }
  }

  // 6. fact-claims-never-repointed ------------------------------------------------------------------------------
  for (const [name, sql] of all) {
    if (!sql.includes("auction_fact_claims")) continue;
    for (const statement of sql.split(";")) {
      const update = /\bupdate\s+(?:only\s+)?(?:public\.)?auction_fact_claims\b([\s\S]*)$/i.exec(
        statement,
      );
      if (!update) continue;
      for (const assignment of update[1].matchAll(/\bauction_sale_id\s*=\s*([^\s,;)]+)/gi)) {
        const before = update[1].slice(0, assignment.index);
        // Une affectation est dans la clause SET, avant le WHERE ou le FROM de l'instruction.
        if (
          !/\bset\b/i.test(before) ||
          /\b(?:where|from)\b/i.test(before.split(/\bset\b/i).at(-1))
        ) {
          continue;
        }
        if (!/^null$/i.test(assignment[1])) {
          failures.push(
            `${name} re-points a fact claim to another sale (auction_fact_claims.auction_sale_id = ${assignment[1]}): a claim is only ever detached`,
          );
        }
      }
    }
  }
  const guards = definitions.filter(
    (entry) => entry.name === "app_private.guard_auction_fact_claim_mutation",
  );
  if (!guards.length) {
    failures.push("app_private.guard_auction_fact_claim_mutation is not defined by a migration");
  }
  for (const guard of guards) {
    if (
      !/old\.auction_sale_id\s+is\s+not\s+null\s+and\s+new\.auction_sale_id\s+is\s+null/i.test(
        guard.body,
      ) ||
      !/Fact claim observations and provenance are immutable\./.test(guard.body)
    ) {
      failures.push(
        `${guard.migration} redefines app_private.guard_auction_fact_claim_mutation without its detach-only clause`,
      );
    }
  }
  checkTriggerKept(
    "auction_fact_claims_guard_mutation",
    "auction_fact_claims",
    "immutable fact claims",
    FACT_CLAIMS_MIGRATION,
  );

  // 7. registry-no-fk-to-auction-sales --------------------------------------------------------------------------
  for (const table of REGISTRY_TABLES) {
    for (const [name, sql] of all) {
      if (!sql.includes(table)) continue;
      for (const statement of sql.split(";")) {
        if (
          !new RegExp(
            `^\\s*(?:create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?|alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?)(?:public\\.)?${table}\\b`,
            "i",
          ).test(statement)
        ) {
          continue;
        }
        if (/\breferences\s+(?:public\.)?auction_sales\b/i.test(statement)) {
          failures.push(
            `${name} gives public.${table} a foreign key to auction_sales (lock on the hot table, and a cascade would lose the audit trail)`,
          );
        }
      }
    }
  }
}
