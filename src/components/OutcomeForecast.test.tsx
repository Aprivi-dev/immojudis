// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBaselineOutcomeGraph,
  buildOutcomeGraphRefusal,
  type OutcomeGraphCohort,
} from "@/lib/outcome-graph";
import type { OutcomeGraphForecastQuery } from "@/hooks/use-outcome-graph-forecast";
import { OutcomeForecast } from "./OutcomeForecast";

describe("OutcomeForecast", () => {
  afterEach(cleanup);

  it("ne publie aucune rubrique lorsqu'aucune prévision vérifiée n'existe", () => {
    const forecast = buildOutcomeGraphRefusal(
      {
        saleId: "00000000-0000-4000-8000-000000000001",
        startingPriceCents: 10_000_000,
        marketValueCents: null,
      },
      "Aucune prévision vérifiée n'est disponible pour cette audience.",
    );
    const forecastQuery = {
      data: { forecast },
    } as unknown as OutcomeGraphForecastQuery;

    const { container } = render(<OutcomeForecast forecastQuery={forecastQuery} />);

    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("Données en consolidation")).toBeNull();
  });

  describe("prévision prête (n° 25)", () => {
    const context = {
      saleId: "00000000-0000-4000-8000-000000000001",
      roundId: "00000000-0000-4000-8000-000000000002",
      startingPriceCents: 9_000_000,
      effectiveStartingPriceCents: 9_000_000,
      marketValueCents: 17_200_000,
      ceilingCents: 15_100_200,
      generatedAt: "2026-07-29T12:00:00.000Z",
      horizon: "T-7" as const,
      modelVersion: "cohort_baseline_v1",
    };
    const cohort: OutcomeGraphCohort = {
      id: "00000000-0000-4000-8000-000000000003",
      label: "National · appartement · saisie immobilière",
      level: "national_property_type",
      sampleSize: 47,
      tribunalSampleSize: 19,
      periodStart: "2024-01-01T00:00:00.000Z",
      periodEnd: "2026-06-30T23:59:59.000Z",
      trainingEligible: true,
      hasBlockingConflict: false,
      flow: {
        heldProbability: 0.88,
        postponedProbability: 0.08,
        cancelledOrNotRequestedProbability: 0.04,
        adjudicatedIfHeldProbability: 0.91,
        noBidIfHeldProbability: 0.09,
      },
      initialPriceRatios: { p10: 1.3667, p50: 1.6222, p90: 1.9889 },
      finalPriceRatios: { p10: 1.4, p50: 1.6778, p90: 2.0889 },
      surenchereProbability: 0.1,
      pressure: {
        qualifiedDemandScore: 72,
        historyScore: 64,
        liquidityScore: 81,
        attractivenessScore: 69,
      },
      delays: {
        heldWithin30DaysProbability: 0.71,
        heldWithin60DaysProbability: 0.9,
        resultKnownWithin48HoursProbability: 0.78,
        finalityKnownWithin15DaysProbability: 0.83,
        newRoundWithin4MonthsAfterSurenchereProbability: 0.66,
      },
    };

    function renderReady() {
      const forecast = buildBaselineOutcomeGraph(context, cohort);
      expect(forecast.status).toBe("ready");
      const forecastQuery = { data: { forecast } } as unknown as OutcomeGraphForecastQuery;
      return render(<OutcomeForecast forecastQuery={forecastQuery} />);
    }

    const plain = (text: string | null) => (text ?? "").replace(/[\u00a0\u202f]/g, " ");

    it("annonce la probabilité du plafond arrondie à 5 % avec « environ »", () => {
      const { container } = renderReady();
      const text = plain(container.textContent);
      // Plafond = médiane du prix définitif : 50 % exactement, dit « environ 50 % ».
      expect(text).toContain("environ 50 %");
      expect(text).toContain("Arrondie à 5 % près");
      // Aucun pourcentage de probabilité à l'unité ne reste affiché (88 % devient « environ 90 % »).
      expect(text).not.toMatch(/\b88 %|\b91 %/);
      expect(text).toContain("environ 90 %");
    });

    it("ne force pas la largeur du graphique et titre ses axes", () => {
      const { container } = renderReady();
      expect(container.innerHTML).not.toContain("min-w-[540px]");
      const text = plain(container.textContent);
      expect(text).toContain("Probabilité cumulée");
      expect(text).toContain("Prix définitif, en euros");
    });

    it("trace la courbe en plein entre P10 et P90 seulement", () => {
      const { container } = renderReady();
      const curve = container.querySelector("polyline")!;
      const xs = curve
        .getAttribute("points")!
        .split(" ")
        .map((point) => Number(point.split(",")[0]));
      const ys = curve
        .getAttribute("points")!
        .split(" ")
        .map((point) => Number(point.split(",")[1]));
      // Du repère 10 % au repère 90 % : la courbe ne part pas de 0 % et n'arrive pas à 100 %.
      const svgHeight = 320;
      const plotTop = 16;
      const plotBottom = svgHeight - 74;
      const plotHeight = plotBottom - plotTop;
      expect(ys[0]).toBeCloseTo(plotTop + 0.9 * plotHeight, 0);
      expect(ys[ys.length - 1]).toBeCloseTo(plotTop + 0.1 * plotHeight, 0);
      expect(xs[0]).toBeGreaterThan(62);
      expect(xs[xs.length - 1]).toBeLessThan(480 - 16);
      expect(ys).toEqual([...ys].sort((a, b) => b - a));
    });

    it("place les repères sur une échelle en euros, la médiane n'est pas toujours au centre", () => {
      const { container } = renderReady();
      const markers = Array.from(container.querySelectorAll<HTMLElement>("span.absolute"))
        .map((node) => node.style.left)
        .filter((left) => left.endsWith("%"))
        .map((left) => Number.parseFloat(left));
      expect(markers.length).toBeGreaterThanOrEqual(6);
      const medianPositions = markers.filter((left) => Math.abs(left - 50) < 0.05);
      expect(medianPositions).toHaveLength(0);
      // Ni 5 % / 50 % / 95 % ni 28 % / 72 % codés en dur.
      expect(markers).not.toContain(5);
      expect(markers).not.toContain(95);
    });

    it("n'affirme qu'une borne quand le plafond sort de la plage estimée", () => {
      const { container } = renderReady();
      const input = screen.getByLabelText("Votre plafond");
      fireEvent.change(input, { target: { value: "400000" } });
      const high = plain(container.textContent);
      expect(high).toContain("au moins environ 90 %");
      expect(high).toContain("hors de la plage estimée");
      expect(high).not.toContain("99 %");

      fireEvent.change(input, { target: { value: "50000" } });
      const low = plain(container.textContent);
      expect(low).toContain("au plus environ 10 %");
      expect(low).not.toContain("1 %");
    });
  });
});
