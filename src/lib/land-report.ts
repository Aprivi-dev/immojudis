import { fetchLandPlanning } from "./land-planning-provider";
import { fetchLandRisks } from "./land-risks-provider";
import { fetchLandRules } from "./land-rule-extraction";
import { buildLandProjectAnalyses } from "./land-project-analysis";
import type {
  LandLocationInput,
  LandPlanningResult,
  LandProviderOptions,
  LandReport,
  LandRisksResult,
  LandRulesResult,
  LandSourceCheck,
} from "./land-report-types";

type LandReportDependencies = {
  planning: typeof fetchLandPlanning;
  risks: typeof fetchLandRisks;
  rules: typeof fetchLandRules;
};
const defaultDependencies: LandReportDependencies = {
  planning: fetchLandPlanning,
  risks: fetchLandRisks,
  rules: fetchLandRules,
};

export async function buildLandReport(
  input: LandLocationInput,
  options: LandProviderOptions = {},
  dependencies: LandReportDependencies = defaultDependencies,
): Promise<LandReport> {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  let planning: LandPlanningResult;
  try {
    planning = await dependencies.planning(input, options);
  } catch {
    planning = {
      locationStatus: "unresolved",
      coordinates: null,
      codeInsee: null,
      parcels: [],
      zones: [],
      documents: [],
      constraints: [],
      checks: [failedCheck("planning", "Urbanisme officiel", generatedAt)],
      warnings: [
        "Le rattachement cadastral et les sources d’urbanisme n’ont pas pu être vérifiés.",
      ],
      completeCoverage: false,
    };
  }
  const results = await Promise.allSettled([
    dependencies.risks(
      {
        parcels: planning.parcels,
        coordinates: planning.coordinates,
        codeInsee: planning.codeInsee,
      },
      options,
    ),
    dependencies.rules(planning, options),
  ]);
  const risks: LandRisksResult =
    results[0].status === "fulfilled"
      ? results[0].value
      : {
          findings: [],
          checks: [failedCheck("risks", "Géorisques", generatedAt)],
          warnings: ["La source de risques est temporairement indisponible."],
        };
  const rules: LandRulesResult =
    results[1].status === "fulfilled"
      ? results[1].value
      : {
          rules: [],
          checks: [failedCheck("rules", "Règlement écrit", generatedAt)],
          warnings: [
            "La lecture du règlement n’a pas pu aboutir. Consultez les pièces officielles.",
          ],
          completeCoverage: false,
        };
  return {
    version: "land-report-v1",
    generatedAt,
    planning,
    risks,
    rules,
    projects: buildLandProjectAnalyses({ planning, risks, rules }),
  };
}

function failedCheck(key: string, label: string, checkedAt: string): LandSourceCheck {
  return {
    key,
    label,
    checkedAt,
    status: "unavailable",
    scope: "document",
    sourceUrl:
      key === "risks"
        ? "https://www.georisques.gouv.fr/"
        : "https://www.geoportail-urbanisme.gouv.fr/",
    message:
      "La source n’a pas pu être vérifiée. Aucune absence de risque ou de règle n’est déduite.",
  };
}

// Only official property data is cached; authentication and entitlements remain outside this cache.
const cache = new Map<string, { report: LandReport; expiresAt: number }>();
const pending = new Map<string, Promise<LandReport>>();
const MAX_CACHED_REPORTS = 48;

export async function getCachedLandReport(
  input: LandLocationInput,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<LandReport> {
  const key = JSON.stringify(["land-report-v1", input]);
  const entry = cache.get(key);
  if (!refresh && entry && entry.expiresAt > Date.now()) return entry.report;
  const running = pending.get(key);
  if (running) return running;
  const task = buildLandReport(input, { timeoutMs: 8_000 })
    .then((report) => {
      const hasFailure = [
        ...report.planning.checks,
        ...report.risks.checks,
        ...report.rules.checks,
      ].some((check) => check.status === "unavailable");
      cache.delete(key);
      cache.set(key, { report, expiresAt: Date.now() + (hasFailure ? 60_000 : 15 * 60_000) });
      if (cache.size > MAX_CACHED_REPORTS) cache.delete(cache.keys().next().value!);
      return report;
    })
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
