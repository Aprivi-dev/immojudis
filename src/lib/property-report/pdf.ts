import { reportSaleSchedule } from "@/lib/report-sale-schedule";
import { formatDate, formatPrice, formatPricePerM2 } from "@/lib/format";
import { cleanSaleTitle } from "@/lib/sale-title";
import { REPORT_COMPLIANCE_NOTICE } from "@/lib/source-traceability";
import { REPORT_RENTAL_EXPENSE_FIELD_LABELS } from "@/lib/report-simulation";
import { featureUnlocked, sanitizeReportSnapshotForPlan } from "./entitlements";
import { PlanEntitlements, SavedReportRow } from "../property-reports";
import {
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
} from "./serialization";
import { asRecord, numberValue, stringOrNumberValue } from "@/lib/guards";
export const REPORT_PDF_HEADINGS = [
  "Bien",
  "Estimation marché",
  "Transactions DVF retenues",
  "Biens comparables en vente",
  "Historique adresse",
  "Actions comparables",
  "Audit de valorisation",
  "Points estimation à risque",
  "Actions audit estimation",
  "Actions backtest estimation",
  "Lecture opportunité",
  "Scénario locatif personnel",
  "Estimation locative indicative",
  "Enchère plafond",
  "Préparation audience",
  "Actions préparation audience",
  "Analyse de bien",
  "Indices occupation",
  "Actions occupation",
  "Signaux frais",
  "Actions frais",
  "Indices DPE / diagnostics",
  "Actions DPE",
  "Indices travaux / état",
  "Actions travaux",
  "Signaux urbanisme/permis",
  "Contrôles urbanisme manquants",
  "Actions urbanisme/permis",
  "Actions façade/rue",
  "Limites façade/rue",
  "Signaux quartier",
  "Actions quartier",
  "Actions comparables actifs",
  "Revue juridique",
  "Actions juridiques",
  "Actions cadastre",
  "Actions proximité",
  "Signaux démographiques",
  "Données démographiques manquantes",
  "Actions démographie",
  "Sources et traçabilité",
  "Limites",
  "Points d'attention",
  "Notes",
  "Avertissement",
] as const;

