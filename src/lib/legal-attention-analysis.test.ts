import { describe, expect, it } from "vitest";
import { buildAuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { buildCadastralAnalysis } from "@/lib/cadastre-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildLegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { computeAcquisitionCosts } from "@/lib/profitability";

describe("legal attention analysis", () => {
  it("prioritizes missing major legal documents before bidding", () => {
    const sale = {
      ...EXAMPLE_SALE,
      documents_rich: [],
      source_blocks: null,
      risks: [],
    };
    const analysis = buildLegalAttentionAnalysis({
      sale,
      documents: [],
      risks: [],
      cadastralAnalysis: buildCadastralAnalysis(sale),
      occupancyAnalysis: buildOccupancyAnalysis(sale),
      auctionCostAnalysis: buildAuctionCostAnalysis({
        sale,
        acquisition: computeAcquisitionCosts({ price: sale.starting_price_eur ?? 0 }),
      }),
      hasDiagnostics: false,
    });

    expect(analysis).toMatchObject({
      available: true,
      priority: "high",
      confidenceLabel: "Revue incomplète : pièces majeures manquantes",
    });
    expect(analysis.missingDocuments).toEqual(
      expect.arrayContaining([
        "Cahier des conditions",
        "PV descriptif ou constat",
        "Diagnostics techniques",
        "Plan ou référence cadastrale",
      ]),
    );
  });

  // Relecture juridique du 13/11/2026 : un occupant sans droit ni titre peut demander une
  // procédure distincte, le point reste prioritaire ; un bien occupé autrement est de priorité moyenne.
  it.each([
    ["squatted", "high", "Occupation sans droit ni titre signalée"],
    ["owner_occupied", "medium", "Anticiper délai de libération"],
    ["occupied", "medium", "Anticiper délai de libération"],
  ])(
    "sets the occupation item of a %s sale to %s priority",
    (occupancy_status, priority, reason) => {
      const sale = {
        ...EXAMPLE_SALE,
        occupancy_status,
        description: "Appartement.",
        source_description: null,
        llm_display_description: null,
        about_description: null,
        investment_summary: null,
        risk_notes: null,
        source_blocks: {},
        source_blocks_by_source: {},
        documents_rich: [],
        risks: [],
      };
      const analysis = buildLegalAttentionAnalysis({
        sale,
        documents: [],
        risks: [],
        cadastralAnalysis: buildCadastralAnalysis(sale),
        occupancyAnalysis: buildOccupancyAnalysis(sale),
        auctionCostAnalysis: buildAuctionCostAnalysis({
          sale,
          acquisition: computeAcquisitionCosts({ price: sale.starting_price_eur ?? 0 }),
        }),
        hasDiagnostics: false,
      });
      const item = analysis.items.find((entry) => entry.key === "occupation_risk");
      expect(item?.priority).toBe(priority);
      expect(item?.reason).toContain(reason);
    },
  );

  it("turns sourced risks into prioritized legal attention items", () => {
    const sale = {
      ...EXAMPLE_SALE,
      risks: [
        {
          risk_type: "servitude_access",
          risk_label: "Servitude d'accès à vérifier",
          severity: 3,
          evidence: "Servitude mentionnée dans le cahier des conditions.",
          occurrences: [
            {
              document_label: "Cahier des conditions",
              document_type: "cahier_conditions_vente",
              document_url: "/cahier.pdf",
              excerpt: "Servitude de passage à confirmer.",
              page_number: 8,
              confidence: 0.82,
            },
          ],
        },
      ],
    };
    const analysis = buildLegalAttentionAnalysis({
      sale,
      documents: sale.documents_rich ?? [],
      risks: sale.risks ?? [],
      cadastralAnalysis: buildCadastralAnalysis(sale),
      occupancyAnalysis: buildOccupancyAnalysis(sale),
      auctionCostAnalysis: buildAuctionCostAnalysis({
        sale,
        acquisition: computeAcquisitionCosts({ price: sale.starting_price_eur ?? 0 }),
      }),
      hasDiagnostics: true,
    });

    expect(analysis.priority).toBe("high");
    expect(analysis.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "risk_servitude_access",
          priority: "high",
          source: "Cahier des conditions",
          action: "Contrôler l'impact sur usage, accès et revente.",
        }),
      ]),
    );
  });

  it("keeps completed files in review mode when operational checks remain", () => {
    const sale = {
      ...EXAMPLE_SALE,
      occupancy_status: "free",
      source_blocks: {
        cadastral_section: "AB",
        numero_parcelle: "123",
        consignation: 9_200,
        dpe_classe: "D",
      },
    };
    const analysis = buildLegalAttentionAnalysis({
      sale,
      documents: sale.documents_rich ?? [],
      risks: [],
      cadastralAnalysis: buildCadastralAnalysis(sale),
      occupancyAnalysis: buildOccupancyAnalysis(sale),
      auctionCostAnalysis: buildAuctionCostAnalysis({
        sale,
        acquisition: computeAcquisitionCosts({ price: sale.starting_price_eur ?? 0 }),
      }),
      hasDiagnostics: true,
    });

    expect(analysis.available).toBe(true);
    expect(analysis.missingDocuments).toEqual([]);
    expect(analysis.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "conditions_review" }),
        expect.objectContaining({ key: "cadastre_confirm" }),
      ]),
    );
    expect(analysis.disclaimer).toContain("ne constitue pas un avis juridique");
  });
});
