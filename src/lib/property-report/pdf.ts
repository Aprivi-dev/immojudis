import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { buildActiveComparablesAnalysis } from "@/lib/active-comparables-analysis";
import { buildAudienceReadinessAnalysis } from "@/lib/audience-readiness-analysis";
import { buildAuctionCostAnalysis } from "@/lib/auction-cost-analysis";
import { buildCadastralAnalysis, type StructuredCadastralParcel } from "@/lib/cadastre-analysis";
import { buildDemographicAnalysis } from "@/lib/demographic-analysis";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { normalizeDpeClass, type StructuredDpeDiagnostic } from "@/lib/dpe";
import {
  formatDate,
  formatPrice,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
} from "@/lib/format";
import { getEnvironmentalContext, type EnvironmentalContext } from "@/lib/environment.functions";
import { estimateGrossYieldPct, pricePerM2 } from "@/lib/geo";
import { buildLegalAttentionAnalysis } from "@/lib/legal-attention-analysis";
import type { MarketEstimate } from "@/lib/market.functions";
import { buildMarketComparablesAnalysis } from "@/lib/market-comparables-analysis";
import { buildNearbyServicesAnalysis } from "@/lib/nearby-services";
import { buildNeighborhoodAnalysis } from "@/lib/neighborhood-analysis";
import { buildOccupancyAnalysis } from "@/lib/occupation-analysis";
import { buildRenovationAnalysis } from "@/lib/renovation-analysis";
import { cleanSaleTitle } from "@/lib/sale-title";
import { getPrecomputedMarketEstimate } from "@/lib/sale-market-estimates";
import {
  featureAccess,
  featureIncluded,
  isPlanPeriodActive,
  normalizePlanCode,
  PLAN_LABELS,
  PLAN_LIMITS,
  type FeatureAccess,
  type FeatureKey,
  type PlanCode,
} from "@/lib/plans";
import {
  computeAcquisitionCosts,
  computeRecommendedCeilings,
  computeRentabilityScore,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
} from "@/lib/profitability";
import { createTextPdf } from "@/lib/simple-pdf";
import {
  buildReportTraceability,
  REPORT_COMPLIANCE_NOTICE,
  type SourceTraceEntry,
} from "@/lib/source-traceability";
import { buildStreetFacadeAnalysis } from "@/lib/street-facade-analysis";
import { getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import {
  buildUrbanPlanningAnalysis,
  type StructuredUrbanPlanningSignal,
} from "@/lib/urban-planning-analysis";
import { assertUsageLimitAvailable, recordFeatureUsageEvent } from "@/lib/usage";
import { buildValuationAudit } from "@/lib/valuation-audit";
import {
  buildValuationBacktestForSale,
  type ValuationBacktestResult,
} from "@/lib/valuation-backtest";
import type {
  AuctionSale,
  SaleDocumentRich,
  SaleMedia,
  SaleRisk,
  SaleScoreFactor,
} from "@/lib/types";
import { featureUnlocked, sanitizeReportSnapshotForPlan } from "./entitlements";
import { PlanEntitlements, SavedReportRow } from "../property-reports";
import {
  asRecord,
  formatPercent,
  formatRenovationBudgetRange,
  normalizeActiveComparableItems,
  normalizeAudienceChecklistItems,
  normalizeCadastralReferences,
  normalizeDemographicSignals,
  normalizeDpeEvidence,
  normalizeLegalAttentionItems,
  normalizeMarketComparableRows,
  normalizeNearbyCategoryLabels,
  normalizeNeighborhoodSignals,
  normalizeOccupancyEvidence,
  normalizeRenovationEvidence,
  normalizeSourceTrace,
  normalizeStringList,
  normalizeUrbanPlanningItems,
  normalizeValuationCheckpoints,
  numberValue,
  stringValue,
} from "./serialization";
export function reportToPdfLines(report: SavedReportRow, plan: PlanEntitlements): string[] {
  const snapshot = sanitizeReportSnapshotForPlan(asRecord(report.report_snapshot), plan);
  const traceability = asRecord(snapshot.sourceTraceability);
  const sourceTrace = normalizeSourceTrace(traceability.entries);
  const limitations = normalizeStringList(traceability.limitations);
  const complianceNotice = stringValue(traceability.complianceNotice, REPORT_COMPLIANCE_NOTICE);
  const market = asRecord(report.market_snapshot);
  const ceiling = asRecord(report.ceiling_snapshot);
  const sale = asRecord(snapshot.sale);
  const analysis = asRecord(snapshot.analysis);
  const valueEstimate = asRecord(analysis.valueEstimate);
  const marketComparables = asRecord(analysis.marketComparablesAnalysis);
  const retainedComparables = normalizeMarketComparableRows(marketComparables.retainedComparables);
  const addressHistory = normalizeMarketComparableRows(marketComparables.addressHistory);
  const marketComparablesActions = normalizeStringList(marketComparables.nextActions);
  const valuationAudit = asRecord(analysis.valuationAudit);
  const valuationBacktest = asRecord(analysis.valuationBacktest);
  const valuationBacktestSummary = asRecord(valuationBacktest.summary);
  const valuationBacktestActions = normalizeStringList(valuationBacktest.nextActions);
  const valuationCheckpoints = normalizeValuationCheckpoints(valuationAudit.checkpoints);
  const valuationActions = normalizeStringList(valuationAudit.nextActions);
  const valuationRiskFlags = normalizeStringList(valuationAudit.riskFlags);
  const opportunity = asRecord(analysis.opportunity);
  const rentabilityScore = asRecord(opportunity.rentabilityScore);
  const acquisitionCosts = asRecord(opportunity.acquisitionCosts);
  const legalAttentionPoints = Array.isArray(analysis.legalAttentionPoints)
    ? analysis.legalAttentionPoints
    : [];
  const cadastral = asRecord(analysis.cadastralAnalysis);
  const cadastralReferences = normalizeCadastralReferences(cadastral.references);
  const cadastralNextActions = normalizeStringList(cadastral.nextActions);
  const nearbyServices = asRecord(analysis.nearbyServices);
  const nearbyCategories = normalizeNearbyCategoryLabels(nearbyServices.categories);
  const nearbyNextActions = normalizeStringList(nearbyServices.nextActions);
  const demographicAnalysis = asRecord(analysis.demographicAnalysis);
  const demographicSignals = normalizeDemographicSignals(demographicAnalysis.signals);
  const demographicActions = normalizeStringList(demographicAnalysis.nextActions);
  const demographicMissingData = normalizeStringList(demographicAnalysis.missingData);
  const occupancyAnalysis = asRecord(analysis.occupancyAnalysis);
  const occupancyEvidence = normalizeOccupancyEvidence(occupancyAnalysis.evidence);
  const occupancyNextActions = normalizeStringList(occupancyAnalysis.nextActions);
  const auctionCostAnalysis = asRecord(analysis.auctionCostAnalysis);
  const auctionCostSignals = normalizeStringList(auctionCostAnalysis.sourceFeeSignals);
  const auctionCostActions = normalizeStringList(auctionCostAnalysis.nextActions);
  const consignation = asRecord(auctionCostAnalysis.consignation);
  const legalAttentionAnalysis = asRecord(analysis.legalAttentionAnalysis);
  const legalAttentionItems = normalizeLegalAttentionItems(legalAttentionAnalysis.items);
  const legalAttentionActions = normalizeStringList(legalAttentionAnalysis.nextActions);
  const urbanPlanningAnalysis = asRecord(analysis.urbanPlanningAnalysis);
  const urbanPlanningItems = normalizeUrbanPlanningItems(urbanPlanningAnalysis.items);
  const urbanPlanningActions = normalizeStringList(urbanPlanningAnalysis.nextActions);
  const urbanPlanningMissingChecks = normalizeStringList(urbanPlanningAnalysis.missingChecks);
  const dpe = asRecord(analysis.dpe);
  const dpeDiagnostic = asRecord(dpe.diagnostic);
  const dpeEvidence = normalizeDpeEvidence(dpe.evidence);
  const dpeNextActions = normalizeStringList(dpe.nextActions);
  const renovationAnalysis = asRecord(analysis.renovationAnalysis);
  const renovationEvidence = normalizeRenovationEvidence(renovationAnalysis.evidence);
  const renovationActions = normalizeStringList(renovationAnalysis.nextActions);
  const renovationBudgetRange = formatRenovationBudgetRange(
    asRecord(renovationAnalysis.budgetRange),
  );
  const streetFacadeAnalysis = asRecord(analysis.streetFacadeAnalysis);
  const streetFacadeActions = normalizeStringList(streetFacadeAnalysis.nextActions);
  const streetFacadeLimitations = normalizeStringList(streetFacadeAnalysis.limitations);
  const neighborhoodAnalysis = asRecord(analysis.neighborhoodAnalysis);
  const neighborhoodSignals = normalizeNeighborhoodSignals(neighborhoodAnalysis.signals);
  const neighborhoodActions = normalizeStringList(neighborhoodAnalysis.nextActions);
  const activeComparablesAnalysis = asRecord(analysis.activeComparablesAnalysis);
  const activeComparableItems = normalizeActiveComparableItems(activeComparablesAnalysis.items);
  const activeComparableActions = normalizeStringList(activeComparablesAnalysis.nextActions);
  const audienceReadinessAnalysis = asRecord(analysis.audienceReadinessAnalysis);
  const audienceChecklistItems = normalizeAudienceChecklistItems(
    audienceReadinessAnalysis.checklist,
  );
  const audienceReadinessActions = normalizeStringList(audienceReadinessAnalysis.nextActions);
  const canShowSoldComparables = featureUnlocked(plan.features.soldComparables);
  const canShowSaleHistory = featureUnlocked(plan.features.saleHistory);
  const canShowUrbanPlanning = featureUnlocked(plan.features.urbanPlanning);
  const canShowStreetFacade = featureUnlocked(plan.features.streetFacade);
  const canShowNeighborhood = featureUnlocked(plan.features.neighborhoodAnalysis);
  const canShowActiveComparables = featureUnlocked(plan.features.activeComparables);

  return [
    `Plan: ${plan.label}`,
    `Genere le: ${formatDate(String(snapshot.generatedAt ?? report.updated_at))}`,
    "",
    "Bien",
    `Titre: ${stringValue(cleanSaleTitle(stringValue(sale.title, null)), report.title)}`,
    `Localisation: ${[sale.address, sale.city, sale.department].filter(Boolean).join(", ") || "a confirmer"}`,
    `Type: ${stringValue(sale.propertyType, "Bien")}`,
    `Surface retenue: ${stringValue(sale.surfaceLabel, "a confirmer")}`,
    `Occupation: ${stringValue(
      occupancyAnalysis.summary,
      stringValue(sale.occupancy, "a verifier"),
    )}`,
    `Confiance occupation: ${stringValue(occupancyAnalysis.confidenceLabel, "a confirmer")}`,
    `Impact occupation: ${stringValue(occupancyAnalysis.decisionImpact, "a verifier avant enchere")}`,
    `Tribunal: ${stringValue(sale.tribunal, "a confirmer")}`,
    `Audience: ${formatDate(stringValue(sale.saleDate, null))}`,
    `Preparation audience: ${stringValue(audienceReadinessAnalysis.summary, "a completer")}`,
    `Urgence audience: ${stringValue(audienceReadinessAnalysis.urgencyLabel, "date a confirmer")}`,
    `Mise a prix: ${formatPrice(numberValue(sale.startingPrice))}`,
    "",
    "Estimation marche",
    valueEstimate.medianPricePerM2
      ? `Reference mediane: ${formatPricePerM2(numberValue(valueEstimate.medianPricePerM2))}`
      : "Reference mediane: a completer",
    valueEstimate.p25PricePerM2 && valueEstimate.p75PricePerM2
      ? `Fourchette: ${formatPricePerM2(numberValue(valueEstimate.p25PricePerM2))} - ${formatPricePerM2(
          numberValue(valueEstimate.p75PricePerM2),
        )}`
      : "Fourchette: a completer",
    `Echantillon: ${stringValue(valueEstimate.sampleSize, "0")} vente(s) comparable(s)`,
    `Qualite: ${stringValue(valueEstimate.qualityLabel, "fragile")}`,
    market.radiusM ? `Rayon DVF: ${market.radiusM} m` : "Rayon DVF: a completer",
    `Confiance DVF: ${stringValue(marketComparables.confidenceLabel, "a verifier")}`,
    `Audit estimation: ${stringValue(valuationAudit.summary, "audit estimation a construire")}`,
    `Score audit: ${stringValue(valuationAudit.score, "0")}/100`,
    `Impact audit: ${stringValue(valuationAudit.decisionImpact, "estimation a recouper")}`,
    ...(canShowSoldComparables
      ? [
          `Backtest estimation: ${stringValue(
            valuationBacktestSummary.interpretation,
            "backtest DVF a construire",
          )}`,
          `Erreur mediane observee: ${formatPercent(
            valuationBacktestSummary.medianAbsoluteErrorPct,
          )}`,
          `Tests utilisables: ${stringValue(valuationBacktestSummary.usableTests, "0")}`,
          `Predictions a moins de 20%: ${formatPercent(valuationBacktestSummary.within20Pct)}`,
        ]
      : []),
    `Mode comparables: ${stringValue(marketComparables.comparableModeLabel, "a completer")}`,
    `Lecture comparables: ${stringValue(marketComparables.summary, "comparables a completer")}`,
    ...(canShowNeighborhood
      ? [
          `Analyse quartier: ${stringValue(neighborhoodAnalysis.summary, "quartier a qualifier")}`,
          `Confiance quartier: ${stringValue(neighborhoodAnalysis.confidenceLabel, "a verifier")}`,
          `Position marche quartier: ${stringValue(
            neighborhoodAnalysis.marketPositionLabel,
            "marche local a calculer",
          )}`,
        ]
      : []),
    `Analyse demographique: ${stringValue(
      demographicAnalysis.summary,
      "donnees demographiques a enrichir",
    )}`,
    `Profil demographique: ${stringValue(demographicAnalysis.profileLabel, "profil local a enrichir")}`,
    ...(canShowActiveComparables
      ? [
          `Biens comparables actifs: ${stringValue(
            activeComparablesAnalysis.summary,
            "aucun comparable actif",
          )}`,
          `Confiance comparables actifs: ${stringValue(
            activeComparablesAnalysis.confidenceLabel,
            "a verifier",
          )}`,
        ]
      : []),
    ...(canShowSoldComparables && retainedComparables.length
      ? ["Transactions DVF retenues", ...retainedComparables.slice(0, 5).map((row) => `- ${row}`)]
      : []),
    ...(canShowActiveComparables && activeComparableItems.length
      ? [
          "Biens comparables en vente",
          ...activeComparableItems.slice(0, 5).map((row) => `- ${row}`),
        ]
      : []),
    ...(canShowSaleHistory && addressHistory.length
      ? ["Historique adresse", ...addressHistory.slice(0, 3).map((row) => `- ${row}`)]
      : []),
    ...(marketComparablesActions.length
      ? [
          "Actions comparables",
          ...marketComparablesActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    ...(valuationCheckpoints.length
      ? [
          "Audit de valorisation",
          ...valuationCheckpoints.slice(0, 8).map((checkpoint) => `- ${checkpoint}`),
        ]
      : []),
    ...(valuationRiskFlags.length
      ? ["Points estimation a risque", ...valuationRiskFlags.slice(0, 5).map((flag) => `- ${flag}`)]
      : []),
    ...(valuationActions.length
      ? ["Actions audit estimation", ...valuationActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(canShowSoldComparables && valuationBacktestActions.length
      ? [
          "Actions backtest estimation",
          ...valuationBacktestActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Lecture opportunite",
    `Score: ${opportunity.score != null ? `${opportunity.score}/100 - ${stringValue(opportunity.label, "a qualifier")}` : "a completer"}`,
    `Decote apparente: ${formatPercent(opportunity.apparentDiscountPct)}`,
    opportunity.estimatedMarketValue
      ? `Valeur mediane estimee: ${formatPrice(numberValue(opportunity.estimatedMarketValue))}`
      : "Valeur mediane estimee: a completer",
    opportunity.estimatedMarketLow && opportunity.estimatedMarketHigh
      ? `Fourchette de valeur: ${formatPrice(numberValue(opportunity.estimatedMarketLow))} - ${formatPrice(
          numberValue(opportunity.estimatedMarketHigh),
        )}`
      : "Fourchette de valeur: a completer",
    `Rendement brut potentiel: ${formatPercent(opportunity.grossYieldPct)}`,
    rentabilityScore.score != null
      ? `Score de rentabilite: ${rentabilityScore.score}/100 - ${stringValue(rentabilityScore.label, "a qualifier")}`
      : `Score de rentabilite: indisponible (${stringValue(rentabilityScore.reason, "donnees incompletes")})`,
    rentabilityScore.netYieldPct != null
      ? `Rendement net estime: ${formatPercent(rentabilityScore.netYieldPct)}`
      : "Rendement net estime: a completer",
    rentabilityScore.cashflowMonthly != null
      ? `Cashflow mensuel estime: ${formatPrice(numberValue(rentabilityScore.cashflowMonthly))}`
      : "Cashflow mensuel estime: a completer",
    `Frais adjudication: ${stringValue(
      auctionCostAnalysis.summary,
      "frais et consignation a confirmer",
    )}`,
    `Confiance frais: ${stringValue(auctionCostAnalysis.confidenceLabel, "a confirmer")}`,
    consignation.amountEur
      ? `Consignation source: ${formatPrice(numberValue(consignation.amountEur))}`
      : "Consignation source: a confirmer",
    acquisitionCosts.acquisitionFeesTotal
      ? `Frais estimes hors travaux: ${formatPrice(numberValue(acquisitionCosts.acquisitionFeesTotal))}`
      : "Frais estimes hors travaux: a completer",
    acquisitionCosts.totalCost
      ? `Cout complet a la mise a prix: ${formatPrice(numberValue(acquisitionCosts.totalCost))}`
      : "Cout complet a la mise a prix: a completer",
    `Travaux / etat: ${stringValue(renovationAnalysis.summary, "etat a qualifier")}`,
    `Priorite travaux: ${stringValue(renovationAnalysis.priorityLabel, "a qualifier")}`,
    renovationBudgetRange
      ? `Budget travaux indicatif: ${renovationBudgetRange}`
      : "Budget travaux indicatif: a chiffrer",
    `Impact travaux: ${stringValue(
      renovationAnalysis.decisionImpact,
      "etat a confirmer avant enchere",
    )}`,
    "",
    "Plafond d'enchere",
    ceiling.available
      ? `Mise maximum conseillee: ${formatPrice(numberValue(ceiling.maxBid))}`
      : `Mise maximum conseillee: indisponible (${stringValue(ceiling.reason, "donnees incompletes")})`,
    ceiling.targetTotalCost
      ? `Cout complet cible: ${formatPrice(numberValue(ceiling.targetTotalCost))}`
      : "Cout complet cible: a completer",
    ceiling.marketReferencePricePerM2
      ? `Reference marche retenue: ${formatPricePerM2(numberValue(ceiling.marketReferencePricePerM2))}`
      : "Reference marche retenue: a completer",
    "",
    "Preparation audience",
    `Synthese: ${stringValue(audienceReadinessAnalysis.summary, "preparation a completer")}`,
    `Statut: ${stringValue(audienceReadinessAnalysis.label, "a verifier")}`,
    `Progression: ${stringValue(audienceReadinessAnalysis.progressPct, "0")} %`,
    `Points prioritaires ouverts: ${stringValue(
      audienceReadinessAnalysis.highPriorityOpenCount,
      "0",
    )}`,
    ...(audienceChecklistItems.length
      ? audienceChecklistItems.slice(0, 8).map((item) => `- ${item}`)
      : ["- Checklist a completer dans le dossier."]),
    ...(audienceReadinessActions.length
      ? [
          "Actions preparation audience",
          ...audienceReadinessActions.slice(0, 4).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Analyse de bien",
    `Cadastre: ${stringValue(
      cadastral.summary,
      cadastral.available ? "repere disponible" : "a connecter ou confirmer",
    )}`,
    `Confiance cadastre: ${stringValue(cadastral.confidenceLabel, "a confirmer")}`,
    ...(cadastralReferences.length
      ? [`Reference(s) cadastrale(s): ${cadastralReferences.join(", ")}`]
      : []),
    cadastral.landSurfaceM2
      ? `Surface terrain: ${stringValue(cadastral.landSurfaceM2, "")} m2`
      : "Surface terrain: a confirmer",
    `DPE / diagnostics: ${stringValue(
      dpe.summary,
      dpe.available ? stringValue(dpe.class, "diagnostic repere") : "a rechercher",
    )}`,
    `Confiance DPE: ${stringValue(dpe.confidenceLabel, "a confirmer")}`,
    dpeDiagnostic.diagnosticNumber
      ? `Numero DPE: ${stringValue(dpeDiagnostic.diagnosticNumber, "")}`
      : "Numero DPE: a confirmer",
    dpe.gesClass ? `Classe GES: ${stringValue(dpe.gesClass, "")}` : "Classe GES: a confirmer",
    dpeDiagnostic.energyConsumptionKwhM2Year
      ? `Conso energie: ${stringValue(dpeDiagnostic.energyConsumptionKwhM2Year, "")} kWhEP/m2/an`
      : "Conso energie: a confirmer",
    dpeDiagnostic.emissionsKgCo2M2Year
      ? `Emissions GES: ${stringValue(dpeDiagnostic.emissionsKgCo2M2Year, "")} kgCO2/m2/an`
      : "Emissions GES: a confirmer",
    `Impact DPE: ${stringValue(dpe.impactLabel, "impact a qualifier")}`,
    `Travaux / etat: ${stringValue(renovationAnalysis.summary, "a qualifier")}`,
    `Confiance travaux: ${stringValue(renovationAnalysis.confidenceLabel, "a confirmer")}`,
    ...(canShowUrbanPlanning
      ? [
          `Urbanisme / permis: ${stringValue(
            urbanPlanningAnalysis.summary,
            "urbanisme, permis et servitudes a verifier",
          )}`,
          `Confiance urbanisme: ${stringValue(
            urbanPlanningAnalysis.confidenceLabel,
            "a verifier",
          )}`,
        ]
      : []),
    ...(canShowStreetFacade
      ? [
          `Facade et rue: ${stringValue(streetFacadeAnalysis.summary, "localisation a verifier")}`,
          `Confiance facade/rue: ${stringValue(
            streetFacadeAnalysis.confidenceLabel,
            "a confirmer",
          )}`,
          streetFacadeAnalysis.streetLevelUrl
            ? `Vue rue Mapbox: ${stringValue(streetFacadeAnalysis.streetLevelUrl, "")}`
            : "Vue rue Mapbox: a confirmer",
          streetFacadeAnalysis.aerial3dUrl
            ? `Vue 3D: ${stringValue(streetFacadeAnalysis.aerial3dUrl, "")}`
            : "Vue 3D: a confirmer",
        ]
      : []),
    `Services de proximite: ${stringValue(
      nearbyServices.summary,
      nearbyServices.available ? "signaux de proximite reperes" : "a qualifier",
    )}`,
    `Confiance proximite: ${stringValue(nearbyServices.confidenceLabel, "a confirmer")}`,
    nearbyCategories.length
      ? `Familles de services: ${nearbyCategories.join(", ")}`
      : "Familles de services: a mesurer",
    `Demographie: ${stringValue(demographicAnalysis.summary, "donnees locales a enrichir")}`,
    `Confiance demographie: ${stringValue(demographicAnalysis.confidenceLabel, "a verifier")}`,
    `Demande locale: ${stringValue(demographicAnalysis.demandLabel, "demande a qualifier")}`,
    ...(canShowNeighborhood
      ? [
          `Quartier: ${stringValue(neighborhoodAnalysis.summary, "a qualifier")}`,
          `Dimensions quartier: ${
            normalizeStringList(neighborhoodAnalysis.dimensions).join(", ") || "a enrichir"
          }`,
        ]
      : []),
    ...(canShowActiveComparables
      ? [`Comparables actifs: ${stringValue(activeComparablesAnalysis.summary, "a rechercher")}`]
      : []),
    `Documents: ${stringValue(analysis.documentsCount, "0")} piece(s)`,
    ...(occupancyEvidence.length
      ? ["Indices occupation", ...occupancyEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(occupancyNextActions.length
      ? ["Actions occupation", ...occupancyNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(auctionCostSignals.length
      ? ["Signaux frais", ...auctionCostSignals.slice(0, 4).map((signal) => `- ${signal}`)]
      : []),
    ...(auctionCostActions.length
      ? ["Actions frais", ...auctionCostActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(dpeEvidence.length
      ? ["Indices DPE / diagnostics", ...dpeEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(dpeNextActions.length
      ? ["Actions DPE", ...dpeNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(renovationEvidence.length
      ? ["Indices travaux / etat", ...renovationEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(renovationActions.length
      ? ["Actions travaux", ...renovationActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningItems.length
      ? ["Signaux urbanisme/permis", ...urbanPlanningItems.slice(0, 6).map((item) => `- ${item}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningMissingChecks.length
      ? [
          "Controles urbanisme manquants",
          ...urbanPlanningMissingChecks.slice(0, 4).map((check) => `- ${check}`),
        ]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningActions.length
      ? [
          "Actions urbanisme/permis",
          ...urbanPlanningActions.slice(0, 4).map((action) => `- ${action}`),
        ]
      : []),
    ...(canShowStreetFacade && streetFacadeActions.length
      ? ["Actions facade/rue", ...streetFacadeActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowStreetFacade && streetFacadeLimitations.length
      ? [
          "Limites facade/rue",
          ...streetFacadeLimitations.slice(0, 2).map((limitation) => `- ${limitation}`),
        ]
      : []),
    ...(canShowNeighborhood && neighborhoodSignals.length
      ? ["Signaux quartier", ...neighborhoodSignals.slice(0, 5).map((signal) => `- ${signal}`)]
      : []),
    ...(canShowNeighborhood && neighborhoodActions.length
      ? ["Actions quartier", ...neighborhoodActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowActiveComparables && activeComparableActions.length
      ? [
          "Actions comparables actifs",
          ...activeComparableActions.slice(0, 3).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Revue juridique",
    `Synthese: ${stringValue(legalAttentionAnalysis.summary, "points juridiques a relire")}`,
    `Niveau: ${stringValue(legalAttentionAnalysis.confidenceLabel, "a verifier")}`,
    ...(legalAttentionItems.length
      ? legalAttentionItems.slice(0, 6).map((item) => `- ${item}`)
      : ["- Relire les pieces officielles avant toute enchere."]),
    ...(legalAttentionActions.length
      ? ["Actions juridiques", ...legalAttentionActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(cadastralNextActions.length
      ? ["Actions cadastre", ...cadastralNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(nearbyNextActions.length
      ? ["Actions proximite", ...nearbyNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(demographicSignals.length
      ? ["Signaux demographiques", ...demographicSignals.slice(0, 6).map((signal) => `- ${signal}`)]
      : []),
    ...(demographicMissingData.length
      ? [
          "Donnees demographiques manquantes",
          ...demographicMissingData.slice(0, 4).map((item) => `- ${item}`),
        ]
      : []),
    ...(demographicActions.length
      ? ["Actions demographie", ...demographicActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(sourceTrace.length
      ? [
          "",
          "Sources et tracabilite",
          ...sourceTrace
            .slice(0, 8)
            .map((entry) =>
              [
                `- ${entry.label}`,
                entry.sourceName,
                entry.url ? `URL: ${entry.url}` : null,
                entry.confidenceLabel ? `Confiance: ${entry.confidenceLabel}` : null,
              ]
                .filter(Boolean)
                .join(" | "),
            ),
        ]
      : []),
    ...(limitations.length
      ? ["", "Limites", ...limitations.slice(0, 6).map((limitation) => `- ${limitation}`)]
      : []),
    ...(legalAttentionPoints.length
      ? [
          "",
          "Points d'attention",
          ...legalAttentionPoints.map((point) => `- ${stringValue(point, "")}`),
        ]
      : []),
    "",
    "Notes",
    report.user_notes || "Aucune note utilisateur.",
    "",
    "Avertissement",
    complianceNotice,
  ];
}
