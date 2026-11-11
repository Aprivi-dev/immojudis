// Invariants du registre des pièces (lot R1 du plan du 11/11/2026, migrations 20261116100000 à 20261116100500 ;
// spécification : docs/equipe/annexes/2026-11-11-registre-des-pieces/03-base-de-donnees-arbitrage.md, section 7).
// Appelé par scripts/check-security-invariants.mjs, qui lui passe ses lectures partagées (migrations déjà lues,
// arborescences de code en cache) : ce module ne lit aucun fichier par lui-même.
//
// 1. fact-registry-tables-closed : les quatre tables du registre sont réservées au serveur en lecture seule
//    (RLS, aucune politique, tout retiré aux rôles de l'API, SELECT seul pour service_role).
// 2. fact-registry-append-only : le journal des décisions et la file d'évènements refusent UPDATE, DELETE et
//    TRUNCATE ; auction_fact_claims refuse TRUNCATE ; aucune migration ne retire ni ne coupe ces déclencheurs
//    (« enable always »), ne passe en session_replication_role, ni n'insère une décision hors d'une fonction.
// 3. held-fields-projection-only : auction_sales.held_fields n'est écrite que par la projection et la retenue ;
//    aucun code de l'application, du pipeline, des scripts ni des fonctions Edge ne la nomme ; aucun droit par
//    colonne ne l'ouvre ; le marqueur de transaction de la projection n'est nommé que par ces deux fonctions.
// 4. hold-trigger-present-early : le déclencheur de retenue garde sa forme (BEFORE UPDATE OF, clause WHEN), reste
//    passif et précède tous les autres déclencheurs BEFORE UPDATE de auction_sales (sauf la garde « aaaa_ » et
//    la garde par rôle de held_fields).
// 5. field-projection-not-callable-by-api : la projection n'est exécutable par aucun rôle de l'API et aucun code
//    ne la nomme.
// 6. fact-claims-never-repointed : une observation n'est jamais rattachée à une autre vente ; sa garde
//    d'immuabilité garde la clause « détacher seulement ».
// 7. registry-no-fk-to-auction-sales : aucune clé étrangère du registre vers auction_sales (verrou sur la table
//    chaude, suppression en cascade qui perdrait l'audit).
//
// Échec fermé : le code est cherché tel quel (un mot interdit dans un commentaire ou dans une adresse échoue
// aussi) ; le SQL n'est débarrassé que de ses vrais commentaires (une chaîne '--' n'en ouvre pas un) ; les
// droits sont cherchés partout, y compris dans un bloc DO ou dans le texte d'un EXECUTE.

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
const JOURNALS = ["auction_fact_claim_decisions", "auction_sale_field_hold_events"];
const HOLD_TRIGGER = "aaab_auction_sales_hold_projected_fields";
const INSERT_GUARD_TRIGGER = "aaab_auction_sales_held_fields_insert_guard";
const ROLE_GUARD_TRIGGER = "aaab_auction_sales_held_fields_role_guard";
const RETENTION_GUARD_TRIGGER = "aaaa_auction_sales_retention_tombstone_guard_update";
const HOLD_FUNCTION = "app_private.hold_projected_sale_fields";
const PROJECTION_FUNCTION = "app_private.project_sale_fields";
const PROJECTION_MARKER = "app.sale_field_projection";
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
// Les rattrapages (supabase/repairs/) sont analysés comme des migrations postérieures au lot, sauf ceux qui
// existaient avant lui, nommés ici un par un (l'un d'eux coupe puis rétablit les déclencheurs de auction_sales :
// il ne doit plus être rejoué tel quel, il laisserait les déclencheurs du registre hors du mode « always »).
const REPAIRS_PREFIX = "repairs/";
const HISTORICAL_REPAIRS = new Set([
  "20261020130001_repair_sale_department_and_coordinates.sql",
  "20261020130002_clear_info_encheres_phantom_point.sql",
  "20261020130003_quarantine_licitor_multi_lot_annonces.sql",
  "20261025100001_repair_doubled_tribunal_names.sql",
  "20261029100200_recompute_past_quarantined_deadlines.sql",
  "20261029110000_backfill_account_email_identity.sql",
  "20261030100001_count_workspace_status_not_in_dossier.sql",
  "20261101110100_clear_points_outside_their_department.sql",
  "20261108202100_delete_empty_listings.sql",
]);

const REGISTRY_OBJECT =
  /auction_fact_|auction_sale_field_hold_events|held_fields|project_sale_fields|hold_projected_sale_fields|fact_registry_append_only|sale_field_projection/;
