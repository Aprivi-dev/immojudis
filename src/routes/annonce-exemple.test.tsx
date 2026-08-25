// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: { bien: "bordeaux" as "bordeaux" | "nantes" | "toulouse" },
}));

vi.mock("@/lib/router-compat", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => mocks.search,
  }),
}));

vi.mock("@/components/SimplifiedSaleDetailView", () => ({
  AnalysisSaleDetailView: ({
    sale,
    marketEstimateOverride,
    publicDemo,
    returnTo,
  }: {
    sale: { city: string; title: string };
    marketEstimateOverride: { actionable?: boolean };
    publicDemo?: boolean;
    returnTo?: string;
  }) => (
    <div
      data-testid="example-detail"
      data-city={sale.city}
      data-access={publicDemo ? "public-analysis" : "restricted"}
      data-market={marketEstimateOverride.actionable ? "complete" : "missing"}
      data-return-to={returnTo}
    >
      {sale.title}
    </div>
  ),
}));

import { ExampleSalePage, Route } from "@/routes/annonce-exemple";

describe("ExampleSalePage", () => {
  afterEach(cleanup);

  it.each([
    ["bordeaux", "Bordeaux"],
    ["nantes", "Nantes"],
    ["toulouse", "Toulouse"],
  ] as const)("rend l'exemple %s avec l'analyse publique complète", (bien, city) => {
    mocks.search.bien = bien;
    render(<ExampleSalePage />);

    const detail = screen.getByTestId("example-detail");
    expect(detail.dataset.city).toBe(city);
    expect(detail.dataset.access).toBe("public-analysis");
    expect(detail.dataset.market).toBe("complete");
    expect(detail.dataset.returnTo).toBe("/#exemples");
  });

  it("ignore l'ancien paramètre de limitation et conserve l'analyse complète", () => {
    const validateSearch = Route.validateSearch as (search: Record<string, unknown>) => unknown;

    expect(validateSearch({ offre: "decouverte" })).toEqual({ bien: "bordeaux" });
  });
});
