import { describe, expect, it } from "vitest";
import { buildAuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { computeAcquisitionCosts } from "@/lib/profitability";

describe("auction cost analysis", () => {
  it("combines simulated judicial auction fees with source consignation", () => {
    const acquisition = computeAcquisitionCosts({ price: 120_000, fpt: 3_000 });
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        starting_price_eur: 120_000,
        source_blocks: {
          consignation: 12_000,
          seance_paiement: "Paiement selon cahier des conditions, surenchère sous délai légal.",
        },
      },
      acquisition,
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "costed_with_consignation",
      confidence: "high",
      startingPriceEur: 120_000,
      estimatedFeesEur: Math.round(acquisition.acquisitionFeesTotal),
      consignation: {
        amountEur: 12_000,
        source: "Données source",
      },
    });
    expect(analysis.paymentTerms).toEqual(
      expect.arrayContaining([expect.stringContaining("Paiement selon cahier")]),
    );
  });

  it("detects consignation from source text when no structured field exists", () => {
    const acquisition = computeAcquisitionCosts({ price: 92_000, fpt: 3_000 });
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        source_blocks: null,
        source_blocks_by_source: {
          source: {
            conditions: "Chèque de banque de consignation de 9 200 EUR à remettre avant audience.",
          },
        },
      },
      acquisition,
    });

    expect(analysis.consignation).toMatchObject({
      amountEur: 9_200,
      label: "Consignation",
      source: "Données source source",
    });
    expect(analysis.sourceFeeSignals.length).toBeGreaterThan(0);
  });

  it("keeps source-only fee signals explicit when the starting price is unavailable", () => {
    const analysis = buildAuctionCostAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        starting_price_eur: null,
        source_blocks: null,
        description: "Frais préalables et frais taxés à vérifier dans le cahier des conditions.",
      },
      acquisition: computeAcquisitionCosts({ price: 0 }),
    });

    expect(analysis).toMatchObject({
      available: true,
      status: "source_signals",
      confidence: "low",
      estimatedFeesEur: null,
      totalCostAtStartingPriceEur: null,
    });
    expect(analysis.nextActions).toEqual(
      expect.arrayContaining(["Identifier le montant de consignation exigé avant l'audience."]),
    );
  });
});