const TRIGGER_CREATION = /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s/i;
const CREATE_TRIGGER = "create\\s+(?:or\\s+replace\\s+)?trigger";
// Mots qu'aucun code ne doit nommer, cherchés tels quels (commentaires et chaînes compris).
const FORBIDDEN_IN_CODE = [
  [
    "held_fields",
    "names auction_sales.held_fields (written and read by the database only at this stage)",
  ],
  [
    "project_sale_fields",
    `names ${PROJECTION_FUNCTION} (no application, pipeline or script code calls the projection)`,
  ],
  [PROJECTION_MARKER, "names the transaction marker of the projection"],
];
// Fichiers qui nomment ces mots par nature : les types générés depuis le schéma, et ces invariants.
const CODE_EXEMPTIONS = new Set([
  "src/integrations/supabase/types.ts",
  "scripts/check-security-invariants.mjs",
  "scripts/check-security-invariants-fact-registry.mjs",
  "scripts/check-security-invariants.test.mjs",
  "scripts/check-security-invariants-fact-registry.test.mjs",
]);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Retire les commentaires SQL, et eux seuls : une chaîne entre apostrophes est gardée telle quelle (« '--' »
 * n'ouvre pas un commentaire), un corps entre dollars est du code dont on retire aussi les commentaires, et sa
 * fin est cherchée par sa balise (un « -- » dans une chaîne dynamique ne cache pas ce qui suit la balise).
 */
function stripSqlComments(text) {
  const token = /'|--|\/\*|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/g;
  let out = "";
  let index = 0;
  while (index < text.length) {
    token.lastIndex = index;
    const match = token.exec(text);
    if (!match) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, match.index);
    if (match[0] === "'") {
      // E'...' : la barre oblique inverse protège le caractère suivant.
      const escaped = /(?:^|[^A-Za-z0-9_])[eE]$/.test(
        text.slice(Math.max(0, match.index - 2), match.index),
      );
      let end = match.index + 1;
      while (end < text.length) {
        if (escaped && text[end] === "\\") end += 2;
        else if (text[end] !== "'") end += 1;
        else if (text[end + 1] === "'") end += 2;
        else break;
      }
      end = Math.min(end + 1, text.length);
      out += text.slice(match.index, end);
      index = end;
    } else if (match[0] === "--") {
      const end = text.indexOf("\n", match.index);
      index = end < 0 ? text.length : end;
    } else if (match[0] === "/*") {
      let depth = 1;
      let end = match.index + 2;
      while (end < text.length && depth > 0) {
        if (text.startsWith("/*", end)) {
          depth += 1;
          end += 2;
        } else if (text.startsWith("*/", end)) {
          depth -= 1;
          end += 2;
        } else {
          end += 1;
        }
      }
      out += " ";
      index = end;
    } else {
      const bodyStart = match.index + match[0].length;
      const close = text.indexOf(match[0], bodyStart);
      if (close < 0) {
        // Corps non fermé : tout est gardé (rien n'est caché).
        out += text.slice(match.index);
        break;
      }
      out += match[0] + stripSqlComments(text.slice(bodyStart, close)) + match[0];
      index = close + match[0].length;
    }
  }
  return out;
}

