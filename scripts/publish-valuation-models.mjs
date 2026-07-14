#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import { predictLightGbmQuantiles } from "../src/lib/lightgbm-inference.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = join(root, "deployment", "valuation-models");
const force = process.argv.includes("--force");
const validateOnly = process.argv.includes("--validate-only");

if (!force && process.env.VERCEL_ENV !== "production") {
  console.log("[valuation-models] Skipped outside a Vercel production build.");
  process.exit(0);
}

const files = existsSync(artifactsDir)
  ? readdirSync(artifactsDir)
      .filter((file) => file.endsWith(".json"))
      .sort()
  : [];
if (!files.length) {
  console.log("[valuation-models] No deployment artifacts to publish.");
  process.exit(0);
}

const bundles = files.map((file) => readBundle(join(artifactsDir, file)));
for (const bundle of bundles) validatePromotion(bundle);
console.log(
  `[valuation-models] Validated ${bundles.map((bundle) => `${bundle.segment}/${bundle.version}`).join(", ")}.`,
);
if (validateOnly) process.exit(0);

const dbUrl = firstFilledEnv(
  process.env.SUPABASE_DB_URL,
  process.env.POSTGRES_URL_NON_POOLING,
  process.env.POSTGRES_URL,
);
if (!dbUrl) {
  throw new Error(
    "[valuation-models] SUPABASE_DB_URL, POSTGRES_URL_NON_POOLING or POSTGRES_URL is required.",
  );
}

const sql = postgres(dbUrl, {
  max: 1,
  ssl: process.env.POSTGRES_SSL === "disable" ? false : "require",
});

try {
  for (const bundle of bundles) {
    await sql.begin(async (transaction) => {
      await transaction`
        update public.valuation_model_versions
        set status = 'retired', retired_at = now(), updated_at = now()
        where model_key = 'immojudis_market_value'
          and segment = ${bundle.segment}
          and status = 'active'
          and version <> ${bundle.version}
      `;
      await transaction`
        insert into public.valuation_model_versions (
          model_key,
          version,
          segment,
          framework,
          status,
          feature_names,
          artifact,
          calibration,
          training_metrics,
          training_rows,
          training_period_start,
          training_period_end,
          trained_at,
          activated_at
        ) values (
          'immojudis_market_value',
          ${bundle.version},
          ${bundle.segment},
          'lightgbm_quantile',
          'active',
          ${bundle.featureNames},
          ${transaction.json(bundle.artifact)},
          ${transaction.json(bundle.calibration)},
          ${transaction.json(bundle.metrics)},
          ${bundle.trainingRows},
          ${bundle.trainingPeriodStart},
          ${bundle.trainingPeriodEnd},
          now(),
          now()
        )
        on conflict (model_key, segment, version) do update set
          framework = excluded.framework,
          status = 'active',
          feature_names = excluded.feature_names,
          artifact = excluded.artifact,
          calibration = excluded.calibration,
          training_metrics = excluded.training_metrics,
          training_rows = excluded.training_rows,
          training_period_start = excluded.training_period_start,
          training_period_end = excluded.training_period_end,
          trained_at = excluded.trained_at,
          activated_at = excluded.activated_at,
          retired_at = null,
          updated_at = now()
      `;
    });
    console.log(`[valuation-models] Activated ${bundle.segment}/${bundle.version}.`);
  }
  await verifyRuntimeModels(bundles);
} finally {
  await sql.end({ timeout: 5 });
}