export function reportToPdfLines(report: SavedReportRow, plan: PlanEntitlements): string[] {
  const snapshot = sanitizeReportSnapshotForPlan(asRecord(report.report_snapshot), plan);
  const traceability = asRecord(snapshot.sourceTraceability);
  const sourceTrace = normalizeSourceTrace(traceability.entries);
  const limitations = normalizeStringList(traceability.limitations);
  const complianceNotice = stringOrNumberValue(
    traceability.complianceNotice,
    REPORT_COMPLIANCE_NOTICE,
  );
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
  const personalRentalScenario = asRecord(ceiling.personalRentalScenario);
  const personalRentalInputs = asRecord(personalRentalScenario.inputs);
  const personalRentalResult = asRecord(personalRentalScenario.result);
  const hasPersonalRentalScenario =
    Object.keys(personalRentalInputs).length > 0 && Object.keys(personalRentalResult).length > 0;
  const personalRentalHasMissingExpenseMetadata = Object.prototype.hasOwnProperty.call(
    personalRentalInputs,
    "missingExpenseFields",
  );
  const personalRentalMissingExpenseLabels = Array.isArray(
    personalRentalInputs.missingExpenseFields,
  )
    ? personalRentalInputs.missingExpenseFields
        .map((field) =>
          typeof field === "string"
            ? REPORT_RENTAL_EXPENSE_FIELD_LABELS[
                field as keyof typeof REPORT_RENTAL_EXPENSE_FIELD_LABELS
              ]
            : null,
        )
        .filter((field): field is NonNullable<typeof field> => Boolean(field))
    : [];
  const personalRentalExpenseStatus = personalRentalHasMissingExpenseMetadata
    ? personalRentalMissingExpenseLabels.length
      ? `Postes laissés vides, comptés à 0 €: ${personalRentalMissingExpenseLabels.join(", ")}`
      : "Postes de charges à 0 €: valeurs saisies explicitement"
    : "Origine des postes à 0 €: non conservée pour ce rapport antérieur";
  const acquisitionCosts = asRecord(opportunity.acquisitionCosts);
  const legalAttentionPoints = Array.isArray(analysis.legalAttentionPoints)
    ? analysis.legalAttentionPoints
    : [];
  const cadastral = asRecord(analysis.cadastralAnalysis);
  const cadastralReferences = normalizeCadastralReferences(cadastral.références);
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
    `Généré le: ${formatDate(String(snapshot.generatedAt ?? report.updated_at))}`,
    "",
    "Bien",
    `Titre: ${stringOrNumberValue(cleanSaleTitle(stringOrNumberValue(sale.title, null)), report.title)}`,
    `Localisation: ${stringOrNumberValue(sale.displayAddress, null) || [sale.address, sale.city, sale.department].filter(Boolean).join(", ") || "à confirmer"}`,
    `Type: ${stringOrNumberValue(sale.propertyType, "Bien")}`,
    `Surface retenue: ${stringOrNumberValue(sale.surfaceLabel, "à confirmer")}`,
    `Occupation: ${stringOrNumberValue(
      occupancyAnalysis.summary,
      stringOrNumberValue(sale.occupancy, "à vérifier"),
    )}`,
    `Confiance occupation: ${stringOrNumberValue(occupancyAnalysis.confidenceLabel, "à confirmer")}`,
    `Impact occupation: ${stringOrNumberValue(occupancyAnalysis.decisionImpact, "à vérifier avant enchère")}`,
    `Tribunal: ${stringOrNumberValue(sale.tribunal, "à confirmer")}`,
    ...reportSaleSchedule(sale).map(({ label, value }) => `${label}: ${value}`),
    `Préparation audience: ${stringOrNumberValue(audienceReadinessAnalysis.summary, "à compléter")}`,
    `Urgence audience: ${stringOrNumberValue(audienceReadinessAnalysis.urgencyLabel, "date à confirmer")}`,
    `Mise à prix: ${formatPrice(numberValue(sale.startingPrice))}`,
    "",
    "Estimation marché",
    valueEstimate.medianPricePerM2
      ? `Référence médiane: ${formatPricePerM2(numberValue(valueEstimate.medianPricePerM2))}`
      : "Référence médiane: à compléter",
    valueEstimate.p25PricePerM2 && valueEstimate.p75PricePerM2
      ? `Prix des comparables, intervalle P25-P75: ${formatPricePerM2(numberValue(valueEstimate.p25PricePerM2))} - ${formatPricePerM2(
          numberValue(valueEstimate.p75PricePerM2),
        )}`
      : "Prix des comparables, intervalle P25-P75: à compléter",
    `Échantillon: ${stringOrNumberValue(valueEstimate.sampleSize, "0")} vente(s) comparable(s)`,
    `Qualité: ${stringOrNumberValue(valueEstimate.qualityLabel, "fragile")}`,
    market.radiusM ? `Rayon DVF: ${market.radiusM} m` : "Rayon DVF: à compléter",
    `Confiance DVF: ${stringOrNumberValue(marketComparables.confidenceLabel, "à vérifier")}`,
    `Audit estimation: ${stringOrNumberValue(valuationAudit.summary, "audit estimation à construire")}`,
    `Score audit: ${stringOrNumberValue(valuationAudit.score, "0")}/100`,
    `Impact audit: ${stringOrNumberValue(valuationAudit.decisionImpact, "estimation à recouper")}`,
    ...(canShowSoldComparables
      ? [
          `Backtest estimation: ${stringOrNumberValue(
            valuationBacktestSummary.interpretation,
            "backtest DVF à construire",
          )}`,
          `Erreur médiane observée: ${formatPercent(
            valuationBacktestSummary.medianAbsoluteErrorPct,
          )}`,
          `Tests utilisables: ${stringOrNumberValue(valuationBacktestSummary.usableTests, "0")}`,
          `Prédictions à moins de 20%: ${formatPercent(valuationBacktestSummary.within20Pct)}`,
        ]
      : []),
    `Mode comparables: ${stringOrNumberValue(marketComparables.comparableModeLabel, "à compléter")}`,
    `Lecture comparables: ${stringOrNumberValue(marketComparables.summary, "comparables à compléter")}`,
    ...(canShowNeighborhood
      ? [
          `Analyse quartier: ${stringOrNumberValue(neighborhoodAnalysis.summary, "quartier à qualifier")}`,
          `Confiance quartier: ${stringOrNumberValue(neighborhoodAnalysis.confidenceLabel, "à vérifier")}`,
          `Position marché quartier: ${stringOrNumberValue(
            neighborhoodAnalysis.marketPositionLabel,
            "marché local à calculer",
          )}`,
        ]
      : []),
    `Analyse démographique: ${stringOrNumberValue(
      demographicAnalysis.summary,
      "données démographiques à enrichir",
    )}`,
    `Profil démographique: ${stringOrNumberValue(demographicAnalysis.profileLabel, "profil local à enrichir")}`,
    ...(canShowActiveComparables
      ? [
          `Biens comparables actifs: ${stringOrNumberValue(
            activeComparablesAnalysis.summary,
            "aucun comparable actif",
          )}`,
          `Confiance comparables actifs: ${stringOrNumberValue(
            activeComparablesAnalysis.confidenceLabel,
            "à vérifier",
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
      ? ["Points estimation à risque", ...valuationRiskFlags.slice(0, 5).map((flag) => `- ${flag}`)]
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
    "Lecture opportunité",
    `Score du dossier, distinct du scénario personnel: ${opportunity.score != null ? `${opportunity.score}/100 - ${stringOrNumberValue(opportunity.label, "à qualifier")}` : "à compléter"}`,
    `Décote apparente: ${formatPercent(opportunity.apparentDiscountPct)}`,
    opportunity.estimatedMarketValue
      ? `Valeur médiane estimée: ${formatPrice(numberValue(opportunity.estimatedMarketValue))}`
      : "Valeur médiane estimée: à compléter",
    opportunity.estimatedMarketLow && opportunity.estimatedMarketHigh
      ? `${stringOrNumberValue(opportunity.estimatedMarketRangeLabel, "Fourchette de valeur")}: ${formatPrice(numberValue(opportunity.estimatedMarketLow))} - ${formatPrice(
          numberValue(opportunity.estimatedMarketHigh),
        )}`
      : "Fourchette de valeur: à compléter",
    ...(hasPersonalRentalScenario
      ? []
      : [`Rendement brut potentiel: ${formatPercent(opportunity.grossYieldPct)}`]),
    ...(hasPersonalRentalScenario
      ? [
          "Scénario locatif personnel",
          `Coût complet retenu: ${formatPrice(numberValue(personalRentalInputs.acquisitionCost))}`,
          `Loyer hors charges: ${formatPrice(numberValue(personalRentalInputs.monthlyRent))} / mois`,
          `Vacance locative: ${formatPercent(personalRentalInputs.vacancyRatePct)}`,
          personalRentalExpenseStatus,
          `Charges non récupérables: ${formatPrice(numberValue(personalRentalInputs.annualNonRecoverableCharges))} / an`,
          `Taxe foncière: ${formatPrice(numberValue(personalRentalInputs.annualPropertyTax))} / an`,
          `Assurance propriétaire: ${formatPrice(numberValue(personalRentalInputs.annualLandlordInsurance))} / an`,
          personalRentalInputs.monthlyDebtService != null
            ? `Mensualité de financement: ${formatPrice(numberValue(personalRentalInputs.monthlyDebtService))} / mois`
            : "Financement: aucune mensualité saisie",
          `Revenu net d'exploitation avant impôts: ${formatPrice(numberValue(personalRentalResult.annualOperatingIncome))} / an`,
          `Rendement brut du scénario: ${formatPercent(personalRentalResult.grossYieldPct)}`,
          `Rendement net d'exploitation du scénario: ${formatPercent(personalRentalResult.netOperatingYieldPct)}`,
          personalRentalResult.monthlyCashFlow != null
            ? `Cash-flow mensuel avant impôts: ${formatPrice(numberValue(personalRentalResult.monthlyCashFlow))}`
            : "Cash-flow mensuel avant impôts: non calculable sans mensualité de financement",
        ]
      : [
          "Estimation locative indicative",
          "Hypothèses: loyer estimé par défaut et paramètres de vacance, charges, taxe foncière, assurance et financement du modèle.",
          rentabilityScore.score != null
            ? `Score de rentabilite: ${rentabilityScore.score}/100 - ${stringOrNumberValue(rentabilityScore.label, "à qualifier")}`
            : `Score de rentabilite: indisponible (${stringOrNumberValue(rentabilityScore.reason, "données incomplètes")})`,
          rentabilityScore.netYieldPct != null
            ? `Rendement net estime: ${formatPercent(rentabilityScore.netYieldPct)}`
            : "Rendement net estime: à compléter",
          rentabilityScore.cashflowMonthly != null
            ? `Cashflow mensuel estime: ${formatPrice(numberValue(rentabilityScore.cashflowMonthly))}`
            : "Cashflow mensuel estime: à compléter",
        ]),
    `Frais adjudication: ${stringOrNumberValue(
      auctionCostAnalysis.summary,
      "frais et consignation à confirmer",
    )}`,
    `Confiance frais: ${stringOrNumberValue(auctionCostAnalysis.confidenceLabel, "à confirmer")}`,
    consignation.amountEur
      ? `Consignation source: ${formatPrice(numberValue(consignation.amountEur))}`
      : "Consignation source: à confirmer",
    acquisitionCosts.acquisitionFeesTotal
      ? `Frais estimés hors travaux: ${formatPrice(numberValue(acquisitionCosts.acquisitionFeesTotal))}`
      : "Frais estimés hors travaux: à compléter",
    acquisitionCosts.totalCost
      ? `Coût complet ${ceiling.personalSimulation ? "au prix simulé" : "à la mise à prix"}: ${formatPrice(numberValue(acquisitionCosts.totalCost))}`
      : "Coût complet à la mise à prix: à compléter",
    `Travaux / état: ${stringOrNumberValue(renovationAnalysis.summary, "état à qualifier")}`,
    `Priorité travaux: ${stringOrNumberValue(renovationAnalysis.priorityLabel, "à qualifier")}`,
    renovationBudgetRange
      ? `Budget travaux indicatif: ${renovationBudgetRange}`
      : "Budget travaux indicatif: à chiffrer",
    `Impact travaux: ${stringOrNumberValue(
      renovationAnalysis.decisionImpact,
      "état à confirmer avant enchère",
    )}`,
    "",
    "Enchère plafond",
    ...(ceiling.personalSimulation
      ? [
          "Scénario personnel sauvegardé",
          `Scénario: ${stringOrNumberValue(ceiling.scenario, "à confirmer")}`,
          `Travaux saisis: ${formatPrice(numberValue(asRecord(ceiling.personalSimulation).works))}`,
          `Frais préalables saisis: ${formatPrice(numberValue(asRecord(ceiling.personalSimulation).fpt))}`,
          `Prix simulé: ${formatPrice(numberValue(asRecord(ceiling.personalSimulation).price))}`,
          `Marge de sécurité: ${numberValue(ceiling.safetyDiscountPct)} %`,
          `Base retenue: ${stringOrNumberValue(ceiling.basisLabel, "à confirmer")}`,
        ]
      : []),
    ceiling.available
      ? `Mise maximum conseillée: ${formatPrice(numberValue(ceiling.maxBid))}`
      : `Mise maximum conseillée: indisponible (${stringOrNumberValue(ceiling.reason, "données incomplètes")})`,
    ...(ceiling.available &&
    numberValue(ceiling.maxBid) != null &&
    numberValue(sale.startingPrice) != null &&
    (numberValue(ceiling.maxBid) ?? Infinity) < (numberValue(sale.startingPrice) ?? 0)
      ? [
          "Plafond inférieur à la mise à prix : ce scénario ne permet pas d’enchérir au prix de départ.",
        ]
      : []),
    ceiling.targetTotalCost
      ? `Coût complet cible: ${formatPrice(numberValue(ceiling.targetTotalCost))}`
      : "Coût complet cible: à compléter",
    ceiling.marketReferencePricePerM2
      ? `Référence marché retenue: ${formatPricePerM2(numberValue(ceiling.marketReferencePricePerM2))}`
      : "Référence marché retenue: à compléter",
    "",
    "Préparation audience",
    `Synthèse: ${stringOrNumberValue(audienceReadinessAnalysis.summary, "préparation à compléter")}`,
    `Statut: ${stringOrNumberValue(audienceReadinessAnalysis.label, "à vérifier")}`,
    `Progression: ${stringOrNumberValue(audienceReadinessAnalysis.progressPct, "0")} %`,
    `Points prioritaires ouverts: ${stringOrNumberValue(
      audienceReadinessAnalysis.highPriorityOpenCount,
      "0",
    )}`,
    ...(audienceChecklistItems.length
      ? audienceChecklistItems.slice(0, 8).map((item) => `- ${item}`)
      : ["- Checklist à compléter dans le dossier."]),
    ...(audienceReadinessActions.length
      ? [
          "Actions préparation audience",
          ...audienceReadinessActions.slice(0, 4).map((action) => `- ${action}`),
        ]
      : []),
    "",
    "Analyse de bien",
    `Cadastre: ${stringOrNumberValue(
      cadastral.summary,
      cadastral.available ? "repère disponible" : "à connecter ou confirmer",
    )}`,
    `Confiance cadastre: ${stringOrNumberValue(cadastral.confidenceLabel, "à confirmer")}`,
    ...(cadastralReferences.length
      ? [`Référence(s) cadastrale(s): ${cadastralReferences.join(", ")}`]
      : []),
    cadastral.landSurfaceM2
      ? `Surface terrain: ${stringOrNumberValue(cadastral.landSurfaceM2, "")} m²`
      : "Surface terrain: à confirmer",
    `DPE / diagnostics: ${stringOrNumberValue(
      dpe.summary,
      dpe.available ? stringOrNumberValue(dpe.class, "diagnostic repéré") : "à rechercher",
    )}`,
    `Confiance DPE: ${stringOrNumberValue(dpe.confidenceLabel, "à confirmer")}`,
    dpeDiagnostic.diagnosticNumber
      ? `Numéro DPE: ${stringOrNumberValue(dpeDiagnostic.diagnosticNumber, "")}`
      : "Numéro DPE: à confirmer",
    dpe.gesClass
      ? `Classe GES: ${stringOrNumberValue(dpe.gesClass, "")}`
      : "Classe GES: à confirmer",
    dpeDiagnostic.energyConsumptionKwhM2Year
      ? `Conso énergie: ${stringOrNumberValue(dpeDiagnostic.energyConsumptionKwhM2Year, "")} kWhEP/m²/an`
      : "Conso énergie: à confirmer",
    dpeDiagnostic.emissionsKgCo2M2Year
      ? `Émissions GES: ${stringOrNumberValue(dpeDiagnostic.emissionsKgCo2M2Year, "")} kgCO2/m²/an`
      : "Émissions GES: à confirmer",
    `Impact DPE: ${stringOrNumberValue(dpe.impactLabel, "impact à qualifier")}`,
    `Travaux / état: ${stringOrNumberValue(renovationAnalysis.summary, "à qualifier")}`,
    `Confiance travaux: ${stringOrNumberValue(renovationAnalysis.confidenceLabel, "à confirmer")}`,
    ...(canShowUrbanPlanning
      ? [
          `Urbanisme / permis: ${stringOrNumberValue(
            urbanPlanningAnalysis.summary,
            "urbanisme, permis et servitudes à vérifier",
          )}`,
          `Confiance urbanisme: ${stringOrNumberValue(
            urbanPlanningAnalysis.confidenceLabel,
            "à vérifier",
          )}`,
        ]
      : []),
    ...(canShowStreetFacade
      ? [
          `Façade et rue: ${stringOrNumberValue(streetFacadeAnalysis.summary, "localisation à vérifier")}`,
          `Confiance façade/rue: ${stringOrNumberValue(
            streetFacadeAnalysis.confidenceLabel,
            "à confirmer",
          )}`,
          "Cartographie : consulter la localisation sur la fiche annonce. Les vues ne sont pas jointes au rapport.",
        ]
      : []),
    `Services de proximité: ${stringOrNumberValue(
      nearbyServices.summary,
      nearbyServices.available ? "signaux de proximité reperes" : "à qualifier",
    )}`,
    `Confiance proximité: ${stringOrNumberValue(nearbyServices.confidenceLabel, "à confirmer")}`,
    nearbyCategories.length
      ? `Familles de services: ${nearbyCategories.join(", ")}`
      : "Familles de services: à mesurer",
    `Démographie: ${stringOrNumberValue(demographicAnalysis.summary, "données locales à enrichir")}`,
    `Confiance démographie: ${stringOrNumberValue(demographicAnalysis.confidenceLabel, "à vérifier")}`,
    `Demande locale: ${stringOrNumberValue(demographicAnalysis.demandLabel, "demande à qualifier")}`,
    ...(canShowNeighborhood
      ? [
          `Quartier: ${stringOrNumberValue(neighborhoodAnalysis.summary, "à qualifier")}`,
          `Dimensions quartier: ${
            normalizeStringList(neighborhoodAnalysis.dimensions).join(", ") || "à enrichir"
          }`,
        ]
      : []),
    ...(canShowActiveComparables
      ? [
          `Comparables actifs: ${stringOrNumberValue(activeComparablesAnalysis.summary, "à rechercher")}`,
        ]
      : []),
    `Documents: ${stringOrNumberValue(analysis.documentsCount, "0")} pièce(s)`,
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
      ? ["Indices travaux / état", ...renovationEvidence.slice(0, 4).map((item) => `- ${item}`)]
      : []),
    ...(renovationActions.length
      ? ["Actions travaux", ...renovationActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningItems.length
      ? ["Signaux urbanisme/permis", ...urbanPlanningItems.slice(0, 6).map((item) => `- ${item}`)]
      : []),
    ...(canShowUrbanPlanning && urbanPlanningMissingChecks.length
      ? [
          "Contrôles urbanisme manquants",
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
      ? ["Actions façade/rue", ...streetFacadeActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(canShowStreetFacade && streetFacadeLimitations.length
      ? [
          "Limites façade/rue",
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
    `Synthèse: ${stringOrNumberValue(legalAttentionAnalysis.summary, "points juridiques à relire")}`,
    `Niveau: ${stringOrNumberValue(legalAttentionAnalysis.confidenceLabel, "à vérifier")}`,
    ...(legalAttentionItems.length
      ? legalAttentionItems.slice(0, 6).map((item) => `- ${item}`)
      : ["- Relire les pièces officielles avant toute enchère."]),
    ...(legalAttentionActions.length
      ? ["Actions juridiques", ...legalAttentionActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(cadastralNextActions.length
      ? ["Actions cadastre", ...cadastralNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(nearbyNextActions.length
      ? ["Actions proximité", ...nearbyNextActions.slice(0, 3).map((action) => `- ${action}`)]
      : []),
    ...(demographicSignals.length
      ? ["Signaux démographiques", ...demographicSignals.slice(0, 6).map((signal) => `- ${signal}`)]
      : []),
    ...(demographicMissingData.length
      ? [
          "Données démographiques manquantes",
          ...demographicMissingData.slice(0, 4).map((item) => `- ${item}`),
        ]
      : []),
    ...(demographicActions.length
      ? ["Actions démographie", ...demographicActions.slice(0, 4).map((action) => `- ${action}`)]
      : []),
    ...(sourceTrace.length
      ? [
          "",
          "Sources et traçabilité",
          ...sourceTrace.map((entry) =>
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
          ...legalAttentionPoints.map((point) => `- ${stringOrNumberValue(point, "")}`),
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
