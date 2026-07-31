import { readFile } from "node:fs/promises";

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
const [outcomeMigration, outcomeRoute, outcomeRepository, outcomeIngestionMigration] =
  await Promise.all([
    readFile(outcomeMigrationUrl, "utf8"),
    readFile(outcomeRouteUrl, "utf8"),
    readFile(outcomeRepositoryUrl, "utf8"),
    readFile(outcomeIngestionMigrationUrl, "utf8"),
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
    ],
  }),
);