const stripSql = (text) => stripSqlComments(text).replace(/"([A-Za-z_][A-Za-z0-9_$]*)"/g, "$1");

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
 * @param {(url: URL) => Promise<string[]>} context.readSourceTree lecture partagée d'une arborescence
 * @param {(url: URL) => Promise<string>} context.readSourceText lecture partagée d'un fichier
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
  // le début du lot (droits donnés en bloc, mode replica). Les autres (plus de neuf sur dix) ne sont pas relues.
  const all = [];
  for (const [name, source] of migrationSources) {
    if (
      name >= REGISTRY_MIGRATION ||
      REGISTRY_OBJECT.test(source) ||
      (source.includes("auction_sales") && TRIGGER_CREATION.test(source))
    ) {
      all.push([name, stripSql(source)]);
    }
  }
  // Rattrapages : tous lus (ils s'appliquent à la main, hors de l'ordre des migrations).
  try {
    const repairsUrl = new URL("../supabase/repairs/", baseUrl);
    const repairs = (await readSourceTree(repairsUrl))
      .map(String)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of repairs) {
      all.push([
        `${REPAIRS_PREFIX}${name}`,
        stripSql(await readSourceText(new URL(name, repairsUrl))),
      ]);
    }
  } catch (error) {
    failures.push(
      `supabase/repairs/ cannot be read to check the fact registry (${error.code ?? "error"})`,
    );
  }
  const sinceLot = (name, since) =>
    name.startsWith(REPAIRS_PREFIX)
      ? !HISTORICAL_REPAIRS.has(name.slice(REPAIRS_PREFIX.length))
      : name >= since;
  const allSql = all.map(([, sql]) => sql).join("\n");
  const definitions = all.flatMap(([name, sql]) =>
    functionDefinitions(sql).map((definition) => ({ ...definition, migration: name })),
  );
  const lastDefinition = (name) => definitions.filter((entry) => entry.name === name).at(-1);
  const lastStatement = (pattern) => [...allSql.matchAll(new RegExp(pattern, "gi"))].at(-1);

  // Un déclencheur protégé n'est ni désactivé, ni renommé, ni supprimé sans être recréé dans la même migration,
  // et chaque migration qui le (re)crée le repasse en « enable always » (create or replace le remet en mode
  // ordinaire). `since` : première migration qui le crée (avant elle, des rattrapages coupaient les déclencheurs
  // de la table le temps d'une réécriture, quand celui-ci n'existait pas).
  const checkTriggerKept = (trigger, table, invariant, since, always = true) => {
    const qualified = `(?:public\\.)?${table}`;
    const alterTable = `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${qualified}\\s+`;
    for (const [name, sql] of all) {
      // Seules les migrations qui nomment la table peuvent toucher un de ses déclencheurs.
      if (!sinceLot(name, since) || !sql.includes(table)) continue;
      const creation = new RegExp(
        `create\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+${trigger}\\b`,
        "gi",
      );
      const drop = new RegExp(
        `drop\\s+trigger\\s+(?:if\\s+exists\\s+)?${trigger}\\s+on\\s+${qualified}\\b`,
        "gi",
      );
      for (const match of sql.matchAll(drop)) {
        creation.lastIndex = match.index;
        if (!creation.test(sql)) {
          failures.push(
            `${name} drops the trigger ${trigger} of public.${table} without recreating it (${invariant})`,
          );
        }
      }
      if (
        new RegExp(`${alterTable}disable\\s+trigger\\s+(?:${trigger}|all|user)\\b`, "i").test(sql)
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
      if (!always) continue;
      if (
        new RegExp(
          `${alterTable}enable\\s+(?:replica\\s+)?trigger\\s+(?:${trigger}|all|user)\\b`,
          "i",
        ).test(sql)
      ) {
        failures.push(
          `${name} puts the trigger ${trigger} of public.${table} back to a mode that replica sessions skip (${invariant})`,
        );
      }
      creation.lastIndex = 0;
      const created = [...sql.matchAll(creation)].at(-1);
      if (
        created &&
        !new RegExp(`${alterTable}enable\\s+always\\s+trigger\\s+${trigger}\\b`, "i").test(
          sql.slice(created.index),
        )
      ) {
        failures.push(
          `${name} creates the trigger ${trigger} of public.${table} without enabling it always (${invariant})`,
        );
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
      // Tout « grant » qui nomme la table, où qu'il soit (instruction, bloc DO, texte d'un EXECUTE).
      for (const grant of sql.matchAll(/\bgrant\b[^;]*/gi)) {
        if (!new RegExp(`\\b${table}\\b`, "i").test(grant[0])) continue;
        if (
          !new RegExp(
            `^grant\\s+select\\s+on\\s+(?:table\\s+)?${qualified}\\s+to\\s+service_role\\s*$`,
            "i",
          ).test(grant[0])
        ) {
          failures.push(
            `${name} grants on public.${table} something else than SELECT to service_role alone (the fact registry is written only by its functions)`,
          );
        }
      }
    }
  }
  for (const [name, sql] of all) {
    if (!sinceLot(name, REGISTRY_MIGRATION)) continue;
    if (/\bgrant\b[^;]*\bon\s+all\s+tables\s+in\s+schema\s+[^;]*\bpublic\b/i.test(sql)) {
      failures.push(
        `${name} grants every table of the public schema at once: it would open the fact registry`,
      );
    }
    // Un droit donné par du SQL dynamique ne se lit pas : refusé depuis ce lot.
    if (
      /(?<!grant\s|revoke\s)\bexecute\b(?!\s+(?:function|procedure|on)\b)[^;]*\bgrant\b/i.test(sql)
    ) {
      failures.push(
        `${name} grants a privilege through dynamic SQL (execute): the fact registry checks cannot read it`,
      );
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
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_fact_claim_decisions",
      trigger: "auction_fact_claim_decisions_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.fact_registry_append_only",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_fact_claim_decisions",
      trigger: "auction_fact_claim_decisions_validate",
      events: "before\\s+insert",
      scope: "for\\s+each\\s+row",
      fn: "app_private.validate_auction_fact_claim_decision",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_sale_field_hold_events",
      trigger: "auction_sale_field_hold_events_append_only",
      events: "before\\s+update\\s+or\\s+delete",
      scope: "for\\s+each\\s+row",
      fn: "app_private.fact_registry_append_only",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_sale_field_hold_events",
      trigger: "auction_sale_field_hold_events_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.fact_registry_append_only",
      since: REGISTRY_MIGRATION,
    },
    {
      table: "auction_fact_claims",
      trigger: "auction_fact_claims_no_truncate",
      events: "before\\s+truncate",
      scope: "for\\s+each\\s+statement",
      fn: "app_private.refuse_auction_fact_claims_truncate",
      since: REGISTRY_MIGRATION,
    },
  ];
  for (const guard of appendOnly) {
    const created = lastStatement(`${CREATE_TRIGGER}\\s+${guard.trigger}\\s+([^;]*)`);
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
    checkTriggerKept(guard.trigger, guard.table, "append-only fact registry", guard.since);
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
  for (const [name, sql] of all) {
    if (!sinceLot(name, REGISTRY_MIGRATION)) continue;
    if (/\bsession_replication_role\b/i.test(sql)) {
      failures.push(
        `${name} sets session_replication_role: no migration or repair switches the ordinary triggers off since the fact registry`,
      );
    }
    const inFile = definitions.filter((entry) => entry.migration === name);
    for (const journal of JOURNALS) {
      for (const match of sql.matchAll(
        new RegExp(`insert\\s+into\\s+(?:public\\.)?${journal}\\b`, "gi"),
      )) {
        if (!inFile.some((entry) => match.index >= entry.start && match.index < entry.end)) {
          failures.push(
            `${name} inserts into public.${journal} outside a function: a journal that cannot be erased is never filled by a migration or a repair`,
          );
        }
      }
    }
  }

  // 3. held-fields-projection-only ------------------------------------------------------------------------------
  const allowedWriters = new Set([PROJECTION_FUNCTION, HOLD_FUNCTION]);
  for (const [name, sql] of all) {
    if (!sinceLot(name, HELD_FIELDS_MIGRATION) && !sql.includes("held_fields")) continue;
    const inFile = definitions.filter((entry) => entry.migration === name);
    const ownerAt = (index) => inFile.find((entry) => index >= entry.start && index < entry.end);
    for (const match of sql.matchAll(/\bheld_fields\s*(?::=|=(?!=))/gi)) {
      const owner = ownerAt(match.index);
      if (!owner || !allowedWriters.has(owner.name)) {
        failures.push(
          `${name} writes auction_sales.held_fields ${owner ? `in ${owner.name}` : "outside a function"}: only ${PROJECTION_FUNCTION} and ${HOLD_FUNCTION} may`,
        );
      }
    }
    for (const match of sql.matchAll(new RegExp(escapeRegExp(PROJECTION_MARKER), "g"))) {
      const owner = ownerAt(match.index);
      if (name.startsWith(REPAIRS_PREFIX) || !owner || !allowedWriters.has(owner.name)) {
        failures.push(
          `${name} names the transaction marker of the projection ${owner ? `in ${owner.name}` : "outside a function"}: only ${PROJECTION_FUNCTION} sets it and ${HOLD_FUNCTION} reads it`,
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
      /\bgrant\b[^;]*\([^)]*\bheld_fields\b[^)]*\)\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\b/i.test(
        sql,
      )
    ) {
      failures.push(`${name} grants a column privilege on auction_sales.held_fields`);
    }
    if (
      sinceLot(name, HELD_FIELDS_MIGRATION) &&
      /\bgrant\s+(?:select|all)(?:\s+privileges)?\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\s+to\s+[^;]*\b(?:anon|authenticated|public)\b/i.test(
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
  const holdTrigger = lastStatement(`${CREATE_TRIGGER}\\s+${HOLD_TRIGGER}\\s+([^;]*)`);
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
  const insertGuard = lastStatement(`${CREATE_TRIGGER}\\s+${INSERT_GUARD_TRIGGER}\\s+([^;]*)`);
  if (
    !/^before\s+insert\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*new\.held_fields\s+is\s+not\s+null\s*\)\s+execute\s+function\s+app_private\.refuse_inserted_held_fields\(\)\s*$/i.test(
      insertGuard?.[1].trim() ?? "",
    )
  ) {
    failures.push(`the insert guard ${INSERT_GUARD_TRIGGER} is missing or lost its shape`);
  }
  const roleGuard = lastStatement(`${CREATE_TRIGGER}\\s+${ROLE_GUARD_TRIGGER}\\s+([^;]*)`);
  if (
    !/^before\s+update\s+of\s+held_fields\s+on\s+public\.auction_sales\s+for\s+each\s+row\s+when\s*\(\s*new\.held_fields\s+is\s+distinct\s+from\s+old\.held_fields\s*\)\s+execute\s+function\s+app_private\.refuse_api_role_held_fields_write\(\)\s*$/i.test(
      roleGuard?.[1].trim() ?? "",
    )
  ) {
    failures.push(`the role guard ${ROLE_GUARD_TRIGGER} is missing or lost its shape`);
  }
  const roleGuardFunction = lastDefinition("app_private.refuse_api_role_held_fields_write");
  if (
    !roleGuardFunction ||
    !/security\s+invoker/i.test(roleGuardFunction.head) ||
    !/current_user\s+in\s*\(\s*'anon'\s*,\s*'authenticated'\s*,\s*'service_role'/i.test(
      roleGuardFunction.body,
    ) ||
    !/raise\s+exception\s+using\s+errcode\s*=\s*'42501'/i.test(roleGuardFunction.body)
  ) {
    failures.push(
      `${roleGuardFunction?.migration ?? "no migration"}: app_private.refuse_api_role_held_fields_write no longer refuses (42501) the API roles as the calling role (security invoker)`,
    );
  }
  for (const trigger of [HOLD_TRIGGER, INSERT_GUARD_TRIGGER, ROLE_GUARD_TRIGGER]) {
    checkTriggerKept(trigger, "auction_sales", "hold of projected fields", PROJECTION_MIGRATION);
  }
  for (const [name, sql] of all) {
    for (const match of sql.matchAll(
      /create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+([a-z0-9_]+)\s+before\s+([^;]*?)\s+on\s+(?:public\.)?auction_sales\b/gi,
    )) {
      const trigger = match[1].toLowerCase();
      if (!/\bupdate\b/i.test(match[2])) continue;
      if (
        trigger < HOLD_TRIGGER &&
        trigger !== RETENTION_GUARD_TRIGGER &&
        trigger !== ROLE_GUARD_TRIGGER
      ) {
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
        new RegExp(
          `\\bgrant\\b[^;]*\\bon\\s+(?:function|routine|procedure)\\s+[^;]*\\b${escapeRegExp(fn)}\\b`,
          "i",
        ).test(sql)
      ) {
        failures.push(`${name} grants a privilege on ${fn}: no API role may execute it`);
      }
    }
  }
  for (const [name, sql] of all) {
    if (
      sinceLot(name, PROJECTION_MIGRATION) &&
      /\bgrant\s+(?:execute|all)(?:\s+privileges)?\s+on\s+all\s+(?:functions|routines|procedures)\s+in\s+schema\s+[^;]*\bapp_private\b/i.test(
        sql,
      )
    ) {
      failures.push(
        `${name} grants every function of app_private at once: it would open ${PROJECTION_FUNCTION}`,
      );
    }
  }

  // 3 et 5, côté code : ni l'application, ni le pipeline, ni un script, ni une fonction Edge ne nomment la
  // colonne, la projection ou son marqueur. Le texte est cherché tel quel, commentaires compris.
  const codeRoots = [
    { url: "../src/", path: "src/" },
    { url: "../services/data-pipeline/src/", path: "services/data-pipeline/src/" },
    { url: "../scripts/", path: "scripts/" },
    { url: "../supabase/functions/", path: "supabase/functions/" },
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
      if (CODE_EXEMPTIONS.has(relative)) continue;
      const source = await readSourceText(new URL(`${root.url}${name}`, baseUrl));
      for (const [word, reason] of FORBIDDEN_IN_CODE) {
        if (source.includes(word)) failures.push(`${relative} ${reason}`);
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
    false,
  );

  // 7. registry-no-fk-to-auction-sales --------------------------------------------------------------------------
  for (const table of REGISTRY_TABLES) {
    for (const [name, sql] of all) {
      if (!sql.includes(table)) continue;
      for (const statement of sql.split(";")) {
        if (
          !new RegExp(
            `(?:create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?|alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?)(?:public\\.)?${table}\\b`,
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
