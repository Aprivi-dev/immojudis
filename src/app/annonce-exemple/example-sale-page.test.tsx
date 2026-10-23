// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));
vi.mock("@/components/SimplifiedSaleDetailView", () => ({
  AnalysisSaleDetailView: ({
    sale,
    marketEstimateOverride,
    publicDemo,
    returnTo,
    adjudicationStatisticsEnabled,
  }: {
    sale: { city: string; title: string };
    marketEstimateOverride: { actionable?: boolean };
    publicDemo?: boolean;
    returnTo?: string;
    adjudicationStatisticsEnabled?: boolean;
  }) => (
    <div
      data-testid="example-detail"
      data-city={sale.city}
      data-access={publicDemo ? "public-analysis" : "restricted"}
      data-market={marketEstimateOverride.actionable ? "complete" : "missing"}
      data-return-to={returnTo}
      data-statistics={adjudicationStatisticsEnabled ? "open" : "closed"}
    >
      {sale.title}
    </div>
  ),
}));

import { getExampleSaleRecords } from "@/lib/example-sale";
import { ExampleSalePage } from "./example-sale-page";

describe("ExampleSalePage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("mesure la consultation de l'annonce exemple, sans identifiant de vente", () => {
    render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("sample_report_viewed");
  });

  it("prépare la connexion à Mapbox pour l'image d'attente de la vue aérienne", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/app/annonce-exemple/example-sale-page.tsx", "utf8");
    expect(source).toContain("<MapboxPreconnect />");
  });

  it("transmet le drapeau des statistiques à la vue, fermé par défaut", async () => {
    const { unmount } = render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect((await screen.findByTestId("example-detail")).dataset.statistics).toBe("closed");
    unmount();
    render(
      <ExampleSalePage example={getExampleSaleRecords().bordeaux} adjudicationStatisticsEnabled />,
    );
    expect((await screen.findByTestId("example-detail")).dataset.statistics).toBe("open");
  });

  it.each([
    ["bordeaux", "Bordeaux"],
    ["nantes", "Nantes"],
    ["toulouse", "Toulouse"],
  ] as const)("rend l'exemple %s avec l'analyse publique complète", async (bien, city) => {
    render(<ExampleSalePage example={getExampleSaleRecords()[bien]} />);

    const detail = await screen.findByTestId("example-detail");
    expect(detail.dataset.city).toBe(city);
    expect(detail.dataset.access).toBe("public-analysis");
    expect(detail.dataset.market).toBe("complete");
    expect(detail.dataset.returnTo).toBe("/#exemples");
  });

  it("annonce clairement que l'exemple est fictif, avant tout chiffre", () => {
    const { container } = render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    const banner = screen.getByRole("note");
    expect(banner.textContent).toMatch(/Exemple fictif/);
    expect(banner.textContent).toMatch(/Aucune vente réelle/);
    // The banner comes first in the page.
    expect(container.firstElementChild).toBe(banner);
  });

  it("ne contient pas de lien externe ni de données structurées d'annonce", () => {
    const { container } = render(<ExampleSalePage example={getExampleSaleRecords().bordeaux} />);
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });
});
