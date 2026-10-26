import { buildCeilingHypotheses } from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan } from "@/lib/bid-ceiling-engine";
import { EXAMPLE_HEARING_LEAD_DAYS, EXAMPLE_SALE_RECORDS } from "@/lib/example-sale";
import { estimateWorksBudget } from "@/lib/profitability";
import {
  EXAMPLE_OCCUPATIONS,
  EXAMPLE_PROJECTS,
  EXAMPLE_WORKS,
  type ExampleScenario,
  type ExampleVerdictData,
} from "@/lib/example-verdict-shared";

export * from "@/lib/example-verdict-shared";

/**
 * Données de la fiche exemple de l'accueil (photo qui analyse, puis « Essayez sur un exemple ») :
 * l'annonce exemple de Bordeaux, ses faits et ses enchères plafond pour chaque projet, occupation et
 * niveau de travaux, calculés par le moteur d'enchère plafond du site (`computeCeilingPlan`), comme
 * sur /annonce-exemple. Rien n'est saisi à la main : les composants de l'accueil reçoivent ces
 * valeurs du rendu serveur.
 */

const MONTH = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" });

let cached: ExampleVerdictData | null = null;

export function exampleVerdictData(): ExampleVerdictData {
  if (cached) return cached;
  const { sale, marketEstimate } = EXAMPLE_SALE_RECORDS.bordeaux;
  const surface = sale.app_surface_m2 ?? 0;
  const startingPrice = sale.starting_price_eur ?? 0;
  const blocks = (sale.source_blocks ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof blocks[key] === "string" ? (blocks[key] as string) : null);

  let registrationRatePct: number | null = null;
  const scenarios: ExampleScenario[] = [];
  for (const project of EXAMPLE_PROJECTS) {
    for (const occupation of EXAMPLE_OCCUPATIONS) {
      for (const works of EXAMPLE_WORKS) {
        const hypotheses = buildCeilingHypotheses(sale, marketEstimate, {
          project,
          occupation,
          works: { key: works, amount: estimateWorksBudget(surface, works) },
        });
        const plan = computeCeilingPlan(hypotheses);
        registrationRatePct ??= plan.feesAtMaxBid?.registrationRate
          ? Math.round(plan.feesAtMaxBid.registrationRate * 10_000) / 100
          : null;
        scenarios.push({
          project,
          occupation,
          works,
          ceiling: plan.maxBid,
          worksTotal: plan.worksTotal,
          releaseCost: plan.releaseCost,
          releaseMonths: hypotheses.occupation.releaseMonths,
          rentedDiscountPct: hypotheses.occupation.rentedDiscountPct,
          marginPct: plan.marginPct,
          binding: plan.binding,
        });
      }
    }
  }

  const history = marketEstimate.addressHistory?.[0];
  const historyDate = history ? new Date(`${history.date}T00:00:00Z`) : null;
  const median = marketEstimate.medianPricePerM2 ?? 0;
  const startingPricePerM2 = surface ? Math.round(startingPrice / surface) : 0;
  const occupationRisk = (sale.risks ?? []).find(
    (risk) => risk.risk_type === "occupation_to_confirm",
  );
  const occupationPage = (occupationRisk?.evidence_json as { page_number?: unknown } | undefined)
    ?.page_number;

  const data: ExampleVerdictData = {
    title: sale.title ?? "",
    // Sans l'indication de largeur destinée à la galerie : `next/image` refuse une image locale
    // avec paramètres sans `images.localPatterns`.
    photo: (sale.media?.[0]?.url ?? "").split("?")[0],
    city: sale.city ?? "",
    surfaceM2: surface,
    floor: text("nb_etages"),
    tribunalName: sale.tribunal_name ?? "",
    hearingInDays: EXAMPLE_HEARING_LEAD_DAYS,
    startingPrice,
    value: marketEstimate.estimatedValueEur ?? 0,
    valueLow: marketEstimate.estimatedValueLowEur ?? 0,
    valueHigh: marketEstimate.estimatedValueHighEur ?? 0,
    estimateQuality: marketEstimate.qualityLabel ?? null,
    comparables: marketEstimate.sampleSize ?? 0,
    radiusM: marketEstimate.radiusM ?? 0,
    yearsBack: marketEstimate.yearsBack ?? 0,
    medianPricePerM2: median,
    sameBuilding:
      history && historyDate
        ? {
            year: historyDate.getUTCFullYear(),
            month: MONTH.format(historyDate),
            totalPrice: history.totalPrice,
            surface: history.surface,
          }
        : null,
    startingPricePerM2,
    startingGapPct: median ? Math.round((1 - startingPricePerM2 / median) * 100) : 0,
    occupationPage: typeof occupationPage === "number" ? occupationPage : null,
    condition: text("etat"),
    dpe: text("dpe_classe"),
    registrationRatePct,
    scenarios,
  };
  cached = data;
  return data;
}
