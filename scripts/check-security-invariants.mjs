import { readdir, readFile } from "node:fs/promises";

const pipelineSchemaUrl = new URL("../services/data-pipeline/sql/schema.sql", import.meta.url);
const schema = await readFile(pipelineSchemaUrl, "utf8");
const outcomeMigrationUrl = new URL(
  "../supabase/migrations/20260730105842_outcome_graph_foundation.sql",
  import.meta.url,
);
const outcomeRouteUrl = new URL(
  "../src/app/api/v1/sales/[id]/outcome-graph/route.ts",
  import.meta.url,
);
const outcomeRepositoryUrl = new URL("../src/lib/outcome-graph-repository.ts", import.meta.url);
const outcomeIngestionMigrationUrl = new URL(
  "../supabase/migrations/20260730141957_outcome_source_ingestion.sql",
  import.meta.url,
);
const outcomeEvaluationMigrationUrl = new URL(
  "../supabase/migrations/20260801133817_outcome_evaluation_gate.sql",
  import.meta.url,
);
const competentCourtMigrationUrl = new URL(
  "../supabase/migrations/20260817103041_competent_court_reconciliation.sql",
  import.meta.url,
);
const [
  outcomeMigration,
  outcomeRoute,
  outcomeRepository,
  outcomeIngestionMigration,
  outcomeEvaluationMigration,
  competentCourtMigration,
] = await Promise.all([
  readFile(outcomeMigrationUrl, "utf8"),
  readFile(outcomeRouteUrl, "utf8"),
  readFile(outcomeRepositoryUrl, "utf8"),
  readFile(outcomeIngestionMigrationUrl, "utf8"),
  readFile(outcomeEvaluationMigrationUrl, "utf8"),
  readFile(competentCourtMigrationUrl, "utf8"),
]);

const failures = [];
for (const relation of [
  "auction_sales",
  "properties",
  "judicial_sales",
  "auction_features",
  "auction_surfaces",
  "auction_risks",
  "auction_documents",
  "auction_risk_occurrences",
  "auction_score_factors",
  "auction_scoring_versions",
  "auction_sales_app_read",
]) {
  const permissivePolicy = new RegExp(
    `create\\s+policy\\s+${relation}_authenticated_read[\\s\\S]{0,240}?using\\s*\\(true\\)`,
    "i",
  );
  if (permissivePolicy.test(schema)) {
    failures.push(`pipeline bootstrap contains a permissive policy for ${relation}`);
  }
}

for (const relation of [
  "outcome_addresses",
  "outcome_courts",
  "data_sources",
  "raw_artifacts",
  "auction_cases",
  "auction_lots",
  "auction_rounds",
  "auction_events",
  "auction_outcomes",
  "auction_outcome_evidence",
  "evidence_reviews",
  "auction_feature_snapshots",
  "cohort_definitions",
  "cohort_statistics",
  "model_versions",
  "auction_predictions",
]) {
  const enablesRls = new RegExp(
    `alter\\s+table\\s+public\\.${relation}\\s+enable\\s+row\\s+level\\s+security`,
    "i",
  );
  if (!enablesRls.test(outcomeMigration)) {
    failures.push(`Outcome Graph does not enable RLS on ${relation}`);
  }
}

const outcomeRelations = [
  "outcome_addresses",
  "outcome_courts",
  "data_sources",
  "raw_artifacts",
  "auction_cases",
  "auction_lots",
  "auction_rounds",
  "auction_events",
  "auction_outcomes",
  "auction_outcome_evidence",
  "evidence_reviews",
  "auction_feature_snapshots",
  "cohort_definitions",
  "cohort_statistics",
  "model_versions",
  "auction_predictions",
];
const outcomeStatements = outcomeMigration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
for (const relation of outcomeRelations) {
  const directClientGrant = outcomeStatements.some(
    (statement) =>
      /^grant\s/i.test(statement) &&
      new RegExp(`\\bpublic\\.${relation}\\b`, "i").test(statement) &&
      /\bto\s+(?:public|anon|authenticated)\b/i.test(statement),
  );
  if (directClientGrant) {
    failures.push(`Outcome Graph exposes internal registry table ${relation} directly`);
  }
}

