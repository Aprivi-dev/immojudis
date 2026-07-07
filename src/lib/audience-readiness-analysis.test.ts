import { describe, expect, it } from "vitest";
import type { AuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { buildAudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import type { LegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { OccupancyAnalysis } from "@/lib/occupation-analysis";
import type { RenovationAnalysis } from "@/lib/renovation-analysis";
import { EXAMPLE_SALE } from "@/lib/example-sale";

const now = new Date("2026-07-06T12:00:00.000Z");

describe("audience readiness analysis", () => {
  it("marks a sale ready when the key audience controls are present", () => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: EXAMPLE_SALE,
      documents: EXAMPLE_SALE.documents_rich ?? [],
      auctionCostAnalysis: costAnalysis({ withConsignation: true }),
      occupancyAnalysis: occupancyAnalysis("free"),
      renovationAnalysis: renovationAnalysis("light_refresh"),
      legalAttentionAnalysis: legalAttentionAnalysis("low"),
      bidCeilingAvailable: true,
      now,
    });

    expect(analysis).toMatchObject({
      status: "ready",
      urgency: "later",
      progressPct: 100,
      highPriorityOpenCount: 0,
    });
    expect(analysis.checklist.find((item) => item.key === "consignation")).toMatchObject({
      status: "done",
    });
  });

  it("flags urgent preparation when the audience is close and priority controls are open", () => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        sale_date: "2026-07-09T09:00:00+02:00",
        visit_dates: [],
        documents_rich: [],
        occupancy_status: "unknown",
      },
      documents: [],
      auctionCostAnalysis: costAnalysis({ withConsignation: false }),
      occupancyAnalysis: occupancyAnalysis("to_confirm"),
      renovationAnalysis: renovationAnalysis("unknown"),
      legalAttentionAnalysis: legalAttentionAnalysis("high"),
      bidCeilingAvailable: false,
      now,
    });

    expect(analysis).toMatchObject({
      status: "urgent",
      urgency: "week",
      daysUntilAudience: 3,
    });
    expect(analysis.highPriorityOpenCount).toBeGreaterThanOrEqual(4);
    expect(analysis.nextActions[0]).toContain("consignation");
  });

  it("keeps missing audience dates explicit", () => {
    const analysis = buildAudienceReadinessAnalysis({
      sale: {
        ...EXAMPLE_SALE,
        sale_date: null,
      },
      documents: EXAMPLE_SALE.documents_rich ?? [],
      auctionCostAnalysis: costAnalysis({ withConsignation: true }),
      occupancyAnalysis: occupancyAnalysis("free"),
      renovationAnalysis: renovationAnalysis("good"),
      legalAttentionAnalysis: legalAttentionAnalysis("low"),
      bidCeilingAvailable: true,
      now,
    });

    expect(analysis).toMatchObject({
      status: "missing_date",
      urgency: "unknown",
      daysUntilAudience: null,
    });
    expect(analysis.decisionImpact).toContain("date stabilisée");
  });
});

function costAnalysis({ withConsignation }: { withConsignation: boolean }): AuctionCostAnalysis {
  return {
    available: true,
    status: withConsignation ? "costed_with_consignation" : "costed",
    confidence: withConsignation ? "high" : "medium",
    confidenceLabel: withConsignation
      ? "Simulation frais + consignation source"
      : "Simulation frais à la mise à prix",
    startingPriceEur: 92_000,
    estimatedFeesEur: 14_000,
    estimatedFeesPct: 15.2,
    totalCostAtStartingPriceEur: 106_000,
    emolumentsTtcEur: 3_500,
    registrationDutiesEur: 5_800,
    forfaitFraisPoursuiteEur: 3_000,
    consignation: withConsignation
      ? {
          amountEur: 9_200,
          label: "Consignation",
          source: "Données source",
        }
      : null,
    paymentTerms: [],
    sourceFeeSignals: [],
    summary: withConsignation
      ? "frais simulés 14 000 € · consignation repérée 9 200 €."
      : "frais simulés 14 000 €.",
    nextActions: [],
    limitations: [],
  };
}

function occupancyAnalysis(status: OccupancyAnalysis["status"]): OccupancyAnalysis {
  return {
    available: true,
    status,
    label: status,
    confidence: status === "to_confirm" ? "low" : "high",
    confidenceLabel: "Statut test",
    hasLeaseSignal: false,
    hasEvictionSignal: false,
    evidence: [],
    sources: [],
    summary: status === "free" ? "Libre." : "Occupation à confirmer.",
    decisionImpact: "",
    nextActions: ["Confirmer l'occupation exacte dans les pièces."],
    limitations: [],
  };
}

function renovationAnalysis(status: RenovationAnalysis["status"]): RenovationAnalysis {
  return {
    available: status !== "unknown",
    status,
    label: status,
    priority: status === "unknown" ? "unknown" : status === "heavy_works" ? "high" : "medium",
    priorityLabel: "Test",
    budgetLevel: status === "unknown" ? "unknown" : "light",
    confidence: status === "unknown" ? "low" : "medium",
    confidenceLabel: "Signal travaux test",
    budgetRange:
      status === "unknown"
        ? null
        : { lowEur: 6_000, highEur: 15_000, lowPerM2: 150, highPerM2: 350, surfaceM2: 42 },
    evidence: [],
    sources: [],
    summary: status === "unknown" ? "État à qualifier." : "Travaux qualifiés.",
    decisionImpact: "",
    nextActions: ["Reporter l'enveloppe travaux dans le calcul de mise maximale."],
    limitations: [],
  };
}

function legalAttentionAnalysis(
  priority: LegalAttentionAnalysis["priority"],
): LegalAttentionAnalysis {
  return {
    available: true,
    priority,
    confidenceLabel: "Revue test",
    items: [],
    missingDocuments: [],
    summary: priority === "low" ? "Points juridiques contrôlés." : "Points juridiques ouverts.",
    nextActions: ["Relire le cahier des conditions."],
    disclaimer: "Test.",
  };
}
