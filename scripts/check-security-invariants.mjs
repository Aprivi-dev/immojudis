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
// Plafond des ventes notariales: the conditions of a notarial sale reach the browser of an Analyse
// account (v_auction_sales_app) and of an account that unlocked the sale (v_auction_sales_unlocked)
// through one allow-list function, never through raw_payload, and never to the discovery view (an
// account that did not unlock the sale). The reserved conditions (adjudication price, floor price,
// price reduction, last possible offer, deposit terms, session date, negotiation fee amount) are
// never copied.
const saleConditionsName = "20261103110000_sale_conditions_public_projection.sql";
const saleConditionsSql = (migrationSources.get(saleConditionsName) ?? "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/--[^\n]*/g, "");
if (!saleConditionsSql) {
  failures.push("The sale conditions migration is missing");
} else {
  const projection =
    /create\s+or\s+replace\s+function\s+app_private\.public_sale_conditions\([^)]*\)[\s\S]*?\$\$;/i.exec(
      saleConditionsSql,
    )?.[0] ?? "";
  const allowedConditionKeys = [
    "adjudication_type",
    "advertising_fees_eur",
    "deposit_eur",
    "first_offer_eur",
    "negotiation_fee_payer",
    "negotiation_fee_rate",
    "origin",
    "overbid_allowed",
    "price_nature",
    "procedure",
  ];
  const projectedKeys = [...projection.matchAll(/'(\w+)',\s*case\b/gi)]
    .map((match) => match[1])
    .sort();
  if (!projection) {
    failures.push("public_sale_conditions is not defined by the sale conditions migration");
  } else {
    if (projectedKeys.join(",") !== allowedConditionKeys.join(",")) {
      failures.push(
        `public_sale_conditions projects ${projectedKeys.join(",")} instead of the allow-list ${allowedConditionKeys.join(",")}`,
      );
    }
    if (
      !/security\s+invoker/i.test(projection) ||
      !/set\s+search_path\s*=\s*''/i.test(projection)
    ) {
      failures.push("public_sale_conditions is not SECURITY INVOKER with an empty search_path");
    }
    // The function reads raw_payload, which changes: it is STABLE, never IMMUTABLE.
    if (/\bimmutable\b/i.test(projection)) {
      failures.push("public_sale_conditions must be STABLE, not IMMUTABLE");
    }
    // Every key read from the source conditions (`conditions -> 'x'`, `->> 'x'`, `#> '{x}'`) must be
    // an allowed key: a key that is read but not projected today could be projected by a later edit
    // without the allow-list above noticing, and a reserved key must never be read at all.
    const readConditionKeys = [
      ...projection.matchAll(/\bconditions\s*(?:->>?|#>>?)\s*'([^']+)'/gi),
    ].map((match) => match[1]);
    const unexpectedReads = [...new Set(readConditionKeys)].filter(
      (key) => !allowedConditionKeys.includes(key),
    );
    if (unexpectedReads.length > 0) {
      failures.push(
        `public_sale_conditions reads ${unexpectedReads.join(",")} from the conditions, outside the allow-list`,
      );
    }
    // raw_payload itself is read in two places only: the conditions object and the price nature.
    const rawPayloadReads = [
      ...projection.matchAll(/\bp_raw_payload\s*(?:->>?|#>>?)\s*'([^']+)'/gi),
    ].map((match) => match[1]);
    const allowedPayloadReads = [
      "{source_property_features,sale_conditions}",
      "starting_price_nature",
    ];
    const unexpectedPayloadReads = [...new Set(rawPayloadReads)].filter(
      (key) => !allowedPayloadReads.includes(key),
    );
    if (unexpectedPayloadReads.length > 0) {
      failures.push(
        `public_sale_conditions reads ${unexpectedPayloadReads.join(",")} from raw_payload, outside the allow-list`,
      );
    }
    if (!/in\s*\(\s*'ADJUDICATION'\s*,\s*'LICITATION'\s*,\s*'SAISIE'\s*\)/.test(projection)) {
      failures.push("public_sale_conditions must limit origin to the values the pipeline writes");
    }
    // Only a source whose raw_payload is small and known (notaires) is read by the views.
    if (
      !/CASE\s+WHEN\s+s\.source_name\s*=\s*''notaires''\s+THEN\s+app_private\.public_sale_conditions\(s\.raw_payload\)/i.test(
        saleConditionsSql,
      )
    ) {
      failures.push("The views must call public_sale_conditions only for source_name = notaires");
    }
    for (const reserved of [
      "adjudication_price_eur",
      "floor_price_eur",
      "last_offer_eur",
      "price_reduction",
      "deposit_transfer_terms",
      "deposit_deadline_time",
      "session_at",
      "negotiation_fee_eur",
      "negotiation_fee_amount",
    ]) {
      if (projection.includes(reserved)) {
        failures.push(`public_sale_conditions copies the reserved condition ${reserved}`);
      }
    }
  }
  if (
    !/revoke\s+all\s+on\s+function\s+app_private\.public_sale_conditions\(pg_catalog\.jsonb\)\s+from\s+public,\s*anon,\s*authenticated/i.test(
      saleConditionsSql,
    ) ||
    !/grant\s+execute\s+on\s+function\s+app_private\.public_sale_conditions\(pg_catalog\.jsonb\)\s+to\s+authenticated,\s*service_role/i.test(
      saleConditionsSql,
    ) ||
    /grant\s+execute\s+on\s+function\s+app_private\.public_sale_conditions\([^)]*\)\s+to\s+[^;]*\banon\b/i.test(
      saleConditionsSql,
    )
  ) {
    failures.push("public_sale_conditions is not closed to anon and open to authenticated only");
  }
  const rewrittenViews =
    /relname\s+in\s*\(([^)]*)\)/i
      .exec(saleConditionsSql)?.[1]
      ?.match(/'(\w+)'/g)
      ?.map((name) => name.replaceAll("'", ""))
      .sort() ?? [];
  if (rewrittenViews.join(",") !== "v_auction_sales_app,v_auction_sales_unlocked") {
    failures.push(
      "The sale conditions migration must add sale_conditions to v_auction_sales_app and v_auction_sales_unlocked only",
    );
  }
}
for (const [name, source] of migrationSources) {
  const sql = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const discoveryView =
    /create\s+or\s+replace\s+view\s+public\.v_auction_sales_discovery\b[\s\S]*?;/i.exec(sql)?.[0] ??
    "";
  if (/sale_conditions/i.test(discoveryView)) {
    failures.push(
      `${name} gives sale_conditions to the discovery view (accounts that did not unlock)`,
    );
  }
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

// Pépites (règle pepite-v1, 26/10/2026) : le calcul ne dépend jamais de la publicité ni du score interne.
// `investment_score`, les données d'avocat et de sponsoring, et le profil de l'utilisateur n'entrent pas
// dans la règle. Le contrôle d'indépendance de l'administration (src/lib/admin-pepites.ts) lit les encarts
// pour MESURER la part des pépites sponsorisées : il est volontairement hors de cette liste, et aucun module
// de la règle ne l'importe.
// Pour chaque module de la règle : (1) aucun module atteignable par ses imports `@/…` ou relatifs n'a un
// chemin (depuis src/) qui évoque les avocats, le sponsoring, les encarts ou le contrôle d'indépendance de
// l'administration (`admin-pepites`) ; (2) le texte, commentaires retirés, de chaque module atteint qui
// appartient au calcul (`src/lib/pepite*`, `src/lib/sale-pepites-batch.ts`, et le module d'entrée) ne lit ni
// `investment_score` ni une colonne d'avocat ou de sponsoring (les fichiers de types générés, qui
// décrivent toutes les colonnes, n'en font pas partie) ; (3) un import `@/…` qui ne se résout pas fait
// échouer le contrôle : sinon un module renommé sortirait silencieusement du parcours.
{
  const pepiteRuleModules = [
    "src/lib/pepite-policy.ts",
    "src/lib/pepite-input.ts",
    "src/lib/pepite-reasons.ts",
    // Règle pepite-v1.2 (29/10/2026) : DPE, marché local, pièces lues (copropriété), badges et leurs lectures.
    // Chacun est un point d'entrée du contrôle (son propre texte et tout ce qu'il importe) : aucun ne lit d'avocat,
    // de sponsoring ni `investment_score`.
    "src/lib/pepite-energy.ts",
    "src/lib/pepite-market.ts",
    "src/lib/pepite-copro.ts",
    "src/lib/pepite-badges.ts",
    "src/lib/pepite-context.server.ts",
    "src/lib/flood-risk.ts",
    "src/lib/sale-pepites-batch.ts",
    "src/app/api/cron/sale-pepites/route.ts",
  ];
  const forbiddenModule = /lawyer|sponsor|featured|placement|admin-pepites/i;
  const computationModule = /^src\/lib\/(?:pepite[^/]*|sale-pepites-batch)\.tsx?$/;
  const forbiddenRead =
    /\b(?:investment_score|investment_summary|score_factors|score_confidence|lawyer_name|lawyer_contact|referenced_lawyers|paid_placement\w*|lawyer_placement\w*|sponsor\w*)\b|\blawyer-placement-label\b/i;
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const sourceRoot = new URL("../src/", import.meta.url);
  const relativeToSrc = (path) => path.slice(path.indexOf("/src/") + 1);
  const resolveModule = async (specifier, fromPath) => {
    let base;
    if (specifier.startsWith("@/")) base = new URL(specifier.slice(2), sourceRoot).pathname;
    else if (specifier.startsWith(".")) base = new URL(specifier, `file://${fromPath}`).pathname;
    else return null;
    for (const candidate of [
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      base,
    ]) {
      try {
        await readFile(candidate);
        // Un fichier qui n'est pas du TypeScript (JSON, style) existe, mais n'a pas d'imports à suivre.
        return /\.tsx?$/.test(candidate) ? candidate : "";
      } catch {
        // essai suivant
      }
    }
    return undefined;
  };
  for (const relativePath of pepiteRuleModules) {
    const entry = new URL(`../${relativePath}`, import.meta.url).pathname;
    const seen = new Set();
    const pending = [entry];
    while (pending.length) {
      const path = pending.pop();
      if (seen.has(path)) continue;
      seen.add(path);
      const reached = relativeToSrc(path);
      if (forbiddenModule.test(reached)) {
        failures.push(
          `${relativePath} reaches ${reached}: the pepite rule must not depend on lawyer, sponsoring or pepite administration modules`,
        );
        continue;
      }
      const text = await readFile(path, "utf8");
      const code = stripComments(text);
      if ((path === entry || computationModule.test(reached)) && forbiddenRead.test(code)) {
        failures.push(
          `${relativePath} reaches ${reached}, which reads investment_score, lawyer or sponsoring data: they never enter the pepite rule`,
        );
      }
      for (const match of code.matchAll(
        /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g,
      )) {
        const specifier = match[1] ?? match[2] ?? match[3];
        const resolved = await resolveModule(specifier, path);
        if (resolved === undefined) {
          if (specifier.startsWith("@/") || specifier.startsWith(".")) {
            failures.push(
              `${relativePath}: ${reached} imports ${specifier}, which cannot be resolved: the independence check cannot follow it`,
            );
          }
        } else if (resolved) pending.push(resolved);
      }
    }
  }
}

// Pépites, affichage (lot B2, 26/10/2026) : aucun montant ne part sans le droit au plafond. Le détail
// (plafond de référence, prix probable, fourchette, ratio) est dans une table privée ; seule la route
// `GET /api/sales/[id]/pepite` le lit, et seulement après avoir vérifié le droit pour CETTE vente. Le niveau
// « criteria » (ouvert aux visiteurs) ne reçoit que les noms des critères. Contrôles :
// (1) le premier bloc `if (detailRequested) { … }` de la route exige une session (`requireSupabaseAuthContext`)
//     puis, avec `await`, `assertFeatureEntitlementVia(auth, "property.bidCeiling", …, { saleId })` : la clé du
//     droit, l'`await` et la vente font partie du contrôle, et le contrôle est DANS ce bloc ;
// (2) ce bloc précède la lecture de la ligne privée (`readStoredPepite(`) ;
// (3) `pepiteDetailView(` n'est appelé que dans un bloc `if (detailRequested)`, où toute réponse porte
//     `PRIVATE_HEADERS` et jamais `PUBLIC_HEADERS` ; `PRIVATE_HEADERS` contient `private, no-store` ;
// (4) aucun fichier de `src/` hors liste blanche ne nomme la table privée `auction_sale_pepites` (commentaires
//     retirés) : les tests, les types générés, le traitement horaire, l'administration et la lecture de la route ;
// (5) la route publique de la liste et le module de lecture de la liste ne lisent ni la table privée ni son détail ;
// (6) les modules du navigateur n'importent ni la règle ni un client de service (la règle reste hors du
//     JavaScript du site, et un montant ne peut pas être recalculé côté navigateur).
{
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const read = async (relativePath) =>
    stripComments(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));
  const compact = (text) => text.replace(/\s+/g, "");
  // Le contenu du bloc `{ … }` dont l'accolade ouvrante est à `open` (accolades des chaînes ignorées).
  const balancedBlock = (text, open) => {
    let depth = 0;
    let quote = null;
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return { start: open, end: index, body: text.slice(open + 1, index) };
      }
    }
    return null;
  };
  const detailBlocks = (text) =>
    [...text.matchAll(/if\s*\(\s*detailRequested\s*\)\s*\{/g)]
      .map((match) => balancedBlock(text, match.index + match[0].length - 1))
      .filter(Boolean);

  const routePath = "src/app/api/sales/[id]/pepite/route.ts";
  const route = await read(routePath);
  const blocks = detailBlocks(route);
  const guard = blocks[0];
  const guardText = guard ? compact(guard.body) : "";
  if (
    !guard ||
    !guardText.includes("requireSupabaseAuthContext(") ||
    !guardText.includes('awaitassertFeatureEntitlementVia(auth,"property.bidCeiling"') ||
    !guardText.includes("{saleId}")
  ) {
    failures.push(
      `${routePath} must, inside its first detailRequested block, require a session then await assertFeatureEntitlementVia(auth, "property.bidCeiling", …, { saleId })`,
    );
  }
  const storedRead = route.indexOf("readStoredPepite(");
  if (!guard || storedRead < 0 || guard.end > storedRead) {
    failures.push(`${routePath} reads the stored pepite before the right is checked`);
  }
  const privateHeaders = /const\s+PRIVATE_HEADERS\s*=\s*\{[^}]*\}/.exec(route)?.[0] ?? "";
  if (!privateHeaders.includes("private, no-store")) {
    failures.push(`${routePath}: PRIVATE_HEADERS must carry cache-control "private, no-store"`);
  }
  for (const call of route.matchAll(/pepiteDetailView\(/g)) {
    const inside = blocks.find((block) => call.index > block.start && call.index < block.end);
    if (!inside) {
      failures.push(`${routePath} builds the pepite detail outside a detailRequested block`);
    } else if (!inside.body.includes("PRIVATE_HEADERS") || inside.body.includes("PUBLIC_HEADERS")) {
      failures.push(
        `${routePath}: the detail block must answer with PRIVATE_HEADERS only, never PUBLIC_HEADERS`,
      );
    }
  }
  if (!route.includes("pepiteDetailView(")) {
    failures.push(`${routePath} no longer builds the detail through pepiteDetailView`);
  }

  // (4) Liste blanche de la table privée.
  const privateTableAllowed = new Set([
    "src/lib/sale-pepite.server.ts",
    "src/lib/sale-pepites-batch.ts",
    "src/lib/admin-pepites.ts",
    "src/integrations/supabase/types.ts",
  ]);
  const sourceFiles = await readdir(new URL("../src/", import.meta.url), { recursive: true });
  for (const entry of sourceFiles) {
    const name = String(entry);
    if (!/\.(?:ts|tsx|mjs|cjs)$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
    const relativePath = `src/${name}`;
    if (privateTableAllowed.has(relativePath)) continue;
    if ((await read(relativePath)).includes("auction_sale_pepites")) {
      failures.push(
        `${relativePath} names the private table auction_sale_pepites: only the pepite server read, the hourly batch and the administration may`,
      );
    }
  }

  // (4 bis) Liste blanche de la table privée du risque d'inondation (règle pepite-v2) : seuls le magasin du
  // traitement planifié (lectures et écritures, rôle de service) et les types générés la nomment. Le calcul des
  // pépites, la route publique, l'administration et le navigateur ne la lisent jamais : le calcul lit le verdict par
  // le magasin, et le seul fait public (« exposé ») sort de la fonction `list_public_pepite_flood_exposed_ids`.
  const floodTableAllowed = new Set([
    "src/lib/flood-risk-store.server.ts",
    "src/integrations/supabase/types.ts",
  ]);
  for (const entry of sourceFiles) {
    const name = String(entry);
    if (!/\.(?:ts|tsx|mjs|cjs)$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
    const relativePath = `src/${name}`;
    if (floodTableAllowed.has(relativePath)) continue;
    if ((await read(relativePath)).includes("auction_sale_flood_risk")) {
      failures.push(
        `${relativePath} names the private table auction_sale_flood_risk: only the flood risk store may (the pepite rule reads the verdict through it, never the table)`,
      );
    }
  }

  // (4 bis bis) Marché local de la règle pepite-v1.2 : l'agrégat `commune_market_trends` (table privée de
  // `app_private`, lue par `get_commune_market_trends`) n'est nommé que par le module de lecture de la règle
  // (`pepite-context.server.ts`) et les types générés. Ni le navigateur, ni une route publique, ni l'administration
  // ne le lisent.
  const marketTableAllowed = new Set([
    "src/lib/pepite-context.server.ts",
    "src/integrations/supabase/types.ts",
  ]);
  for (const entry of sourceFiles) {
    const name = String(entry);
    if (!/\.(?:ts|tsx|mjs|cjs)$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
    const relativePath = `src/${name}`;
    if (marketTableAllowed.has(relativePath)) continue;
    if ((await read(relativePath)).includes("commune_market_trends")) {
      failures.push(
        `${relativePath} names the private commune_market_trends aggregate: only the pepite context reader may`,
      );
    }
  }

  // (4 ter) Liste blanche des modules qui importent le magasin de la table d'inondation : le traitement planifié,
  // la recopie des communes et le calcul des pépites (lecture des verdicts) ; rien d'autre, ni le navigateur, ni
  // une route publique, ni l'administration.
  const floodStoreImporters = new Set([
    "src/lib/sale-pepites-batch.ts",
    "src/lib/sale-flood-risk-batch.ts",
    "src/lib/sale-communes-sync.server.ts",
  ]);
  for (const entry of sourceFiles) {
    const name = String(entry);
    if (!/\.(?:ts|tsx|mjs|cjs)$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
    const relativePath = `src/${name}`;
    if (relativePath === "src/lib/flood-risk-store.server.ts") continue;
    if (floodStoreImporters.has(relativePath)) continue;
    if (/flood-risk-store\.server/.test(await read(relativePath))) {
      failures.push(
        `${relativePath} imports the flood risk store: only the flood batch, the commune sync and the pepite batch may`,
      );
    }
  }

  // (4 quater) Contrôle SQL des migrations de l'inondation : RLS activée, aucun droit pour anon ni authenticated,
  // et les enveloppes publiques ne sont jamais SECURITY DEFINER (une fonction définer de public exécutable par
  // anon est refusée par supabase/tests/441_function_privileges.sql).
  {
    const sql = async (file) => {
      try {
        return (
          await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8")
        ).replace(/--[^\n]*/g, "");
      } catch {
        return null;
      }
    };
    for (const [file, table] of [
      ["20261106100200_sale_flood_risk.sql", "auction_sale_flood_risk"],
      ["20261106100500_sale_flood_risk_lease.sql", "sale_flood_risk_lease"],
    ]) {
      const text = await sql(file);
      if (text == null) {
        failures.push(`${file} is missing: the flood risk migrations must exist`);
        continue;
      }
      if (
        !new RegExp(
          `alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
          "i",
        ).test(text)
      ) {
        failures.push(`${file} does not enable row level security on public.${table}`);
      }
      if (/\bgrant\b[^;]*\bto\b[^;]*\b(?:anon|authenticated|public)\b/i.test(text)) {
        failures.push(
          `${file} grants a right on the flood risk objects to anon, authenticated or public`,
        );
      }
    }
    const exposed = await sql("20261106100400_pepite_flood_exposed_ids.sql");
    if (exposed == null) {
      failures.push("20261106100400_pepite_flood_exposed_ids.sql is missing");
    } else {
      const wrapper =
        /create\s+or\s+replace\s+function\s+public\.list_public_pepite_flood_exposed_ids\s*\(\s*\)([\s\S]*?)\$function\$\s*;/i.exec(
          exposed,
        );
      if (!wrapper) {
        failures.push(
          "public.list_public_pepite_flood_exposed_ids is not defined in its migration",
        );
      } else if (/security\s+definer/i.test(wrapper[1].split("$function$")[0])) {
        failures.push(
          "public.list_public_pepite_flood_exposed_ids must not be SECURITY DEFINER (use the app_private definer)",
        );
      }
    }
    const lease = await sql("20261106100500_sale_flood_risk_lease.sql");
    if (lease != null && /security\s+definer/i.test(lease)) {
      failures.push(
        "20261106100500_sale_flood_risk_lease.sql must not define SECURITY DEFINER functions",
      );
    }

    // Marché local (règle pepite-v1.2) : l'agrégat est privé (RLS, aucun droit pour anon, authenticated ni public),
    // son recalcul est un SECURITY DEFINER à chemin de recherche vide, et la lecture publique ne l'est jamais.
    const trendsFile = "20261109130100_commune_market_trends.sql";
    const trends = await sql(trendsFile);
    if (trends == null) {
      failures.push(`${trendsFile} is missing: the commune market trends migration must exist`);
    } else {
      if (
        !/alter\s+table\s+app_private\.commune_market_trends\s+enable\s+row\s+level\s+security/i.test(
          trends,
        )
      ) {
        failures.push(`${trendsFile} does not enable row level security on the aggregate`);
      }
      if (/\bgrant\b[^;]*\bto\b[^;]*\b(?:anon|authenticated|public)\b/i.test(trends)) {
        failures.push(
          `${trendsFile} grants a right on the commune market trends objects to anon, authenticated or public`,
        );
      }
      const refresh =
        /create\s+or\s+replace\s+function\s+app_private\.refresh_commune_market_trends\s*\([^)]*\)([\s\S]*?)\$function\$/i.exec(
          trends,
        );
      if (
        !refresh ||
        !/security\s+definer/i.test(refresh[1]) ||
        !/set\s+search_path\s*=\s*''/i.test(refresh[1])
      ) {
        failures.push(
          "app_private.refresh_commune_market_trends must be SECURITY DEFINER with an empty search_path",
        );
      }
      const wrapper =
        /create\s+or\s+replace\s+function\s+public\.get_commune_market_trends\s*\([^)]*\)([\s\S]*?)\$function\$/i.exec(
          trends,
        );
      if (!wrapper) {
        failures.push("public.get_commune_market_trends is not defined in its migration");
      } else if (/security\s+definer/i.test(wrapper[1])) {
        failures.push("public.get_commune_market_trends must not be SECURITY DEFINER");
      }
    }
  }

  for (const relativePath of [
    "src/app/api/catalogue/pepites/route.ts",
    "src/lib/pepite-sale-ids.ts",
    "src/lib/search/pepite-filter.ts",
  ]) {
    if (
      /auction_sale_pepites|supabaseAdmin|\.details\b|referenceCeiling|probablePrice/.test(
        await read(relativePath),
      )
    ) {
      failures.push(
        `${relativePath} reads the private pepite table or its details: the public list carries identifiers only`,
      );
    }
  }
  for (const relativePath of [
    "src/components/PepiteBadge.tsx",
    "src/components/sale-detail/PepiteBlock.tsx",
    "src/components/sale-detail/PepiteBlockLazy.tsx",
    "src/hooks/use-sale-pepite.ts",
    "src/lib/client-api/sale-pepite.ts",
    "src/lib/search/pepite-filter.ts",
    "src/lib/pepite-copy.ts",
    "src/lib/pepite-flood-copy.ts",
  ]) {
    if (
      /@\/lib\/pepite-policy|@\/lib\/pepite-reasons|@\/lib\/pepite-input|client\.server|sale-pepite\.server/.test(
        await read(relativePath),
      )
    ) {
      failures.push(
        `${relativePath} imports the pepite rule or a server module: the browser never computes or reads an amount`,
      );
    }
  }
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
//
// Functions are keyed by SIGNATURE (schema.name(argument types), normalised), not by name: a
// function and its overload are two functions with their own grants, and a grant on one does not
// cover the other. A call in a body carries no types, so a callee is checked on every one of its
// overloads created since 20261010004000.
const POSTGRES_TYPE_WORDS = new Set([
  "smallint",
  "integer",
  "int",
  "int2",
  "int4",
  "int8",
  "bigint",
  "numeric",
  "decimal",
  "real",
  "double",
  "float",
  "float4",
  "float8",
  "text",
  "varchar",
  "character",
  "char",
  "bpchar",
  "boolean",
  "bool",
  "uuid",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "json",
  "jsonb",
  "bytea",
  "inet",
  "cidr",
  "citext",
  "record",
  "void",
  "trigger",
  "anyelement",
  "anyarray",
  "oid",
  "regclass",
  "name",
  "money",
  "bit",
  "point",
  "tsvector",
  "tsquery",
  "geometry",
  "geography",
  "vector",
]);
const POSTGRES_TYPE_ALIASES = new Map([
  ["int", "integer"],
  ["int4", "integer"],
  ["int2", "smallint"],
  ["int8", "bigint"],
  ["bool", "boolean"],
  ["float8", "double precision"],
  ["float4", "real"],
  ["float", "double precision"],
  ["decimal", "numeric"],
  ["varchar", "character varying"],
  ["char", "character"],
  ["bpchar", "character"],
  ["timestamptz", "timestamp with time zone"],
  ["timestamp", "timestamp without time zone"],
  ["timetz", "time with time zone"],
  ["time", "time without time zone"],
]);

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function normalizeTypeName(text) {
  let type = text
    .replace(/\(\s*[\d\s,]*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\[\s*\]/g, "[]")
    .replace(/^(?:public|pg_catalog)\./, "")
    .trim();
  let arrays = "";
  while (type.endsWith("[]")) {
    arrays += "[]";
    type = type.slice(0, -2).trim();
  }
  return `${POSTGRES_TYPE_ALIASES.get(type) ?? type}${arrays}`;
}

/** Normalised argument types of one parameter, or null for an OUT parameter (not in the identity). */
function parameterType(parameter) {
  let text = parameter
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+default\s.*$/s, "")
    .replace(/\s*:?=\s.*$/s, "");
  const mode = /^(inout|in|out|variadic)\s+/.exec(text)?.[1];
  if (mode === "out") return null;
  if (mode) text = text.slice(mode.length).trim();
  const words = text.split(" ");
  const isType = (word) =>
    POSTGRES_TYPE_WORDS.has(word.replace(/[([].*$/, "")) || /[."]/.test(word);
  // « p_amount numeric » → numeric ; « numeric » → numeric ; « name text » → text.
  if (words.length > 1 && (!isType(words[0]) || isType(words[1]))) words.shift();
  return normalizeTypeName(words.join(" "));
}

/** `schema.name(type, type…)` from the text that follows the opening parenthesis of the arguments. */
function functionSignature(schema, name, argumentText) {
  let depth = 1;
  let end = argumentText.length;
  for (let index = 0; index < argumentText.length; index += 1) {
    if (argumentText[index] === "(") depth += 1;
    if (argumentText[index] === ")") depth -= 1;
    if (depth === 0) {
      end = index;
      break;
    }
  }
  const types = splitTopLevel(argumentText.slice(0, end))
    .map(parameterType)
    .filter((type) => type !== null);
  return `${schema}.${name}(${types.join(",")})`.toLowerCase();
}

{
  const firstCreated = new Map();
  const latestDefinition = new Map();
  const serviceRoleGranted = new Map();
  const signaturesByName = new Map();
  const statements =
    /create\s+(?:or\s+replace\s+)?function\s+(public|app_private)\.(\w+)\s*\(([\s\S]*?)\bas\s+\$(\w*)\$([\s\S]*?)\$\4\$|grant\s+(?:execute|all)\s+on\s+function\s+(public|app_private)\.(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)\s+to\s+([^;]+);|revoke\s+(?:execute|all)\s+on\s+function\s+(public|app_private)\.(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)\s+from\s+([^;]+);/gi;
  for (const [name, source] of migrationSources) {
    const sql = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    for (const match of sql.matchAll(statements)) {
      if (match[1]) {
        const key = functionSignature(match[1], match[2], match[3]);
        if (!firstCreated.has(key)) firstCreated.set(key, name);
        latestDefinition.set(key, {
          definer: /security\s+definer/i.test(match[3]),
          body: match[5],
        });
        const byName = `${match[1]}.${match[2]}`.toLowerCase();
        if (!signaturesByName.has(byName)) signaturesByName.set(byName, new Set());
        signaturesByName.get(byName).add(key);
      } else if (match[6] && /\bservice_role\b/i.test(match[9])) {
        serviceRoleGranted.set(functionSignature(match[6], match[7], `${match[8]})`), true);
      } else if (match[10] && /\bservice_role\b/i.test(match[13])) {
        serviceRoleGranted.set(functionSignature(match[10], match[11], `${match[12]})`), false);
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
      const overloads = signaturesByName.get(`app_private.${call[1]}`.toLowerCase()) ?? [];
      for (const callee of overloads) {
        if (firstCreated.get(callee) < defaultPrivilegeName) continue;
        if (serviceRoleGranted.get(callee) !== true) missing.add(`${caller} -> ${callee}`);
      }
    }
  }
  for (const call of missing) {
    failures.push(`${call}: the callee is not granted to service_role (permission denied)`);
  }
}

// Cartes de référence privées (loyers de l'ANIL, zonage tendu) : seul le module serveur de lecture
// (`rent-reference.server.ts`) nomme les tables, avec les types générés ; les tests ne comptent pas.
{
  const referenceTables = /\b(?:anil_rents|commune_housing_tension)\b/;
  const allowed = new Set([
    "src/lib/rent-reference.server.ts",
    "src/integrations/supabase/types.ts",
  ]);
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const entries = await readdir(new URL("../src/", import.meta.url), { recursive: true });
  for (const entry of entries) {
    const name = String(entry);
    if (!/\.(?:ts|tsx|mjs|cjs)$/.test(name) || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
    const relativePath = `src/${name}`;
    if (allowed.has(relativePath)) continue;
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
    if (referenceTables.test(stripComments(source))) {
      failures.push(
        `${relativePath} names a private reference table (anil_rents, commune_housing_tension): only rent-reference.server.ts may`,
      );
    }
  }
}

// Invariants génériques sur les surfaces ajoutées après le 03/11/2026 (revue de sécurité du 27/10) :
// 1. toute table `public.*` créée par une migration 20261104 ou postérieure active la RLS et ne reçoit
//    aucun droit pour anon, authenticated ni public (accès par le rôle de service seulement) ;
// 2. toute route `src/app/api/cron/*/route.ts` s'authentifie (`runMonitoredCron(` ou
//    `cronRequestAuthorized(`) ;
// 3. `admin-signups.ts` appelle `assertAdminAuth` avant toute lecture ;
// 4. `app_private.signup_trial_ends_at` ne lit jamais `user_metadata` (modifiable par la personne).
{
  const stripSql = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const recent = [...migrationSources]
    .filter(([name]) => name >= "20261104")
    .map(([name, source]) => [name, stripSql(source)]);
  const created = [];
  for (const [name, sql] of recent) {
    for (const match of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi,
    )) {
      created.push({ name, table: match[1].toLowerCase() });
    }
  }
  for (const { name, table } of created) {
    const enablesRls = recent.some(([, sql]) =>
      new RegExp(
        `alter\\s+table\\s+(?:only\\s+)?public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
        "i",
      ).test(sql),
    );
    if (!enablesRls) {
      failures.push(`${name} creates public.${table} without enabling row level security`);
    }
    for (const [grantFile, sql] of recent) {
      for (const statement of sql.split(";")) {
        if (!/^\s*grant\s/i.test(statement)) continue;
        if (!new RegExp(`\\bpublic\\.${table}\\b`, "i").test(statement)) continue;
        // Le rôle vient après `to` ; le schéma `public.` du nom de table n'est pas le rôle `public`.
        const roles = statement
          .replace(/^[\s\S]*?\bto\b/i, "")
          .replace(/\bpublic\.[a-z0-9_]+/gi, "");
        if (/\b(?:anon|authenticated|public)\b/i.test(roles)) {
          failures.push(
            `${grantFile} grants a right on public.${table} to anon, authenticated or public (table created by ${name})`,
          );
        }
      }
    }
  }

  const cronDirectory = new URL("../src/app/api/cron/", import.meta.url);
  for (const entry of (await readdir(cronDirectory, { withFileTypes: true })).filter((item) =>
    item.isDirectory(),
  )) {
    let source;
    try {
      source = await readFile(new URL(`${entry.name}/route.ts`, cronDirectory), "utf8");
    } catch {
      continue;
    }
    if (!/\b(?:runMonitoredCron|cronRequestAuthorized)\(/.test(source)) {
      failures.push(
        `src/app/api/cron/${entry.name}/route.ts does not authenticate: call runMonitoredCron( or cronRequestAuthorized(`,
      );
    }
  }

  const adminSignups = await readFile(
    new URL("../src/lib/admin-signups.ts", import.meta.url),
    "utf8",
  );
  for (const fn of ["listAdminSignups", "extendAdminSignupTrials"]) {
    const start = adminSignups.search(new RegExp(`export\\s+async\\s+function\\s+${fn}\\b`));
    if (start < 0) {
      failures.push(`src/lib/admin-signups.ts no longer exports ${fn}`);
      continue;
    }
    const rest = adminSignups.slice(start + 10);
    const next = rest.search(/\nexport\s/);
    const body = next < 0 ? rest : rest.slice(0, next);
    const auth = body.search(/\bassertAdminAuth\(/);
    if (auth < 0) {
      failures.push(`src/lib/admin-signups.ts: ${fn} does not call assertAdminAuth`);
      continue;
    }
    // Avant l'appel, ni lecture de données ni attente (hors la signature de la fonction).
    const before = body
      .slice(0, auth)
      .replace(/^[\s\S]*?\)\s*:\s*Promise<[^{]*\{/, "")
      .replace(/(?:const\s+\w+\s*=\s*)?await\s*$/, "");
    if (/\bawait\b|supabaseAdmin|\.from\(|\.rpc\(/.test(before)) {
      failures.push(`src/lib/admin-signups.ts: ${fn} reads data before assertAdminAuth`);
    }
  }

  for (const [name, source] of migrationSources) {
    for (const definition of stripSql(source).matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+app_private\.signup_trial_ends_at\b[\s\S]*?(\$[a-z_]*\$)[\s\S]*?\1/gi,
    )) {
      if (/user_metadata|raw_user_meta_data|raw_app_meta_data/i.test(definition[0])) {
        failures.push(
          `${name}: signup_trial_ends_at reads user metadata (editable by the account holder)`,
        );
      }
    }
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
      "pepite-rule-independent-of-lawyers-sponsoring-and-score",
      "pepite-detail-never-without-entitlement",
      "sale-photos-bucket-table-and-purge",
      "launch-offer-switch-and-access-functions",
      "invoker-functions-callees-granted-to-service-role",
      "private-reference-tables-only-in-server-module",
      "new-public-tables-rls-and-no-client-grants",
      "cron-routes-authenticated",
      "admin-signups-asserts-admin-first",
      "signup-trial-end-ignores-user-metadata",
    ],
  }),
);