if (
  !/new\.prediction_status\s*=\s*'ready'[\s\S]{0,800}?linked_round\.scheduled_at\s+is\s+null/i.test(
    outcomeMigration,
  )
) {
  failures.push("Outcome Graph ready predictions do not require a scheduled hearing");
}
if (
  !/new\.status\s*<>\s*'draft'[\s\S]{0,200}?inserted\s+as\s+unapproved\s+drafts/i.test(
    outcomeMigration,
  )
) {
  failures.push("Outcome Graph models can bypass the draft-first promotion workflow");
}
if (
  !/approved_at\s+is\s+distinct\s+from\s+old\.approved_at[\s\S]{0,240}?approval\s+metadata\s+is\s+immutable/i.test(
    outcomeMigration,
  )
) {
  failures.push("Outcome Graph model approval provenance can be rewritten");
}
if (
  !/new\.prediction_kind\s*=\s*'outcome_graph'[\s\S]{0,160}?linked_model\.status\s*<>\s*'active'/i.test(
    outcomeMigration,
  )
) {
  failures.push("Outcome Graph customer predictions do not require an active model");
}
if (
  !/guard_outcome_round_forecast_inputs[\s\S]{0,900}?new\.scheduled_at\s+is\s+distinct\s+from\s+old\.scheduled_at/i.test(
    outcomeMigration,
  )
) {
  failures.push("Outcome Graph hearing chronology can be rewritten after snapshot creation");
}
if (
  (outcomeMigration.match(/where\s+round_row\.id\s*=\s*new\.round_id\s+for\s+share/gi) ?? [])
    .length < 2
) {
  failures.push("Outcome Graph snapshot and prediction validation do not lock hearing chronology");
}
if (!/Ready prediction requires an active pre-hearing round/i.test(outcomeMigration)) {
  failures.push("Outcome Graph can publish ready predictions for inactive or completed rounds");
}
if (!/create\s+unique\s+index\s+auction_predictions_one_successor_idx/i.test(outcomeMigration)) {
  failures.push("Outcome Graph prediction supersession chains can branch");
}
if (
  !/constraint\s+auction_outcomes_training_review_gate_check\s+check\s*\(\s*not\s+training_eligible\s*\)/i.test(
    outcomeMigration,
  )
) {
  failures.push(
    "Outcome Graph canonical outcomes can enter training before evidence review exists",
  );
}
if (/\.is\(\s*["']superseded_by["']/i.test(outcomeRepository)) {
  failures.push("Outcome Graph latest prediction selection relies on an immutable back-reference");
}

if (
  !/auction_sale_id\s+uuid\s+unique\s+references\s+public\.auction_sales\(id\)\s+on\s+delete\s+set\s+null/i.test(
    outcomeMigration,
  )
) {
  failures.push("Outcome Graph catalogue bridge is not deletion-safe");
}

const entitlementIndex = outcomeRoute.indexOf("assertFeatureEntitlement(");
const readIndex = outcomeRoute.indexOf("getOutcomeGraphForecastForSale(");
if (entitlementIndex < 0 || readIndex < 0 || entitlementIndex > readIndex) {
  failures.push("Outcome Graph API reads the registry before enforcing Analyse entitlement");
}
if (!outcomeRoute.includes('"property.outcomeGraph"')) {
  failures.push("Outcome Graph API is not bound to the dedicated entitlement key");
}

const outcomeIngestionRelations = [
  "ingestion_jobs",
  "source_fetches",
  "artifact_extractions",
  "source_sync_checkpoints",
  "judicial_source_records",
  "source_record_matches",
  "source_purge_events",
];
for (const relation of outcomeIngestionRelations) {
  const enablesRls = new RegExp(
    `alter\\s+table\\s+public\\.${relation}\\s+enable\\s+row\\s+level\\s+security`,
    "i",
  );
  if (!enablesRls.test(outcomeIngestionMigration)) {
    failures.push(`Outcome source ingestion does not enable RLS on ${relation}`);
  }
}

const outcomeIngestionStatements = outcomeIngestionMigration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
for (const relation of outcomeIngestionRelations) {
  const directClientGrant = outcomeIngestionStatements.some(
    (statement) =>
      /^grant\s/i.test(statement) &&
      new RegExp(`\\bpublic\\.${relation}\\b`, "i").test(statement) &&
      /\bto\s+(?:public|anon|authenticated)\b/i.test(statement),
  );
  if (directClientGrant) {
    failures.push(`Outcome source ingestion exposes ${relation} directly to a browser role`);
  }
}

if (
  !/constraint\s+judicial_source_records_candidates_only_check\s+check\s*\(\s*not\s+training_eligible\s*\)/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("Outcome source candidates can become training-eligible before review");
}
if (
  !/constraint\s+source_fetches_local_import_check[\s\S]{0,300}?capture_transport\s*=\s*'local_file'[\s\S]{0,120}?http_status\s+is\s+null/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("Outcome local-file imports can claim false HTTP response metadata");
}
if (
  !/values\s*\(\s*'outcome-raw-artifacts',\s*'outcome-raw-artifacts',\s*false,/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("Outcome raw artifacts bucket is not explicitly private");
}
if (
  /create\s+policy[\s\S]{0,500}?on\s+storage\.objects[\s\S]{0,500}?outcome-raw-artifacts/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("Outcome raw artifacts bucket has a browser-facing Storage policy");
}
if (
  !/upsert_outcome_source_checkpoint[\s\S]{0,6000}?checkpoint\.revision\s*=\s*p_expected_revision/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("Outcome source checkpoints are not advanced with compare-and-swap semantics");
}
if (
  !/new\.job_kind\s*<>\s*'source\.purge'[\s\S]{0,260}?not\s+source_policy\.active/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("Outcome source purge jobs cannot survive source deactivation");
}
if (
  !/'judilibre'[\s\S]{0,500}?'pending',\s*'disabled',[\s\S]{0,120}?false/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("Judilibre is not seeded fail-closed pending legal activation");
}
if (
  !/'dvf_dgfip'[\s\S]{0,500}?'approved',\s*'allowed_automated',\s*true,\s*true/i.test(
    outcomeIngestionMigration,
  )
) {
  failures.push("DVF is not registered as a source that can contain personal data");
}

if (
  !/alter\s+table\s+public\.outcome_model_evaluations\s+enable\s+row\s+level\s+security/i.test(
    outcomeEvaluationMigration,
  )
) {
  failures.push("Outcome model evaluations do not enable RLS");
}
const outcomeEvaluationStatements = outcomeEvaluationMigration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
if (
  outcomeEvaluationStatements.some(
    (statement) =>
      /^grant\s/i.test(statement) &&
      /\bpublic\.outcome_model_evaluations\b/i.test(statement) &&
      /\bto\s+(?:public|anon|authenticated)\b/i.test(statement),
  )
) {
  failures.push("Outcome model evaluations expose a browser-facing table grant");
}
const evaluationServiceGrants = outcomeEvaluationStatements.filter(
  (statement) =>
    /^grant\s/i.test(statement) &&
    /\bpublic\.outcome_model_evaluations\b/i.test(statement) &&
    /\bto\s+service_role\b/i.test(statement),
);
if (
  evaluationServiceGrants.length !== 1 ||
  !/^grant\s+select\s*,\s*insert\s+on\s+table\s+public\.outcome_model_evaluations\s+to\s+service_role$/i.test(
    evaluationServiceGrants[0] ?? "",
  )
) {
  failures.push("Outcome model evaluations do not grant service_role append/read only");
}
if (
  !/old\.status\s*=\s*'validated'\s+and\s+new\.status\s*=\s*'active'[\s\S]{0,180}?cannot\s+bypass\s+shadow\s+mode/i.test(
    outcomeEvaluationMigration,
  )
) {
  failures.push("Outcome models can bypass shadow mode during activation");
}
if (
  (
    outcomeEvaluationMigration.match(
      /order\s+by\s+evaluation_row\.created_at\s+desc\s*,\s*evaluation_row\.id\s+desc/gi,
    ) ?? []
  ).length < 2
) {
  failures.push(
    "Outcome promotion gates do not select latest evaluations by server ingestion order",
  );
}
if (
  !/evaluation_mode\s*=\s*'prospective_shadow'[\s\S]{0,240}?known_outcome_count\s*>=\s*300[\s\S]{0,120}?scored_observation_count\s*>=\s*300/i.test(
    outcomeEvaluationMigration,
  ) ||
  !/new\.shadow_started_at\s*:=\s*pg_catalog\.clock_timestamp\(\)/i.test(
    outcomeEvaluationMigration,
  ) ||
  !/new\.feature_cutoff_at\s*<\s*linked_model\.shadow_started_at/i.test(
    outcomeEvaluationMigration,
  ) ||
  !/outcome_model_evaluation_is_fresh[\s\S]{0,1200}?interval\s+'30 days'/i.test(
    outcomeEvaluationMigration,
  )
) {
  failures.push(
    "Outcome prospective promotion lacks the 300-result, shadow-start, or freshness gate",
  );
}

const competentCourtRelations = [
  "auction_sale_competent_court_assignments",
  "catalogue_court_reconciliation_events",
];
const competentCourtStatements = competentCourtMigration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
for (const relation of competentCourtRelations) {
  if (
    !new RegExp(
      `alter\\s+table\\s+public\\.${relation}\\s+enable\\s+row\\s+level\\s+security`,
      "i",
    ).test(competentCourtMigration)
  ) {
    failures.push(`Competent-court reconciliation does not enable RLS on ${relation}`);
  }
  if (
    competentCourtStatements.some(
      (statement) =>
        /^grant\s/i.test(statement) &&
        new RegExp(`\\bpublic\\.${relation}\\b`, "i").test(statement) &&
        /\bto\s+(?:public|anon|authenticated)\b/i.test(statement),
    )
  ) {
    failures.push(`Competent-court reconciliation exposes ${relation} to a browser role`);
  }
}
if (
  competentCourtRelations.some(
    (relation) =>
      !new RegExp(
        `grant\\s+select\\s*,\\s*insert\\s+on\\s+table\\s+public\\.${relation}\\s+to\\s+service_role`,
        "i",
      ).test(competentCourtMigration),
  )
) {
  failures.push("Competent-court audit tables do not grant service_role append/read only");
}
if (
  !/revoke\s+all\s+on\s+function\s+public\.reconcile_catalogue_competent_courts\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i.test(
    competentCourtMigration,
  ) ||
  !/grant\s+execute\s+on\s+function\s+public\.reconcile_catalogue_competent_courts\(\)\s+to\s+service_role/i.test(
    competentCourtMigration,
  )
) {
  failures.push("Competent-court reconciliation RPC is not restricted to service_role");
}
if (
  !/mapping_method'\s*,\s*'justice_competence_insee_exact'[\s\S]{0,500}?'reference_sha256'/i.test(
    competentCourtMigration,
  ) ||
  !/new\.court_mapping_input\s*=\s*expected_input/i.test(competentCourtMigration)
) {
  failures.push("Competent-court bridge reconciliation does not require exact evidence");
}

for (const relation of [
  "public_auction_sales",
  "auction_sales_quality_issues",
  "auction_sales_investment_candidates",
  "auction_source_coverage",
  "v_auction_map_pins",
]) {
  const grant = new RegExp(`grant\\s+select\\s+on\\s+${relation}\\s+to\\s+authenticated`, "i");
  if (grant.test(schema)) failures.push(`pipeline bootstrap re-grants obsolete view ${relation}`);
}

// P4-01 / P4-07: Data API exposure of auction_sales and default function privileges.
const columnGrantMigration = await readFile(
  new URL(
    "../supabase/migrations/20261010003000_restrict_auction_sales_columns.sql",
    import.meta.url,
  ),
  "utf8",
);
if (
  !/revoke\s+select\s+on\s+table\s+public\.auction_sales\s+from\s+authenticated/i.test(
    columnGrantMigration,
  )
) {
  failures.push("auction_sales keeps a table-wide SELECT grant for authenticated");
}
// Every `grant select (columns) on public.auction_sales to ... authenticated` of every migration is
// checked against the internal columns, not only the first one: a later migration that adds a column
// to the grant (the catalogue visibility columns, 20261027100200) must not open an internal one.
// The columns granted for the catalogue visibility (catalogue_quarantined, catalogue_expiry_fallback,
// catalogue_state_observed_at, catalogue_state_end_estimate) are dates and a boolean: allowed.
// Grants made by dynamic SQL (execute format(...)) are out of reach of this static scan.
const migrationsUrl = new URL("../supabase/migrations/", import.meta.url);
const migrationSources = new Map(
  await Promise.all(
    (await readdir(migrationsUrl))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map(async (file) => [file, await readFile(new URL(file, migrationsUrl), "utf8")]),
  ),
);
const internalAuctionSalesColumns = [
  /^raw_text$/,
  /^content_hash$/,
  /^last_run_id$/,
  /^external_id$/,
  /^location$/,
  /^premium_readiness_\w+$/,
  /^retention_\w+$/,
];
let authenticatedColumnGrants = 0;
for (const [name, source] of migrationSources) {
  const sql = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  for (const grant of sql.matchAll(
    /grant\s+select\s*\(([^)]*)\)\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\s+to\s+([^;]+);/gi,
  )) {
    if (!/\b(?:authenticated|public)\b/i.test(grant[2] ?? "")) continue;
    authenticatedColumnGrants += 1;
    for (const column of (grant[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/"/g, "").toLowerCase())) {
      if (internalAuctionSalesColumns.some((internal) => internal.test(column))) {
        failures.push(`${name}: auction_sales column grant exposes internal column ${column}`);
      }
    }
  }
}
if (authenticatedColumnGrants === 0) {
  failures.push("auction_sales has no column-level grant for authenticated");
}
const defaultPrivilegeMigration = await readFile(
  new URL("../supabase/migrations/20261010004000_default_function_privileges.sql", import.meta.url),
  "utf8",
);
if (
  !/alter\s+default\s+privileges\s+revoke\s+execute\s+on\s+functions\s+from\s+public\s*;/i.test(
    defaultPrivilegeMigration,
  ) ||
  !/alter\s+default\s+privileges\s+in\s+schema\s+public\s+grant\s+execute\s+on\s+functions\s+to\s+service_role/i.test(
    defaultPrivilegeMigration,
  )
) {
  failures.push("function default privileges still grant EXECUTE to PUBLIC");
}

// P4-11: approved evidence is served through signed URLs from a private bucket.
const privateBucketMigration = await readFile(
  new URL(
    "../supabase/migrations/20261010005000_private_approved_evidence_bucket.sql",
    import.meta.url,
  ),
  "utf8",
);
if (
  !/update\s+storage\.buckets\s+set\s+public\s*=\s*false\s+where\s+id\s*=\s*'information-agent-approved'/i.test(
    privateBucketMigration,
  )
) {
  failures.push("information-agent-approved is not made private");
}

// Chantier G: no personal name in the stored texts a signed-in account can read.
// raw_payload / observations / lawyer_contact feed v_auction_sales_app (security_invoker) and the
// fiche displays the lawyer line: revoking them from `authenticated` without turning that view into
// a definer view (stage 2 of 20261010003000) breaks the whole catalogue for connected users.
for (const [name, migration] of migrationSources) {
  const rawColumnRevoke =
    /revoke\s+select\s*\([^)]*\b(?:raw_payload|observations|lawyer_contact)\b[^)]*\)\s+on\s+(?:table\s+)?(?:public\.)?auction_sales\s+from\s+[^;]*\bauthenticated\b/i;
  if (rawColumnRevoke.test(migration) && !/security_invoker\s*=\s*false/i.test(migration)) {
    failures.push(
      `${name} revokes raw_payload/observations/lawyer_contact from authenticated without making v_auction_sales_app a definer view`,
    );
  }
}

// The collection writes the texts it stores through the personal-data filter, and the shared
// reports go through its TypeScript mirror (services/data-pipeline/src/personal_data.py).
const [supabaseClientSource, saleRowBuilders, reportSerialization, personalDataFilter] =
  await Promise.all([
    readFile(
      new URL("../services/data-pipeline/src/storage/supabase_client.py", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../services/data-pipeline/src/storage/sale_row_builders.py", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/lib/property-report/serialization.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/personal-data-filter.ts", import.meta.url), "utf8"),
  ]);
if (
  (
    supabaseClientSource.match(
      /redact_storage_row\(\{column: data\.get\(column\) for column in UPSERT_COLUMNS\}\)/g,
    ) ?? []
  ).length !== 2
) {
  failures.push("auction_sales rows are written without the personal-data filter");
}
if (
  (saleRowBuilders.match(/rows\.append\(redact_storage_row\(row\)\)/g) ?? []).length !== 2 ||
  !/redact_personal_text\(occurrence\["excerpt"\]\)/.test(saleRowBuilders)
) {
  failures.push(
    "properties, judicial_sales or risk excerpts are written without the personal-data filter",
  );
}
if (!/return redactSaleTexts\(/.test(reportSerialization)) {
  failures.push("sale texts reach saved and shared reports without the personal-data filter");
}
if (!/export function redactSaleTexts/.test(personalDataFilter)) {
  failures.push("the TypeScript personal-data filter is missing");
}

// « 3 déblocages par mois » (Découverte): an account unlocks one online sale at a time, the quota is
// enforced in the database, and the unlock opens that sale's rows only.
const [saleUnlockMigration, documentReadingServer, documentReadingRedaction] = await Promise.all([
  readFile(
    new URL("../supabase/migrations/20261023100000_discovery_sale_unlocks.sql", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/lib/document-reading.server.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/document-reading-redaction.ts", import.meta.url), "utf8"),
]);
if (
  !/alter\s+table\s+public\.user_sale_unlocks\s+enable\s+row\s+level\s+security/i.test(
    saleUnlockMigration,
  )
) {
  failures.push("Sale unlocks do not enable RLS");
}
const saleUnlockStatements = saleUnlockMigration
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);
if (
  saleUnlockStatements.some(
    (statement) =>
      /^grant\s/i.test(statement) &&
      /\bpublic\.user_sale_unlocks\b/i.test(statement) &&
      /\bto\s+(?:public|anon|authenticated)\b/i.test(statement) &&
      /\b(?:insert|update|delete|all)\b/i.test(statement.split(/\bon\b/i)[0] ?? ""),
  )
) {
  failures.push("Sale unlocks can be written directly by a browser role");
}
for (const unlockFunction of ["unlock_sale_at", "unlock_sale"]) {
  const definition = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:public|app_private)\\.${unlockFunction}\\([^)]*\\)\\s*returns\\s+\\w+\\s+language\\s+\\w+\\s+security\\s+definer\\s+set\\s+search_path\\s*=\\s*''\\s*as`,
    "i",
  );
  if (!definition.test(saleUnlockMigration)) {
    failures.push(`${unlockFunction} is not SECURITY DEFINER with a fixed search_path`);
  }
}
// The unlock opens five things only. auction_sales is never widened (row level security cannot limit
// columns): the sale is served by a redacted definer view that lists the caller's own unlocks.
if (
  /(?:alter|create)\s+(?:or\s+replace\s+)?policy\s+auction_sales_authenticated_read/i.test(
    saleUnlockMigration,
  )
) {
  failures.push("The sale unlock migration widens auction_sales_authenticated_read");
}
if (/set_catalogue_raw_columns_hidden/i.test(saleUnlockMigration)) {
  failures.push("The sale unlock migration redefines set_catalogue_raw_columns_hidden");
}
for (const table of [
  "auction_documents",
  "auction_risks",
  "auction_risk_occurrences",
  "auction_score_factors",
  "auction_features",
  "auction_surfaces",
]) {
  if (new RegExp(`on\\s+public\\.${table}\\b`, "i").test(saleUnlockMigration)) {
    failures.push(`The sale unlock migration opens ${table} to an unlock`);
  }
}
const unlockedView =
  /create\s+or\s+replace\s+view\s+public\.v_auction_sales_unlocked\s+with\s*\(\s*security_invoker\s*=\s*false\s*,\s*security_barrier\s*=\s*true\s*\)[\s\S]*?;/i.exec(
    saleUnlockMigration,
  )?.[0];
if (
  !unlockedView ||
  !/from\s+public\.user_sale_unlocks[\s\S]*?where\s+unlock_row\.user_id\s*=\s*\(select\s+auth\.uid\(\)\)[\s\S]*?app_private\.current_user_unlocked_sale\(s\.id\)/i.test(
    unlockedView,
  )
) {
  failures.push("v_auction_sales_unlocked is not limited to the sales the caller unlocked");
} else if (
  /null::double precision as investment_score/i.test(unlockedView) === false ||
  /'\[\]'::jsonb as risks/i.test(unlockedView) === false ||
  /null::text as source_url/i.test(unlockedView) === false ||
  /\braw_payload\s*,|\bs\.raw_payload\s+as\b|\bs\.observations\s+as\b/i.test(unlockedView)
) {
  failures.push(
    "v_auction_sales_unlocked leaks the score, the risks, the source url or the raw payload",
  );
}
// The source blocks carry the page text, the listing urls (completeness evidence) and, as keys, the
// names of the source platforms: the unlocked view may only serve their ceiling projection.
if (
  unlockedView &&
  (/raw_payload\s*->\s*'source_blocks'\s+as\b/i.test(unlockedView) ||
    /\bobservations\s+as\b/i.test(unlockedView) ||
    !/app_private\.unlocked_ceiling_blocks\(\s*s\.raw_payload\s*->\s*'source_blocks'\s*\)\s+as\s+source_blocks\b/i.test(
      unlockedView,
    ) ||
    !/app_private\.unlocked_ceiling_blocks_by_source\(/i.test(unlockedView))
) {
  failures.push("v_auction_sales_unlocked serves raw source blocks instead of their projection");
}
// A definer view runs the functions it calls as the caller: sale_is_unlockable is granted to
// service_role only, so the view must go through the granted definer helper.
if (unlockedView && /sale_is_unlockable\(/i.test(unlockedView)) {
  failures.push(
    "v_auction_sales_unlocked calls a function authenticated cannot execute (sale_is_unlockable)",
  );
}
if (
  !/revoke\s+all\s+on\s+table\s+public\.v_auction_sales_unlocked\s+from\s+public,\s*anon/i.test(
    saleUnlockMigration,
  )
) {
  failures.push("v_auction_sales_unlocked is not closed to anon");
}
if (/using\s*\(\s*true\s*\)/i.test(saleUnlockMigration)) {
  failures.push("The sale unlock migration contains a permissive policy");
}
if (
  !/redactReadingTexts\(\s*mapDocumentReading\(/.test(documentReadingServer) ||
  !/import\s*\{\s*redactPersonalText\s*\}\s*from\s*"@\/lib\/personal-data-filter"/.test(
    documentReadingRedaction,
  ) ||
  (documentReadingRedaction.match(/redactPersonalText\(point\./g) ?? []).length !== 3
) {
  failures.push("document reading quotes reach the page without the personal-data filter");
}

// Classement de /sales par complétude: the numeric score of a listing stays in the database. Browser
// roles read the tier only (via the search views and the public RPC), the table is written by
// service_role alone.
const completenessMigration = await readFile(
  new URL(
    "../supabase/migrations/20261024100000_listing_completeness_ranking.sql",
    import.meta.url,
  ),
  "utf8",
);
if (
  !/alter\s+table\s+public\.auction_sale_listing_completeness\s+enable\s+row\s+level\s+security/i.test(
    completenessMigration,
  )
) {
  failures.push("The listing completeness table does not enable RLS");
}
if (
  !/revoke\s+all\s+on\s+table\s+public\.auction_sale_listing_completeness\s+from\s+public,\s*anon,\s*authenticated/i.test(
    completenessMigration,
  )
) {
  failures.push("The listing completeness table is not closed to anon and authenticated");
}
if (
  completenessMigration
    .split(";")
    .some(
      (statement) =>
        /^\s*(?:--[^\n]*\n\s*)*grant\s/i.test(statement) &&
        /\bpublic\.auction_sale_listing_completeness\b/i.test(statement) &&
        /\bto\s+(?:public|anon|authenticated)\b/i.test(statement),
    )
) {
  failures.push("The listing completeness table is granted to a browser role");
}
if (
  /create\s+policy[^;]*auction_sale_listing_completeness[^;]*\bto\s+(?:public|anon|authenticated)\b/i.test(
    completenessMigration,
  )
) {
  failures.push("The listing completeness table has a policy for a browser role");
}
// Every column the search views and the public RPC publish is the tier: the score, its inputs and
// the policy version never appear in a select list or a RETURNS TABLE.
if (
  /returns\s+table\s*\([^)]*\b(?:score|input_fingerprint|policy_version|evaluated_at)\b/i.test(
    completenessMigration,
  ) ||
  /\bcompleteness\.(?:score|input_fingerprint|policy_version|evaluated_at)\b/i.test(
    completenessMigration,
  )
) {
  failures.push("The listing completeness migration publishes more than the tier");
}
if (
  !/create\s+or\s+replace\s+function\s+app_private\.sale_completeness_tier\(p_sale_id\s+uuid\)\s*returns\s+smallint\s+language\s+sql\s+stable\s+security\s+definer\s+set\s+search_path\s*=\s*''/i.test(
    completenessMigration,
  )
) {
  failures.push("sale_completeness_tier is not SECURITY DEFINER with a fixed search_path");
}
if (
  !/create\s+or\s+replace\s+view\s+public\.v_auction_sales_discovery_search\s+with\s*\(\s*security_invoker\s*=\s*false\s*,\s*security_barrier\s*=\s*true\s*\)/i.test(
    completenessMigration,
  )
) {
  failures.push("v_auction_sales_discovery_search lost its security barrier");
}

// Photos principales hébergées (test du 16/10/2026): the bucket serves only re-encoded WebP files by
// public URL, the table is closed to the browser roles, the site reads copies through one definer
// function keyed by a source URL it already knows, and the files leave with the sale through the
// retention queue.
const [salePhotosMigration, saleRetentionSource] = await Promise.all([
  readFile(
    new URL("../supabase/migrations/20261026100000_sale_photo_mirrors.sql", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/lib/sale-retention.ts", import.meta.url), "utf8"),
]);
if (
  !/insert\s+into\s+storage\.buckets[\s\S]*?'sale-photos'[\s\S]*?\btrue\b[\s\S]*?2097152[\s\S]*?array\['image\/webp'\]/i.test(
    salePhotosMigration,
  )
) {
  failures.push("The sale-photos bucket is not limited to 2 MB of image/webp");
}
if (
  /create\s+policy[\s\S]{0,500}?on\s+storage\.objects[\s\S]{0,500}?sale-photos/i.test(
    salePhotosMigration,
  )
) {
  failures.push("The sale-photos bucket has a browser-facing Storage policy");
}
if (
  !/alter\s+table\s+public\.sale_photos\s+enable\s+row\s+level\s+security/i.test(
    salePhotosMigration,
  )
) {
  failures.push("sale_photos does not enable RLS");
}
if (
  !/revoke\s+all\s+on\s+table\s+public\.sale_photos\s+from\s+public,\s*anon,\s*authenticated/i.test(
    salePhotosMigration,
  )
) {
  failures.push("sale_photos is not closed to anon and authenticated");
}
if (
  salePhotosMigration
    .split(";")
    .some(
      (statement) =>
        /^\s*(?:--[^\n]*\n\s*)*grant\s/i.test(statement) &&
        /\bpublic\.sale_photos\b/i.test(statement) &&
        /\bto\s+(?:public|anon|authenticated)\b/i.test(statement),
    ) ||
  /create\s+policy[^;]*\bsale_photos\b/i.test(salePhotosMigration)
) {
  failures.push("sale_photos is granted or exposed by a policy to a browser role");
}
const salePhotoReader =
  /create\s+or\s+replace\s+function\s+app_private\.sale_photo_mirrors\([^)]*\)[\s\S]*?\$function\$;/i.exec(
    salePhotosMigration,
  )?.[0];
if (
  !salePhotoReader ||
  !/security\s+definer\s+set\s+search_path\s*=\s*''/i.test(salePhotoReader) ||
  !/photo\.status\s*=\s*'stored'/i.test(salePhotoReader) ||
  !/p_source_urls\[1:100\]/i.test(salePhotoReader)
) {
  failures.push(
    "sale_photo_mirrors is not a bounded SECURITY DEFINER reader of the stored copies only",
  );
}
if (
  /function\s+public\.sale_photo_mirrors\([^)]*\)\s*returns\s+table\s*\([^)]*\)[^$]*?security\s+definer/i.test(
    salePhotosMigration,
  )
) {
  failures.push("public.sale_photo_mirrors is SECURITY DEFINER (use the app_private wrapper)");
}
if (
  !/after\s+delete\s+on\s+public\.sale_photos[\s\S]*?enqueue_sale_photo_files_for_deletion/i.test(
    salePhotosMigration,
  ) ||
  !/check\s*\(bucket\s+in\s*\([^)]*'sale-photos'[^)]*\)\)/i.test(salePhotosMigration)
) {
  failures.push("Deleting a sale photo does not queue its files for removal");
}
if (!/"sale-photos"/.test(saleRetentionSource)) {
  failures.push("The retention worker does not accept the sale-photos bucket");
}

// Offre de lancement (19/10/2026): a single read-only switch in the database decides whether a free
// account has the Analyse access. The table is closed to the browser roles, the reader is a definer
// function with an empty search_path that anon never executes, the two access functions consult it,
// the switch is limited to administrators, and nothing is ever written to the accounts.
const launchOfferName = "20261028120000_launch_offer.sql";
const launchOfferMigration = migrationSources.get(launchOfferName) ?? "";
const launchOfferSql = launchOfferMigration
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/--[^\n]*/g, "");
if (!launchOfferSql) {
  failures.push("The launch offer migration is missing");
} else {
  if (
    !/alter\s+table\s+app_private\.launch_offer\s+enable\s+row\s+level\s+security/i.test(
      launchOfferSql,
    ) ||
    !/revoke\s+all\s+on\s+table\s+app_private\.launch_offer\s+from\s+public,\s*anon,\s*authenticated/i.test(
      launchOfferSql,
    )
  ) {
    failures.push("app_private.launch_offer is not closed to the browser roles");
  }
  const launchOfferReader =
    /create\s+or\s+replace\s+function\s+app_private\.launch_offer_active\(\)[\s\S]*?\$function\$;/i.exec(
      launchOfferSql,
    )?.[0];
  if (
    !launchOfferReader ||
    !/\bstable\b/i.test(launchOfferReader) ||
    !/security\s+definer\s+set\s+search_path\s+to\s+''/i.test(launchOfferReader)
  ) {
    failures.push("launch_offer_active is not a STABLE SECURITY DEFINER with an empty search_path");
  }
  for (const statement of launchOfferSql.split(";")) {
    if (
      /^\s*grant\s/i.test(statement) &&
      /launch_offer|get_launch_offer_status/i.test(statement) &&
      /\bto\s+[^;]*\b(?:public|anon)\b/i.test(statement) &&
      !/\bset_launch_offer\b/i.test(statement)
    ) {
      failures.push("The launch offer state is granted to anon or public");
    }
  }
  if (
    !/function\s+public\.set_launch_offer\(p_active\s+boolean\)[\s\S]*?if\s+not\s+public\.is_admin\(\)\s+then\s+raise\s+exception/i.test(
      launchOfferSql,
    ) ||
    !/revoke\s+all\s+on\s+function\s+public\.set_launch_offer\(boolean\)\s+from\s+public,\s*anon/i.test(
      launchOfferSql,
    )
  ) {
    failures.push("set_launch_offer is not limited to administrators");
  }
  if (
    /\b(?:update|insert\s+into|delete\s+from)\s+public\.(?:user_profiles|user_subscriptions)\b/i.test(
      launchOfferSql,
    ) ||
    /\bset\s+account_tier\b/i.test(launchOfferSql)
  ) {
    failures.push("The launch offer writes into user_profiles or user_subscriptions");
  }
}
// Every later definition of the two access functions keeps consulting the switch, and, from the
// migration that requires a confirmed email (20261028170000), the single eligibility function.
const launchOfferEligibilityName = "20261028170000_launch_offer_requires_confirmed_email.sql";
for (const [name, source] of migrationSources) {
  if (name <= launchOfferName) continue;
  const sql = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  for (const accessFunction of ["current_user_has_premium_access", "has_active_analysis_access"]) {
    const definition = new RegExp(
      `create\\s+or\\s+replace\\s+function\\s+app_private\\.${accessFunction}\\([^)]*\\)[\\s\\S]*?\\$(\\w*)\\$;`,
      "i",
    ).exec(sql)?.[0];
    if (definition && !/launch_offer_active\(\)/.test(definition)) {
      failures.push(`${name} redefines ${accessFunction} without the launch offer switch`);
    }
    if (
      definition &&
      name >= launchOfferEligibilityName &&
      !/launch_offer_account_eligible\(/.test(definition)
    ) {
      failures.push(
        `${name} redefines ${accessFunction} without launch_offer_account_eligible (confirmed email)`,
      );
    }
  }
}

// A function that is not SECURITY DEFINER runs the functions it calls with the caller's rights.
// Since 20261010004000 an app_private function gets no EXECUTE by default: when service_role can
// call such a function, every app_private function it calls (and created since) must be granted
// to service_role too, or each call fails with « permission denied » (court_auction_scenarios
// calling starting_price_band broke the « Scénarios d'enchères » that way).
{
  const firstCreated = new Map();
  const latestDefinition = new Map();
  const serviceRoleGranted = new Map();
  const statements =
    /create\s+(?:or\s+replace\s+)?function\s+(public|app_private)\.(\w+)\s*\(([\s\S]*?)\bas\s+\$(\w*)\$([\s\S]*?)\$\4\$|grant\s+(?:execute|all)\s+on\s+function\s+(public|app_private)\.(\w+)\s*\([^)]*\)\s+to\s+([^;]+);|revoke\s+(?:execute|all)\s+on\s+function\s+(public|app_private)\.(\w+)\s*\([^)]*\)\s+from\s+([^;]+);/gi;
  for (const [name, source] of migrationSources) {
    const sql = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    for (const match of sql.matchAll(statements)) {
      if (match[1]) {
        const key = `${match[1]}.${match[2]}`.toLowerCase();
        if (!firstCreated.has(key)) firstCreated.set(key, name);
        latestDefinition.set(key, {
          definer: /security\s+definer/i.test(match[3]),
          body: match[5],
        });
      } else if (match[6] && /\bservice_role\b/i.test(match[8])) {
        serviceRoleGranted.set(`${match[6]}.${match[7]}`.toLowerCase(), true);
      } else if (match[9] && /\bservice_role\b/i.test(match[11])) {
        serviceRoleGranted.set(`${match[9]}.${match[10]}`.toLowerCase(), false);
      }
    }
  }
  const defaultPrivilegeName = "20261010004000_default_function_privileges.sql";
  const missing = new Set();
  for (const [caller, definition] of latestDefinition) {
    if (definition.definer) continue;
    const callableByServiceRole =
      serviceRoleGranted.get(caller) === true ||
      (caller.startsWith("public.") &&
        serviceRoleGranted.get(caller) !== false &&
        firstCreated.get(caller) >= defaultPrivilegeName);
    if (!callableByServiceRole) continue;
    for (const call of definition.body.matchAll(/\bapp_private\.(\w+)\s*\(/gi)) {
      const callee = `app_private.${call[1]}`.toLowerCase();
      if (!latestDefinition.has(callee) || firstCreated.get(callee) < defaultPrivilegeName)
        continue;
      if (serviceRoleGranted.get(callee) !== true) missing.add(`${caller} -> ${callee}`);
    }
  }
  for (const call of missing) {
    failures.push(`${call}: the callee is not granted to service_role (permission denied)`);
  }
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    checked: [
      "pipeline-premium-rls",
      "obsolete-views",
      "outcome-graph-rls",
      "outcome-graph-no-direct-client-grants",
      "outcome-graph-promotion-and-chronology",
      "outcome-graph-lifecycle-and-supersession",
      "outcome-graph-training-review-gate",
      "outcome-graph-entitlement-order",
      "outcome-graph-history-bridge",
      "outcome-source-ingestion-rls",
      "outcome-source-ingestion-no-direct-client-grants",
      "outcome-source-private-artifacts",
      "outcome-source-candidates-only",
      "outcome-source-local-capture-provenance",
      "outcome-source-checkpoint-cas",
      "outcome-source-purge-after-disable",
      "outcome-source-fail-closed-policies",
      "outcome-model-evaluation-promotion-gate",
      "competent-court-reconciliation-rls",
      "competent-court-reconciliation-exact-evidence",
      "auction-sales-column-grants",
      "function-default-privileges",
      "approved-evidence-private-bucket",
      "raw-columns-not-revoked-without-definer-view",
      "personal-data-filter-write-boundary",
      "sale-unlock-rls-and-definer-boundary",
      "document-reading-personal-data-filter",
      "listing-completeness-score-stays-private",
      "sale-photos-bucket-table-and-purge",
      "launch-offer-switch-and-access-functions",
      "invoker-functions-callees-granted-to-service-role",
    ],
  }),
);
