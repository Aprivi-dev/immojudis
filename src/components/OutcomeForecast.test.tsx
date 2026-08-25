// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildOutcomeGraphRefusal } from "@/lib/outcome-graph";
import { OutcomeForecast, type OutcomeGraphForecastQuery } from "./OutcomeForecast";

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
});
