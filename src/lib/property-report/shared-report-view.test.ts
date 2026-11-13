import { describe, expect, it, vi } from "vitest";
import type { ActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import type { AudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import type { DemographicAnalysis } from "@/lib/demographic-analysis";
import { EXAMPLE_MARKET_ESTIMATE, EXAMPLE_SALE } from "@/lib/example-sale";
import { DEFAULT_OPEN_FEE_REGIMES } from "@/lib/fee-regime-open";
import { formatDate, formatPrice, formatPricePerM2, formatStartingPrice } from "@/lib/format";
import type { LegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { MarketComparablesAnalysis } from "@/lib/market-comparables-analysis";
import type { NeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import type { OccupancyAnalysis } from "@/lib/occupation-analysis";
import type { AuctionSale } from "@/lib/types";
import type { UrbanPlanningItem } from "@/lib/urban-planning-analysis";
import type { ValuationAudit } from "@/lib/valuation-audit";
import { buildCeilingSnapshot } from "./ceiling-snapshot";
import { buildPlanEntitlements } from "./entitlements";
import {
  activeComparableLines,
  audienceChecklistLines,
  demographicSignalLines,
  dpeSourceLabel,
  evidenceLines,
  legalAttentionLines,
  locationQualityLabel,
  marketComparableLines,
  neighborhoodSignalLines,
  renovationPriorityLabel,
  urbanPlanningLines,
  valuationCheckpointLines,
} from "./shared-report-view";

vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: vi.fn() }));

const { buildReportSnapshot } = await import("./analysis");

/** L'analyse telle qu'elle est stockée dans `report_snapshot`, après un aller-retour JSON. */
function storedExampleAnalysis(): Record<string, Record<string, unknown>> {
  const sale = EXAMPLE_SALE as unknown as AuctionSale;
  const snapshot = buildReportSnapshot({
    sale,
    marketEstimate: EXAMPLE_MARKET_ESTIMATE,
    activeComparables: { scopeLabel: "", sales: [] },
    cadastreParcels: [],
    dpeDiagnostics: [],
    urbanPlanningSignals: [],
    valuationBacktest: null,
    ceilingSnapshot: buildCeilingSnapshot(
      sale,
      EXAMPLE_MARKET_ESTIMATE,
      {},
      DEFAULT_OPEN_FEE_REGIMES,
    ),
    plan: buildPlanEntitlements("analyse"),
  });
  return JSON.parse(JSON.stringify(snapshot)).analysis;
}

function firstParts(lines: string[]): string[] {
  return [...new Set(lines.map((line) => line.split(" · ")[0]))].sort();
}

describe("lecture de l'analyse écrite par buildReportSnapshot", () => {
  const analysis = storedExampleAnalysis();

  it("donne une ligne par entrée écrite, sans code interne en tête", () => {
    const lists = [
      [valuationCheckpointLines, analysis.valuationAudit.checkpoints],
      [neighborhoodSignalLines, analysis.neighborhoodAnalysis.signals],
      [demographicSignalLines, analysis.demographicAnalysis.signals],
      [legalAttentionLines, analysis.legalAttentionAnalysis.items],
      [urbanPlanningLines, analysis.urbanPlanningAnalysis.items],
      [audienceChecklistLines, analysis.audienceReadinessAnalysis.checklist],
      [marketComparableLines, analysis.marketComparablesAnalysis.retainedComparables],
      [evidenceLines, analysis.occupancyAnalysis.evidence],
      [evidenceLines, analysis.dpe.evidence],
      [evidenceLines, analysis.renovationAnalysis.evidence],
    ] as const;
    for (const [read, written] of lists) {
      expect(Array.isArray(written) && written.length).toBeTruthy();
      const lines = read(written);
      expect(lines).toHaveLength((written as unknown[]).length);
      for (const line of lines) expect(line.split(" · ")[0]).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("traduit les codes écrits par les modules d'analyse", () => {
    expect(firstParts(valuationCheckpointLines(analysis.valuationAudit.checkpoints))).toEqual([
      "OK",
    ]);
    expect(firstParts(neighborhoodSignalLines(analysis.neighborhoodAnalysis.signals))).toEqual([
      "Atout",
      "À enrichir",
    ]);
    expect(firstParts(demographicSignalLines(analysis.demographicAnalysis.signals))).toEqual([
      "Proxy",
    ]);
    expect(firstParts(urbanPlanningLines(analysis.urbanPlanningAnalysis.items))).toEqual([
      "À vérifier",
    ]);
    expect(urbanPlanningLines(analysis.urbanPlanningAnalysis.items)[0]).toMatch(
      /^À vérifier · À confirmer · /,
    );
    expect(renovationPriorityLabel(analysis.dpe.renovationPriority)).toBe("À calibrer");
    expect(renovationPriorityLabel(analysis.renovationAnalysis.priority)).toBe("À calibrer");
    expect(dpeSourceLabel(analysis.dpe.source)).toBe("Données source");
    expect(locationQualityLabel(analysis.nearbyServices.locationQuality)).toBe(
      "Coordonnées disponibles",
    );
  });
});

describe("lignes du rapport partagé", () => {
  it("écrit une transaction DVF : date, type, prix, prix au m², surface et distance", () => {
    const row = {
      kind: "retained_comparable",
      date: "2025-11-18",
      type: "Appartement",
      surfaceM2: 60.4,
      pricePerM2: 3520,
      totalPriceEur: 211_200,
      distanceM: 83.6,
    } satisfies MarketComparablesAnalysis["retainedComparables"][number];
    expect(marketComparableLines([row])).toEqual([
      [
        formatDate("2025-11-18"),
        "Appartement",
        formatPrice(211_200),
        formatPricePerM2(3520),
        "60 m²",
        "84 m",
      ].join(" · "),
    ]);
    expect(marketComparableLines([{ ...row, date: "", type: "", totalPriceEur: null }])).toEqual([
      ["Bien", formatPricePerM2(3520), "60 m²", "84 m"].join(" · "),
    ]);
  });

  it("écrit un bien comparable en vente, avec sa proximité et une mise à prix à 0 non communiquée", () => {
    const item = {
      id: "comparable",
      title: "Appartement T3",
      city: "Bordeaux",
      department: "33",
      propertyType: "apartment",
      saleDate: "2026-12-01",
      startingPriceEur: 0,
      surfaceM2: 66,
      pricePerM2: 1439,
      investmentScore: 76,
      status: "upcoming",
      matchScore: 82,
      matchLabel: "Très comparable",
      reasons: [],
    } satisfies ActiveComparablesAnalysis["items"][number];
    expect(activeComparableLines([item])).toEqual([
      [
        "Très comparable (82/100)",
        "Appartement T3",
        "Bordeaux",
        formatDate("2026-12-01"),
        formatStartingPrice(0),
        formatPricePerM2(1439),
        "66 m²",
      ].join(" · "),
    ]);
    expect(activeComparableLines([{ matchLabel: "Éloigné" }])).toEqual(["Éloigné · Bien actif"]);
  });

  it("écrit un point d'audit de valorisation avec son action", () => {
    const checkpoint = {
      key: "sample",
      label: "Taille d'échantillon",
      status: "risk",
      detail: "3 vente(s) retenue(s).",
      action: "Élargir le rayon.",
    } satisfies ValuationAudit["checkpoints"][number];
    expect(valuationCheckpointLines([checkpoint])).toEqual([
      "Risque · Taille d'échantillon · 3 vente(s) retenue(s). · Action : Élargir le rayon.",
    ]);
  });

  it("écrit les signaux de quartier et de démographie, statut en tête", () => {
    const neighborhood = {
      kind: "street",
      label: "Façade et rue",
      status: "watch",
      source: "Localisation annonce",
      detail: "Vue 3D disponible.",
    } satisfies NeighborhoodAnalysis["signals"][number];
    expect(neighborhoodSignalLines([neighborhood])).toEqual([
      "À vérifier · Façade et rue · Localisation annonce · Vue 3D disponible.",
    ]);
    const demographic = {
      key: "population",
      kind: "population",
      label: "Population",
      status: "source_signal",
      source: "Description",
      detail: "Commune de 250 000 habitants.",
      impact: "Demande soutenue.",
    } satisfies DemographicAnalysis["signals"][number];
    expect(demographicSignalLines([demographic])).toEqual([
      "Signal source · Population · Description · Commune de 250 000 habitants. · Demande soutenue.",
    ]);
  });

  it("écrit les points juridiques, d'urbanisme et de préparation avec leur priorité", () => {
    const legal = {
      key: "conditions",
      label: "Conditions de vente",
      priority: "high",
      status: "missing",
      source: "Pièces",
      reason: "Cahier des conditions absent.",
      action: "Le demander au greffe.",
    } satisfies LegalAttentionAnalysis["items"][number];
    expect(legalAttentionLines([legal])).toEqual([
      "Prioritaire · Conditions de vente · Cahier des conditions absent. · Action : Le demander au greffe.",
    ]);
    const urban = {
      key: "zoning",
      kind: "zoning",
      label: "Zonage PLU",
      priority: "low",
      status: "documented",
      source: "PLU",
      detail: "Zone UA.",
      action: "",
    } satisfies UrbanPlanningItem;
    expect(urbanPlanningLines([urban])).toEqual([
      "Contrôle · Documenté · Zonage PLU · PLU · Zone UA.",
    ]);
    const audience = {
      key: "visit",
      label: "Visite",
      status: "to_do",
      priority: "medium",
      source: "Annonce",
      detail: "Aucune date.",
      action: "Demander une visite.",
    } satisfies AudienceReadinessAnalysis["checklist"][number];
    expect(audienceChecklistLines([audience])).toEqual([
      "À faire · À vérifier · Visite · Aucune date. · Action : Demander une visite.",
    ]);
  });

  it("écrit un indice sans son statut : libellé, source et extrait", () => {
    const evidence = {
      status: "occupied",
      label: "Occupé",
      excerpt: "Occupé",
      source: "Champ occupation",
    } satisfies OccupancyAnalysis["evidence"][number];
    expect(evidenceLines([evidence])).toEqual(["Occupé · Champ occupation · Occupé"]);
  });
});

describe("rapports anciens ou incomplets", () => {
  it("ignore une liste absente, mal formée ou faite d'entrées vides", () => {
    for (const read of [
      evidenceLines,
      neighborhoodSignalLines,
      demographicSignalLines,
      legalAttentionLines,
      urbanPlanningLines,
      valuationCheckpointLines,
      audienceChecklistLines,
    ]) {
      expect(read(undefined)).toEqual([]);
      expect(read({ label: "pas une liste" })).toEqual([]);
      expect(read([null, false, "texte", {}, { label: "   " }])).toEqual([]);
    }
  });

  it("garde un code inconnu des tables tel quel plutôt que de perdre la ligne", () => {
    expect(valuationCheckpointLines([{ status: "pass", label: "Contrôle" }])).toEqual([
      "pass · Contrôle",
    ]);
    expect(legalAttentionLines([{ priority: "urgent", label: "Point" }])).toEqual([
      "urgent · Point",
    ]);
    expect(neighborhoodSignalLines([{ status: "toString", label: "Signal" }])).toEqual([
      "toString · Signal",
    ]);
  });

  it("dit « À confirmer » pour une priorité, une source ou une localisation inconnue", () => {
    for (const label of [renovationPriorityLabel, dpeSourceLabel, locationQualityLabel]) {
      expect(label(undefined)).toBe("À confirmer");
      expect(label("inconnu")).toBe("À confirmer");
    }
    // Source écrite par `buildDpeAnalysis` quand le diagnostic vient de l'ADEME : pas encore de
    // libellé sur la page partagée.
    expect(dpeSourceLabel("ademe")).toBe("À confirmer");
  });
});
