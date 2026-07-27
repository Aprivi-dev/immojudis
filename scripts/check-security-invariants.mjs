import { readFile } from "node:fs/promises";

const pipelineSchemaUrl = new URL("../services/data-pipeline/sql/schema.sql", import.meta.url);
const schema = await readFile(pipelineSchemaUrl, "utf8");

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

console.log(JSON.stringify({ ok: true, checked: ["pipeline-premium-rls", "obsolete-views"] }));
