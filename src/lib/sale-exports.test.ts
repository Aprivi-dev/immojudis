import { describe, expect, it } from "vitest";
import { buildSalesApiFeedItems, buildSalesCsv } from "@/lib/sale-exports";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";

describe("sales API feed rents", () => {
  const sale: AuctionSale = {
    ...EXAMPLE_SALE,
    department: "23",
    starting_price_eur: 100_000,
    app_surface_m2: 50,
    app_surface_kind: "habitable",
  };
  const reference = {
    rentPerM2: 12,
    source: "anil_commune" as const,
    reliability: "reliable" as const,
    segment: "apt_all" as const,
    communeCode: "23096",
    lowPerM2: null,
    highPerM2: null,
    observations: 100,
    vintage: 2025,
    sourceUpdatedOn: "2025-12-11",
  };

  it("states the rent behind the yield, with the credit and the source link, for ANIL rents", () => {
    const [item] = buildSalesApiFeedItems([sale], null, () => reference);

    expect(item.opportunity.grossYieldPct).toBeCloseTo(6.2, 1);
    expect(item.opportunity.rentReference).toMatchObject({
      source: "anil_commune",
      reliability: "reliable",
      rentPerM2: 12,
      vintage: 2025,
      sourceUpdatedOn: "2025-12-11",
      attribution: "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.",
      sourceUrl: "https://www.data.gouv.fr/datasets/693aa2feed1bf4da603faa49",
    });
    expect(item.opportunity.rentReference?.attributionDetail).toContain("Licence Ouverte 2.0");
  });

  it("says the yields are gross and charges included for an ANIL rent", () => {
    const [anilItem] = buildSalesApiFeedItems([sale], null, () => reference);
    expect(anilItem.opportunity.rentReference?.chargesIncluded).toBe(true);

    const [departmentItem] = buildSalesApiFeedItems([{ ...sale, department: "33" }], null, () => ({
      rentPerM2: 14,
      source: "department_estimate",
      reliability: "indicative",
    }));
    expect(departmentItem.opportunity.rentReference?.chargesIncluded).toBe(false);
    expect(departmentItem.opportunity.rentReference?.attribution).toBeNull();
  });

  it("gives no yield and no rent reference to a property that is not a dwelling", () => {
    for (const property_type of ["land", "parking", "garage", "local commercial", "building"]) {
      const [item] = buildSalesApiFeedItems(
        [{ ...sale, department: "33", property_type }],
        null,
        () => reference,
      );
      expect(item.opportunity.grossYieldPct, property_type).toBeNull();
      expect(item.opportunity.rentability.score, property_type).toBeNull();
    }
  });

  it("falls back to the department rent without any ANIL credit", () => {
    const [covered] = buildSalesApiFeedItems([{ ...sale, department: "33" }]);
    expect(covered.opportunity.rentReference).toBeNull();
    expect(covered.opportunity.grossYieldPct).not.toBeNull();

    const [uncovered] = buildSalesApiFeedItems([sale]);
    expect(uncovered.opportunity.grossYieldPct).toBeNull();
    expect(uncovered.opportunity.rentReference).toBeNull();
  });
});

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

  it("neutralizes spreadsheet formulas in user and source controlled cells", () => {
    const sale: AuctionSale = {
      ...EXAMPLE_SALE,
      title: '=HYPERLINK("https://example.test","ouvrir")',
      city: "+cmd|' /C calc'!A0",
      address: "@SUM(1+1)",
    };

    const csv = buildSalesCsv([sale]);

    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+cmd|' /C calc'!A0");
    expect(csv).toContain("'@SUM(1+1)");
  });

  it("exports a date-only sale as a day, never as a midnight instant (Petites Affiches)", () => {
    // La date sans heure est stockée à minuit UTC : 01:00 ou 02:00 à Paris, une heure qui n'existe pas.
    const sale: AuctionSale = { ...EXAMPLE_SALE, sale_date: "2026-10-14T00:00:00+00:00" };

    const [item] = buildSalesApiFeedItems([sale], "https://app.immojudis.test");
    const csv = buildSalesCsv([sale]);

    expect(item.audience.saleDate).toBe("2026-10-14");
    expect(item.audience.formattedSaleDate).toBe("14 octobre 2026");
    expect(csv).toContain("14 octobre 2026");
    expect(csv).not.toMatch(/01:00|02:00|T00:00/);
  });

  it("keeps the instant of a sale that has a real hour", () => {
    const sale: AuctionSale = { ...EXAMPLE_SALE, sale_date: "2026-10-15T07:30:00+00:00" };

    const [item] = buildSalesApiFeedItems([sale], "https://app.immojudis.test");

    expect(item.audience.saleDate).toBe("2026-10-15T07:30:00+00:00");
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
        label: "Cahier des conditions de vente - exemple fictif",
        type: "cahier_conditions_vente",
        url: "https://immojudis.com/annonce-exemple#cahier-des-conditions",
      }),
      expect.objectContaining({
        label: "PV descriptif - exemple fictif",
        type: "pv_descriptif",
        url: "https://immojudis.com/annonce-exemple#pv-descriptif",
      }),
      expect.objectContaining({
        label: "Diagnostics techniques - exemple fictif",
        type: "diagnostics_techniques",
        url: "https://immojudis.com/annonce-exemple#diagnostics-techniques",
      }),
    ]);
    expect(item.risks.top).toEqual([
      expect.objectContaining({
        type: "occupation_to_confirm",
        sourceDocument: "PV descriptif - exemple fictif",
      }),
      expect.objectContaining({
        type: "works_budget",
        sourceDocument: "Diagnostics techniques - exemple fictif",
      }),
    ]);
    expect(item.scoring.factors).toEqual([
      expect.objectContaining({
        key: "starting_price",
        evidence: "Mise à prix 95 000 EUR pour 68 m².",
      }),
      expect.objectContaining({
        key: "occupation",
      }),
    ]);
  });
});