async function verifyRuntimeModels(expectedBundles) {
  const supabaseUrl = firstFilledEnv(
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
  );
  const serviceRoleKey = firstFilledEnv(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SECRET_KEY,
  );
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "[valuation-models] Supabase service credentials are required for runtime verification.",
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  for (const expected of expectedBundles) {
    const { data, error } = await supabase
      .from("valuation_model_versions")
      .select("version,segment,artifact")
      .eq("model_key", "immojudis_market_value")
      .eq("segment", expected.segment)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw new Error(`[valuation-models] Runtime read failed: ${error.message}`);
    if (!data || data.version !== expected.version) {
      throw new Error(
        `[valuation-models] Runtime model mismatch for ${expected.segment}: expected ${expected.version}.`,
      );
    }

    const prediction = predictLightGbmQuantiles(data.artifact, smokeFeatures(expected.segment));
    if (
      !prediction ||
      prediction.p10PricePerM2 > prediction.p50PricePerM2 ||
      prediction.p50PricePerM2 > prediction.p90PricePerM2
    ) {
      throw new Error(
        `[valuation-models] Runtime inference failed for ${expected.segment}/${expected.version}.`,
      );
    }
    console.log(
      `[valuation-models] Runtime verified ${expected.segment}/${expected.version} via Supabase REST.`,
    );
  }
}

function smokeFeatures(segment) {
  const surfaceM2 = segment === "house" ? 110 : 55;
  const landSurfaceM2 = segment === "house" ? 420 : 0;
  return {
    surface_m2: surfaceM2,
    log_surface_m2: Math.log1p(surfaceM2),
    land_surface_m2: landSurfaceM2,
    log_land_surface_m2: Math.log1p(landSurfaceM2),
    rooms_count: segment === "house" ? 5 : 3,
    latitude: 48.8566,
    longitude: 2.3522,
    sale_year: 2026,
    sale_month_sin: 0,
    sale_month_cos: -1,
    local_median_log: Math.log(6_500),
    local_spread_log: Math.log(1.35),
    local_sample_size_log: Math.log1p(20),
  };
}

function readBundle(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error(`Invalid model bundle: ${path}`);
  return parsed;
}

function validatePromotion(bundle) {
  const supportedSegments = new Set(["apartment", "house", "building", "commercial", "land"]);
  if (!supportedSegments.has(bundle.segment))
    throw new Error(`Unsupported segment: ${bundle.segment}`);
  if (typeof bundle.version !== "string" || !bundle.version.trim()) {
    throw new Error(`Missing model version for ${bundle.segment}`);
  }
  if (!Array.isArray(bundle.featureNames) || !bundle.featureNames.length) {
    throw new Error(`Missing feature contract for ${bundle.segment}`);
  }
  if (bundle.artifact?.format !== "lightgbm-json-v1") {
    throw new Error(`Unsupported artifact format for ${bundle.segment}`);
  }
  const testRows = finiteNumber(bundle.metrics?.test_rows);
  const testMape = finiteNumber(bundle.metrics?.test_mape_pct);
  const medianApe = finiteNumber(bundle.metrics?.test_median_ape_pct);
  const coverage = finiteNumber(bundle.metrics?.interval_coverage_pct);
  const intervalWidth = finiteNumber(bundle.metrics?.interval_mean_width_pct);
  if (testRows == null || testRows < 50) {
    throw new Error(`Model ${bundle.segment} rejected: ${testRows ?? 0} chronological test rows`);
  }
  if (medianApe == null || medianApe > 30) {
    throw new Error(`Model ${bundle.segment} rejected: median APE ${medianApe ?? "missing"}%`);
  }
  if (testMape == null || testMape > 40) {
    throw new Error(`Model ${bundle.segment} rejected: MAPE ${testMape ?? "missing"}%`);
  }
  if (coverage == null || coverage < 72) {
    throw new Error(
      `Model ${bundle.segment} rejected: interval coverage ${coverage ?? "missing"}%`,
    );
  }
  if (intervalWidth == null || intervalWidth > 110) {
    throw new Error(
      `Model ${bundle.segment} rejected: interval width ${intervalWidth ?? "missing"}%`,
    );
  }
  if (!Number.isInteger(bundle.trainingRows) || bundle.trainingRows < 100) {
    throw new Error(`Model ${bundle.segment} rejected: invalid training row count`);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstFilledEnv(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}
