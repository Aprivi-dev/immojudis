// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import {
  TRIBUNAL_STATISTICS_WARNING,
  tribunalStatisticsResponseSchema,
  type TribunalStatisticsItem,
  type TribunalStatisticsResponse,
} from "@/lib/tribunal-statistics";
import { TribunalStatisticsDashboard } from "./TribunalStatisticsDashboard";

describe("TribunalStatisticsDashboard", () => {
  afterEach(cleanup);

  it("affiche couverture, n par métrique, brut, ajusté et référence nationale séparée", () => {
    renderDashboard(fixture());

    expect(screen.getByRole("heading", { name: "Tribunal judiciaire de Bordeaux" })).toBeTruthy();
    expect(screen.getByText("80 %")).toBeTruthy();
    expect(screen.getAllByText("Observé brut").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Valeur ajustée").length).toBeGreaterThan(0);
    expect(screen.getAllByText("40").length).toBeGreaterThan(0);
    expect(screen.getByText(/Version expérimentale contrôlée/)).toBeTruthy();
    expect(screen.getAllByText(/Inconnues : 10/).length).toBeGreaterThan(0);
    expect(screen.getByText(/5 inconnu\(s\) · 2 exclu\(s\)/)).toBeTruthy();
    expect(screen.getByText(/Mise à prix effective non admissible : 2/)).toBeTruthy();
    expect(screen.queryByText(/effective_starting_price_eur_claim_ineligible/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Référence nationale" })).toBeTruthy();
    expect(screen.getByText(/ne forme aucun classement/i)).toBeTruthy();
    expect(screen.getByText("Qualité variable selon la période.")).toBeTruthy();
  });

  it("filtre les tribunaux et transmet le changement de période", () => {
    const onWindowMonthsChange = vi.fn();
    render(
      <TribunalStatisticsDashboard
        data={fixture()}
        windowMonths={36}
        onWindowMonthsChange={onWindowMonthsChange}
      />,
    );

    const search = screen.getByRole("searchbox", { name: "Rechercher un tribunal" });
    fireEvent.change(search, { target: { value: "paris" } });
    expect(screen.getByRole("heading", { name: "Tribunal judiciaire de Paris" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Bordeaux/ })).toBeNull();

    fireEvent.change(search, { target: { value: "tribunal absent" } });
    expect(screen.getByRole("heading", { name: "Aucun tribunal correspondant" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "12 mois" }));
    expect(onWindowMonthsChange).toHaveBeenCalledWith(12);
  });

  it("traduit le signal de gel incomplet sans exposer son effectif", () => {
    renderDashboard(
      fixture({
        meta: {
          ...verifiedFixture.meta,
          warnings: ["round_not_frozen_at_cutoff"],
        },
      }),
    );

    expect(screen.getByText(/Certaines audiences matures ont été exclues/i)).toBeTruthy();
    expect(screen.queryByText("round_not_frozen_at_cutoff")).toBeNull();
  });

  it("ne mélange pas les issues inconnues avec les observations exclues", () => {
    const flow = {
      ...bordeaux.flow,
      held: {
        ...bordeaux.flow.held,
        unknownCount: 5,
        excludedCount: 5,
        exclusionReasons: { outcome_status_claim_ineligible: 5 },
      },
    };

    renderDashboard(fixture({ tribunals: [{ ...bordeaux, flow }] }));

    const card = screen.getByText("Issues encore inconnues").closest("div");
    expect(card?.textContent).toContain("5");
    expect(card?.textContent).not.toContain("10");
  });

  it("masque les taux locaux sous le seuil de dix observations", () => {
    renderDashboard(
      fixture({
        tribunals: [
          {
            ...bordeaux,
            reliability: {
              ...bordeaux.reliability,
              level: "insufficient_data",
              label: "Données insuffisantes",
              qualityGatePassed: false,
              warnings: [TRIBUNAL_STATISTICS_WARNING.SAMPLE_BELOW_10],
            },
            samples: { ...bordeaux.samples, status: 9 },
            flow: {
              ...bordeaux.flow,
              held: {
                rawValue: null,
                adjustedValue: null,
                numerator: null,
                knownDenominator: null,
                eligibleUniverse: null,
                unknownCount: null,
                excludedCount: null,
                exclusionReasons: {},
                confidenceInterval: null,
                method: "suppressed",
              },
            },
          },
        ],
      }),
    );

    expect(screen.getByRole("heading", { name: "Pas de statistique autonome" })).toBeTruthy();
    expect(screen.getByText(/moins de 10 observations admissibles/i)).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Statistiques de déroulement du tribunal" }),
    ).toBeNull();
  });

  it("distingue un échec de contrôle qualité d’un faible échantillon", () => {
    renderDashboard(
      fixture({
        tribunals: [
          {
            ...bordeaux,
            reliability: {
              ...bordeaux.reliability,
              level: "insufficient_data",
              label: "Contrôle qualité incomplet",
              qualityGatePassed: false,
              warnings: [TRIBUNAL_STATISTICS_WARNING.REVIEW_GATE_FAILED],
            },
          },
        ],
      }),
    );

    expect(
      screen.getByText(/double revue indépendante requise n’est pas encore complète/i),
    ).toBeTruthy();
    expect(screen.queryByText(/moins de 10 observations admissibles/i)).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Statistiques de déroulement du tribunal" }),
    ).toBeNull();
  });

  it("explique un refus dû au gel sans révéler l’effectif privé", () => {
    renderDashboard(
      fixture({
        tribunals: [
          {
            ...bordeaux,
            reliability: {
              ...bordeaux.reliability,
              level: "insufficient_data",
              label: "Gel incomplet",
              qualityGatePassed: false,
              warnings: [TRIBUNAL_STATISTICS_WARNING.FREEZE_COVERAGE_FAILED],
            },
          },
        ],
      }),
    );

    const section = screen
      .getByRole("heading", { name: "Pas de statistique autonome" })
      .closest("section");
    expect(section?.textContent).toMatch(
      /audiences gelées avant la date de référence est insuffisante/i,
    );
    expect(section?.textContent).not.toMatch(/round_not_frozen|\b80\b|:\s*\d+/i);
  });

  it("explique un refus dû à la référence nationale non publiable", () => {
    renderDashboard(
      fixture({
        tribunals: [
          {
            ...bordeaux,
            reliability: {
              ...bordeaux.reliability,
              level: "insufficient_data",
              label: "Parent national indisponible",
              qualityGatePassed: false,
              warnings: [TRIBUNAL_STATISTICS_WARNING.NATIONAL_REFERENCE_UNPUBLISHABLE],
            },
          },
        ],
      }),
    );

    expect(screen.getByText(/référence nationale compatible n’est pas publiable/i)).toBeTruthy();
  });

  it("rend des états de chargement, d’erreur et d’absence de données explicites", () => {
    const { rerender } = render(
      <TribunalStatisticsDashboard
        isLoading
        windowMonths={36}
        onWindowMonthsChange={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Chargement des statistiques par tribunal")).toBeTruthy();

    rerender(
      <TribunalStatisticsDashboard
        error={new Error("relation internal_secrets indisponible")}
        windowMonths={36}
        onWindowMonthsChange={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Les statistiques par tribunal sont temporairement indisponibles",
    );
    expect(screen.getByRole("alert").textContent).not.toContain("internal_secrets");

    rerender(
      <TribunalStatisticsDashboard
        data={fixture({ tribunals: [] })}
        windowMonths={36}
        onWindowMonthsChange={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { name: "Données en consolidation" })).toBeTruthy();
  });

  it("ne présente aucune violation d’accessibilité détectable", async () => {
    const { container } = renderDashboard(fixture());
    const results = await axe(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});

function renderDashboard(data: TribunalStatisticsResponse) {
  return render(
    <TribunalStatisticsDashboard
      data={data}
      windowMonths={36}
      onWindowMonthsChange={() => undefined}
    />,
  );
}

const bordeaux = {
  scope: "tribunal",
  tribunal: {
    code: "TJ-BDX",
    name: "Tribunal judiciaire de Bordeaux",
    judicialRegion: "Nouvelle-Aquitaine",
  },
  roundKind: "initial",
  period: {
    start: "2023-07-01",
    end: "2026-06-30",
    windowMonths: 36,
    knowledgeCutoffAt: "2026-07-31T09:00:00.000Z",
  },
  reliability: {
    level: "descriptive",
    label: "Confiance moyenne",
    qualityGatePassed: true,
    coverage: 0.8,
    warnings: ["Qualité variable selon la période."],
  },
  samples: {
    eligibleRounds: 50,
    status: 40,
    initialPrice: 30,
    effectivePrice: 31,
    marketPrice: 18,
    surenchere: 25,
    resultDelay: 40,
    postponementDelay: 14,
    doubleReviewed: 38,
  },
  flow: {
    held: {
      rawValue: 0.725,
      adjustedValue: 0.7,
      numerator: 29,
      knownDenominator: 40,
      eligibleUniverse: 50,
      unknownCount: 10,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: 0.58, high: 0.82 },
      method: "beta_binomial",
    },
    postponed: {
      rawValue: 0.175,
      adjustedValue: 0.19,
      numerator: 7,
      knownDenominator: 40,
      eligibleUniverse: 50,
      unknownCount: 10,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: 0.1, high: 0.3 },
      method: "beta_binomial",
    },
    cancelled: {
      rawValue: 0.05,
      adjustedValue: 0.06,
      numerator: 2,
      knownDenominator: 40,
      eligibleUniverse: 50,
      unknownCount: 10,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: 0.01, high: 0.14 },
      method: "beta_binomial",
    },
    notRequested: {
      rawValue: 0.05,
      adjustedValue: 0.05,
      numerator: 2,
      knownDenominator: 40,
      eligibleUniverse: 50,
      unknownCount: 10,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: 0.01, high: 0.14 },
      method: "beta_binomial",
    },
    noBidIfHeld: {
      rawValue: 4 / 29,
      adjustedValue: 0.14,
      numerator: 4,
      knownDenominator: 29,
      eligibleUniverse: 29,
      unknownCount: 0,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: 0.04, high: 0.28 },
      method: "beta_binomial",
    },
    adjudicatedIfHeld: {
      rawValue: 25 / 29,
      adjustedValue: 0.86,
      numerator: 25,
      knownDenominator: 29,
      eligibleUniverse: 29,
      unknownCount: 0,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: 0.72, high: 0.96 },
      method: "beta_binomial",
    },
  },
  surenchere: {
    filed: {
      rawValue: 0.16,
      adjustedValue: 0.15,
      numerator: 4,
      knownDenominator: 25,
      eligibleUniverse: 25,
      unknownCount: 0,
      excludedCount: 0,
      exclusionReasons: {},
      confidenceInterval: { low: 0.06, high: 0.33 },
      method: "beta_binomial",
    },
  },
  priceRatios: {
    finalToEffective: {
      raw: { p10: 1.08, p50: 1.42, p90: 2.05 },
      adjusted: { p10: 1.1, p50: 1.39, p90: 1.98 },
      sampleSize: 31,
      eligibleUniverse: 38,
      unknownCount: 5,
      method: "log_shrinkage",
      parentSampleSize: 220,
      excludedCount: 2,
      exclusionReasons: { effective_starting_price_eur_claim_ineligible: 2 },
    },
    finalToInitial: {
      raw: { p10: 1.02, p50: 1.35, p90: 1.82 },
      adjusted: { p10: 1.04, p50: 1.33, p90: 1.78 },
      sampleSize: 30,
      eligibleUniverse: 40,
      unknownCount: 7,
      method: "log_shrinkage",
      parentSampleSize: 220,
      excludedCount: 3,
      exclusionReasons: { initial_starting_price_eur_claim_ineligible: 3 },
    },
    finalToMarket: {
      raw: { p10: 0.48, p50: 0.69, p90: 0.91 },
      adjusted: { p10: 0.5, p50: 0.7, p90: 0.9 },
      sampleSize: 18,
      eligibleUniverse: 50,
      unknownCount: 17,
      method: "log_shrinkage",
      parentSampleSize: 180,
      excludedCount: 15,
      exclusionReasons: { final_hammer_price_claim_ineligible: 15 },
    },
  },
  delays: {
    hearingToKnownResult: {
      raw: { p10: 1, p50: 4, p90: 12 },
      adjusted: { p10: 1, p50: 4, p90: 11 },
      sampleSize: 40,
      eligibleUniverse: 50,
      unknownCount: 10,
      method: "log_shrinkage",
      parentSampleSize: 350,
      excludedCount: 0,
      exclusionReasons: {},
    },
    postponementToNextHearing: {
      raw: { p10: 21, p50: 44, p90: 92 },
      adjusted: { p10: 22, p50: 43, p90: 88 },
      sampleSize: 14,
      eligibleUniverse: 20,
      unknownCount: 5,
      method: "log_shrinkage",
      parentSampleSize: 210,
      excludedCount: 1,
      exclusionReasons: { result_observed_at_claim_ineligible: 1 },
    },
  },
  fallback: {
    scope: "national",
    parentLabel: "France entière",
    localWeight: 0.67,
  },
  methodology: {
    builderVersion: "tribunal_statistics_builder_v1",
    eligibilityRuleVersion: "claim_ab_reviewed_frozen_round_as_of_v1",
    smoothingRuleVersion: "jeffreys_beta_log_shrinkage_v1",
  },
  limitations: ["Les fréquences observées ne prédisent pas une audience individuelle."],
} satisfies TribunalStatisticsItem;

const paris = {
  ...bordeaux,
  tribunal: {
    code: "TJ-PAR",
    name: "Tribunal judiciaire de Paris",
    judicialRegion: "Île-de-France",
  },
} satisfies TribunalStatisticsItem;

const national = {
  ...bordeaux,
  scope: "national",
  tribunal: null,
  priceRatios: {
    finalToEffective: {
      ...bordeaux.priceRatios.finalToEffective,
      method: "raw",
      parentSampleSize: 0,
    },
    finalToInitial: {
      ...bordeaux.priceRatios.finalToInitial,
      method: "raw",
      parentSampleSize: 0,
    },
    finalToMarket: {
      sampleSize: null,
      eligibleUniverse: null,
      unknownCount: null,
      raw: null,
      adjusted: null,
      method: "suppressed",
      parentSampleSize: null,
      excludedCount: null,
      exclusionReasons: {},
    },
  },
  delays: {
    hearingToKnownResult: {
      ...bordeaux.delays.hearingToKnownResult,
      method: "raw",
      parentSampleSize: 0,
    },
    postponementToNextHearing: {
      sampleSize: null,
      eligibleUniverse: null,
      unknownCount: null,
      raw: null,
      adjusted: null,
      method: "suppressed",
      parentSampleSize: null,
      excludedCount: null,
      exclusionReasons: {},
    },
  },
  fallback: { scope: "none", parentLabel: null, localWeight: 1 },
} satisfies TribunalStatisticsItem;

const verifiedFixture = tribunalStatisticsResponseSchema.parse({
  meta: {
    generatedAt: "2026-07-31T10:00:00.000Z",
    experimental: true,
    windowMonths: 36,
    roundKind: "initial",
    warnings: ["Les données ne garantissent pas le résultat d’une audience future."],
  },
  tribunals: [bordeaux, paris],
  national,
});

function fixture(overrides: Record<string, unknown> = {}): TribunalStatisticsResponse {
  return {
    ...verifiedFixture,
    ...overrides,
  } as TribunalStatisticsResponse;
}
