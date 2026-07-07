import { describe, expect, it } from "vitest";
import { buildSalesApiFeedItems, buildSalesCsv } from "@/lib/sale-exports";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";

describe("sales CSV export", () => {
  it("exports stable headers and escapes CSV cells", () => {
    const sale: AuctionSale = {
      ...EXAMPLE_SALE,
      id: "7d335032-e935-4550-9347-ed22b0f63449",
      title: 'Maison, "rare"',
    };

    const csv = buildSalesCsv([sale], "https://app.immojudis.test");

    expect(csv.split("\n")[0]).toContain("mise_a_prix_eur,date_audience,surface_m2");
    expect(csv).toContain('"Maison, ""rare"""');
    expect(csv).toContain("https://app.immojudis.test/sales/7d335032-e935-4550-9347-ed22b0f63449");
  });

  it("builds a light JSON feed item for Analyse API access", () => {
    const sale: AuctionSale = {
      ...EXAMPLE_SALE,
      id: "7d335032-e935-4550-9347-ed22b0f63449",
      title: "Maison judiciaire",
      starting_price_eur: 120_000,
      app_surface_m2: 80,
      source_blocks: { ...EXAMPLE_SALE.source_blocks, dpe_classe: "C" },
    };

    const [item] = buildSalesApiFeedItems([sale], "https://app.immojudis.test");

    expect(item).toMatchObject({
      id: "7d335032-e935-4550-9347-ed22b0f63449",
      title: "Maison judiciaire",
      pricing: {
        startingPriceEur: 120_000,
        pricePerM2: 1_500,
      },
      energy: { dpe: "C" },
      documents: {
        count: 3,
      },
      risks: {
        count: 2,
      },
      opportunity: {
        rentability: {
          score: expect.any(Number),
          netYieldPct: expect.any(Number),
        },
      },
      scoring: {
        version: "demo-2026-06",
      },
      dataQuality: {
        surfaceConfidence: 0.91,
        sourceUpdatedAt: "2026-06-20T10:20:00+02:00",
      },
      source: {
        urls: ["/ressources"],
      },
      compliance: {
        limitations: expect.arrayContaining([
          "Les estimations, scores et rendements sont indicatifs et ne constituent pas une promesse de gain.",
        ]),
      },
      links: {
        immojudis: "https://app.immojudis.test/sales/7d335032-e935-4550-9347-ed22b0f63449",
      },
    });
    expect(item.documents.items).toEqual([
      expect.objectContaining({
        label: "Cahier des conditions de vente - exemple",
        type: "cahier_conditions_vente",
        url: "https://app.immojudis.test/ressources",
      }),
      expect.objectContaining({
        label: "PV descriptif - exemple",
        type: "pv_descriptif",
        url: "https://app.immojudis.test/ressources",
      }),
      expect.objectContaining({
        label: "Diagnostics techniques - exemple",
        type: "diagnostics_techniques",
        url: "https://app.immojudis.test/ressources",
      }),
    ]);
    expect(item.risks.top).toEqual([
      expect.objectContaining({
        type: "occupation_to_confirm",
        sourceDocument: "PV descriptif - exemple",
      }),
      expect.objectContaining({
        type: "works_budget",
        sourceDocument: "Diagnostics techniques - exemple",
      }),
    ]);
    expect(item.scoring.factors).toEqual([
      expect.objectContaining({
        key: "starting_price",
        evidence: "Mise à prix 92 000 EUR pour 42,6 m².",
      }),
      expect.objectContaining({
        key: "occupation",
      }),
    ]);
  });
});
