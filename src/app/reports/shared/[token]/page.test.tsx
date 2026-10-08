import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SharedReportPage from "./page";
const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/property-reports", () => ({ getSharedPropertyReport: mocks.report }));

async function markup(personal: boolean) {
  mocks.report.mockResolvedValue({
    title: "Rapport de recette",
    updatedAt: "2026-09-09",
    sharedAt: null,
    sale: { startingPrice: 50000 },
    analysis: { opportunity: { acquisitionCosts: { totalCost: 143000 } } },
    sourceTrace: [],
    limitations: [],
    ceiling: {
      available: true,
      maxBid: 244100,
      safetyDiscountPct: 8,
      basisLabel: "Médiane locale",
      ...(personal
        ? {
            personalSimulation: {
              price: 100000,
              works: 31000,
              fpt: 5000,
              scenario: "prudent",
              manualMarketPricePerM2: null,
              expectedMaxBid: 244100,
            },
          }
        : {}),
    },
  });
  return renderToStaticMarkup(
    await SharedReportPage({ params: Promise.resolve({ token: "test" }) }),
  ).replace(/\s/g, "");
}

describe("shared personal simulation", () => {
  it("shows the saved hypotheses and simulated total alongside the same ceiling", async () => {
    const html = await markup(true);
    expect(html).toContain("Scénariopersonnelsauvegardé");
    for (const value of ["100000", "31000", "5000", "143000", "244100"])
      expect(html).toContain(value);
    expect(html).toContain("Coûtcompletauprixsimulé");
    expect(html).toContain("Médianelocale");
  });
  it("does not invent personal inputs for a report without a saved simulation", async () => {
    expect(await markup(false)).not.toContain("Scénariopersonnelsauvegardé");
  });
});

describe("shared report evidence", () => {
  async function evidenceMarkup(evidence: unknown, nextActions: unknown) {
    mocks.report.mockResolvedValue({
      title: "Rapport de preuves",
      updatedAt: "2026-09-09",
      sale: {},
      analysis: Object.fromEntries(
        ["dpe", "occupancyAnalysis", "renovationAnalysis"].map((key) => [
          key,
          { available: true, evidence, nextActions },
        ]),
      ),
      ceiling: {},
      sourceTrace: [],
      limitations: [],
    });
    return renderToStaticMarkup(
      await SharedReportPage({ params: Promise.resolve({ token: "test" }) }),
    );
  }

  it("keeps four evidence entries and three actions in each analysis", async () => {
    const html = await evidenceMarkup(
      Array.from({ length: 6 }, (_, index) => ({
        label: `Preuve ${index}`,
        source: "Document officiel",
        excerpt: `Extrait ${index}`,
      })),
      Array.from({ length: 5 }, (_, index) => `Démarche ${index}`),
    );
    expect(html.match(/<ul /g)).toHaveLength(6);
    expect(html.match(/Preuve 3 · Document officiel · Extrait 3/g)).toHaveLength(3);
    expect(html).not.toContain("Preuve 4");
    expect(html.match(/Démarche 2/g)).toHaveLength(3);
    expect(html).not.toContain("Démarche 3");
  });

  it("omits empty lists when saved evidence is missing or malformed", async () => {
    for (const evidence of [null, {}, [null, false, {}, { label: "   " }]]) {
      expect(await evidenceMarkup(evidence, [null, false, "", "   "])).not.toContain("<ul ");
    }
  });
});
