import { redactPersonalData, redactPersonalText } from "@/lib/personal-data-filter";
import { reportSaleSchedule } from "@/lib/report-sale-schedule";
import { formatDate, formatPrice, formatPricePerM2, formatStartingPrice } from "@/lib/format";
import { cleanSaleTitle } from "@/lib/sale-title";
import { REPORT_COMPLIANCE_NOTICE } from "@/lib/source-traceability";
import {
  describeReportSimulation,
  REPORT_RENTAL_EXPENSE_FIELD_LABELS,
} from "@/lib/report-simulation";
import { PROPERTY_TAX_NOT_COUNTED } from "@/lib/bid-ceiling-engine";
import { DEFAULT_OPEN_FEE_REGIMES, type FeeRegimeKey } from "@/lib/fee-regime-open";
import { analysisForOpenRegimes, ceilingForOpenRegimes } from "./ceiling-switch";
import { sanitizeReportSnapshotForPlan } from "./entitlements";
import { reportWording } from "./report-wording";
import { RENT_SOURCE_URL, rentSourceNotice } from "@/lib/rent-source-notice";
import { reportRentReference } from "./rent-notice";
import {
  FINANCING_DOSSIER_HEADINGS,
  FINANCING_NOT_PROVIDED,
  financingDossierLines,
} from "./financing-dossier";
import type { SavedReportRow } from "../property-reports";
import { featureIncluded, type PlanEntitlements } from "@/lib/plans";
import {
  formatPercent as formatKnownPercent,
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
  opportunityScoreLabel,
} from "./serialization";
import { asRecord, numberValue, stringOrNumberValue } from "@/lib/guards";
import { rentabilityLabel } from "@/lib/profitability";
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
  "Enchère plafond (simulation)",
  "Offre plafond (simulation)",
  "Préparation audience",
  "Actions préparation audience",
  "Préparation de la vente",
  "Actions de préparation de la vente",
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
  // Intertitre du dossier de financement d'une vente par offres (voir `reportWording`).
  "Garantie à remettre avant votre offre",
  ...FINANCING_DOSSIER_HEADINGS,
] as const;

/**
 * Une valeur absente du rapport s'écrit « non renseigné », jamais « null % », « 0/100 » ou
 * « Prix non communiqué / mois » : un 0 imprimé se lit comme une mesure. Un 0 réel reste un 0.
 */
const NOT_PROVIDED = FINANCING_NOT_PROVIDED;

function formatPercent(value: unknown): string {
  return numberValue(value) != null ? formatKnownPercent(value) : NOT_PROVIDED;
}

/** Montant en euros, avec son unité (« / mois », « / an »), ou « non renseigné ». */
function formatAmount(value: unknown, unit = ""): string {
  const amount = numberValue(value);
  return amount != null ? `${formatPrice(amount)}${unit}` : NOT_PROVIDED;
}

/** Nombre entier ou texte du rapport suivi d'un suffixe (« /100 », « % »), ou « non renseigné ». */
function formatCount(value: unknown, suffix = ""): string {
  const text = stringOrNumberValue(value, "");
  return text ? `${text}${suffix}` : NOT_PROVIDED;
}

/** Ligne « libellé: valeur », ou aucune ligne quand la valeur manque. */
function lineIfProvided(label: string, value: string | null): string[] {
  return value ? [`${label}: ${value}`] : [];
}

export function reportToPdfLines(
  report: SavedReportRow,
  plan: PlanEntitlements,
  /** Régimes de frais ouverts (`openFeeRegimesFromEnv`) ; absent : tous ceux qui sont définis. */
  regimes: readonly FeeRegimeKey[] = DEFAULT_OPEN_FEE_REGIMES,
): string[] {
  // Un rapport enregistré avant le durcissement du filtre peut encore porter un nom de particulier :
  // le PDF refiltre à la lecture, comme le lien partagé.
  const snapshot = redactPersonalData(
    sanitizeReportSnapshotForPlan(asRecord(report.report_snapshot), plan),
  );
  const traceability = asRecord(snapshot.sourceTraceability);
  const sourceTrace = normalizeSourceTrace(traceability.entries);
  const limitations = normalizeStringList(traceability.limitations);
  const complianceNotice = stringOrNumberValue(
    traceability.complianceNotice,
    REPORT_COMPLIANCE_NOTICE,
  );
  const market = asRecord(report.market_snapshot);
  const savedCeiling = asRecord(report.ceiling_snapshot);
  // Régime fermé depuis l'enregistrement du rapport : plafond indisponible, montants masqués.
  const ceiling = ceilingForOpenRegimes(savedCeiling, regimes);
  // Vocabulaire du régime du plafond : « mise à prix » et « enchère », ou « première offre » et
  // « offre » pour une vente notariale interactive.
  const wording = reportWording(ceiling.regime);
  // « Enchère plafond (simulation) » ou « Offre plafond (simulation) » (vente notariale interactive).
  const ceilingLabel = stringOrNumberValue(ceiling.label, wording.ceilingLabel);
  const sale = asRecord(snapshot.sale);
  const analysis = analysisForOpenRegimes(asRecord(snapshot.analysis), savedCeiling, regimes);
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
  // Libellés recalculés depuis le score : un rapport enregistré avant le 08/11/2026 porte encore
  // « Très rentable à confirmer » ou « Très favorable » dans son instantané.
  const opportunityScore = numberValue(opportunity.score);
  const rentabilityScoreValue = numberValue(rentabilityScore.score);
  const rentNotice = rentSourceNotice(reportRentReference(opportunity.rentReference));
  const personalRentalScenario = asRecord(ceiling.personalRentalScenario);
  const personalSimulation = describeReportSimulation(ceiling.personalSimulation);
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
  // Une étape sans montant ne s'écrit pas : « - 0 € » se lirait comme un calcul sans effet.
  const calculationSteps = (Array.isArray(ceiling.steps) ? ceiling.steps : []).flatMap((step) => {
    const item = asRecord(step);
    const amount = numberValue(item.amount);
    if (amount == null) return [];
    const sign = item.kind === "minus" ? "- " : item.kind === "add" ? "+ " : "";
    return [`  ${stringOrNumberValue(item.label, "")} : ${sign}${formatPrice(Math.abs(amount))}`];
  });
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
  const canShowSoldComparables = featureIncluded(plan.plan, "property.soldComparables");
  const canShowSaleHistory = featureIncluded(plan.plan, "property.saleHistory");
  const canShowUrbanPlanning = featureIncluded(plan.plan, "property.urbanPlanning");
  const canShowStreetFacade = featureIncluded(plan.plan, "property.streetFacade");
  const canShowNeighborhood = featureIncluded(plan.plan, "property.neighborhoodAnalysis");
  const canShowActiveComparables = featureIncluded(plan.plan, "property.activeComparables");

  return [
    `Plan: ${plan.label}`,
    `Généré le: ${formatDate(String(snapshot.generatedAt ?? report.updated_at))}`,
    "",
    "Bien",
    `Titre: ${stringOrNumberValue(cleanSaleTitle(stringOrNumberValue(sale.title, null)), redactPersonalText(report.title))}`,
    `Localisation: ${stringOrNumberValue(sale.displayAddress, null) || [sale.address, sale.city, sale.department].filter(Boolean).join(", ") || "à confirmer"}`,
    `Type: ${stringOrNumberValue(sale.propertyType, "Bien")}`,
    `Surface retenue: ${stringOrNumberValue(sale.surfaceLabel, "à confirmer")}`,
    `Occupation: ${stringOrNumberValue(
      occupancyAnalysis.summary,
      stringOrNumberValue(sale.occupancy, "à vérifier"),
    )}`,
    `Confiance occupation: ${stringOrNumberValue(occupancyAnalysis.confidenceLabel, "à confirmer")}`,
    `Impact occupation: ${stringOrNumberValue(occupancyAnalysis.decisionImpact, `à vérifier ${wording.beforeBid}`)}`,
    `${wording.venueLabel}: ${stringOrNumberValue(sale.tribunal, "à confirmer")}`,
    ...reportSaleSchedule(sale).map(({ label, value }) => `${label}: ${value}`),
    `${wording.audiencePreparation}: ${stringOrNumberValue(audienceReadinessAnalysis.summary, "à compléter")}`,
    `${wording.audienceUrgency}: ${stringOrNumberValue(audienceReadinessAnalysis.urgencyLabel, "date à confirmer")}`,
    `${wording.referencePrice}: ${formatStartingPrice(numberValue(sale.startingPrice))}`,
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
    `Score audit: ${formatCount(valuationAudit.score, "/100")}`,
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
          `Tests utilisables: ${formatCount(valuationBacktestSummary.usableTests)}`,
          `Prédictions à moins de 20%: ${formatPercent(valuationBacktestSummary.within20Pct)}`,
        ]
      : []),
    `Mode comparables: ${stringOrNumberValue(marketComparables.comparableModeLabel, "à compléter")}`,
    `Lecture comparables: ${stringOrNumberValue(marketComparables.summary, "comparables à compléter")}`,
    ...(canShowNeighborhood
      ? [
          `Analyse quartier : ${stringOrNumberValue(neighborhoodAnalysis.summary, "quartier à qualifier")}`,
          `Confiance quartier: ${stringOrNumberValue(neighborhoodAnalysis.confidenceLabel, "à vérifier")}`,
          `Position marché quartier: ${stringOrNumberValue(
            neighborhoodAnalysis.marketPositionLabel,
            "marché local à calculer",
          )}`,
        ]
      : []),
    `Analyse démographique : ${stringOrNumberValue(
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
    `Score du dossier, distinct du scénario personnel: ${opportunityScore != null ? `${opportunityScore}/100 - ${opportunityScoreLabel(opportunityScore)}` : "à compléter"}`,
    // Écart absent : la phrase de la fiche (bien occupé, écart non significatif) plutôt qu'un tiret.
    `Décote apparente: ${
      numberValue(opportunity.apparentDiscountPct) != null
        ? formatPercent(opportunity.apparentDiscountPct)
        : stringOrNumberValue(opportunity.apparentDiscountNote, NOT_PROVIDED)
    }`,
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
      : [
          `${rentNotice ? "Rendement brut potentiel, charges comprises" : "Rendement brut potentiel"}: ${formatPercent(opportunity.grossYieldPct)}`,
        ]),
    // Mention de la carte des loyers de l'ANIL, avec le lien vers la source : obligatoire avec le rendement.
    ...(rentNotice && !hasPersonalRentalScenario
      ? [rentNotice, `Source : ${RENT_SOURCE_URL}`]
      : []),
    ...(hasPersonalRentalScenario
      ? [
          "Scénario locatif personnel",
          `Coût complet retenu: ${formatAmount(personalRentalInputs.acquisitionCost)}`,
          `Loyer hors charges: ${formatAmount(personalRentalInputs.monthlyRent, " / mois")}`,
          `Vacance locative: ${formatPercent(personalRentalInputs.vacancyRatePct)}`,
          personalRentalExpenseStatus,
          `Charges non récupérables: ${formatAmount(personalRentalInputs.annualNonRecoverableCharges, " / an")}`,
          `Taxe foncière: ${formatAmount(personalRentalInputs.annualPropertyTax, " / an")}`,
          `Assurance propriétaire: ${formatAmount(personalRentalInputs.annualLandlordInsurance, " / an")}`,
          numberValue(personalRentalInputs.monthlyDebtService) != null
            ? `Mensualité de financement: ${formatAmount(personalRentalInputs.monthlyDebtService, " / mois")}`
            : "Financement: aucune mensualité saisie",
          `Revenu net d'exploitation avant impôts: ${formatAmount(personalRentalResult.annualOperatingIncome, " / an")}`,
          `Rendement brut du scénario: ${formatPercent(personalRentalResult.grossYieldPct)}`,
          `Rendement net d'exploitation du scénario: ${formatPercent(personalRentalResult.netOperatingYieldPct)}`,
          numberValue(personalRentalResult.monthlyCashFlow) != null
            ? `Cash-flow mensuel avant impôts: ${formatAmount(personalRentalResult.monthlyCashFlow)}`
            : "Cash-flow mensuel avant impôts: non calculable sans mensualité de financement",
        ]
      : [
          "Estimation locative indicative",
          "Hypothèses: loyer estimé par défaut et paramètres de vacance, charges, taxe foncière, assurance et financement du modèle.",
          rentabilityScoreValue != null
            ? `Score de rentabilité : ${rentabilityScoreValue}/100 - ${rentabilityLabel(rentabilityScoreValue)}`
            : `Score de rentabilité : indisponible (${stringOrNumberValue(rentabilityScore.reason, "données incomplètes")})`,
          rentabilityScore.netYieldPct != null
            ? `${rentNotice ? "Rendement estimé, charges comprises" : "Rendement net estimé"} : ${formatPercent(rentabilityScore.netYieldPct)}`
            : `${rentNotice ? "Rendement estimé, charges comprises" : "Rendement net estimé"} : à compléter`,
          rentabilityScore.cashflowMonthly != null
            ? `Cash-flow mensuel estimé : ${formatPrice(numberValue(rentabilityScore.cashflowMonthly))}`
            : "Cash-flow mensuel estimé : à compléter",
        ]),
    `${wording.feesHeading}: ${stringOrNumberValue(
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
      ? `Coût complet à la ${wording.referencePriceLower}: ${formatPrice(numberValue(acquisitionCosts.totalCost))}`
      : `Coût complet à la ${wording.referencePriceLower}: à compléter`,
    `Travaux / état: ${stringOrNumberValue(renovationAnalysis.summary, "état à qualifier")}`,
    `Priorité travaux: ${stringOrNumberValue(renovationAnalysis.priorityLabel, "à qualifier")}`,
    renovationBudgetRange
      ? `Budget travaux indicatif: ${renovationBudgetRange}`
      : "Budget travaux indicatif: à chiffrer",
    `Impact travaux: ${stringOrNumberValue(
      renovationAnalysis.decisionImpact,
      `état à confirmer ${wording.beforeBid}`,
    )}`,
    "",
    ceilingLabel,
    ...(personalSimulation
      ? [
          "Scénario personnel sauvegardé",
          ...personalSimulation.map(([label, value]) => `${label}: ${value}`),
          // Sans marge enregistrée, la ligne n'est pas écrite (jamais « null % »).
          ...lineIfProvided(
            "Marge de sécurité",
            numberValue(ceiling.safetyDiscountPct) != null
              ? `${numberValue(ceiling.safetyDiscountPct)} %`
              : null,
          ),
          `Base retenue: ${stringOrNumberValue(ceiling.basisLabel, "à confirmer")}`,
        ]
      : []),
    ...(Array.isArray(ceiling.steps) && ceiling.available && calculationSteps.length
      ? ["Calcul du plafond :", ...calculationSteps]
      : []),
    ceiling.available
      ? `${ceilingLabel}: ${formatPrice(numberValue(ceiling.maxBid))}`
      : `${ceilingLabel}: indisponible (${stringOrNumberValue(ceiling.reason, "données incomplètes")})`,
    // Taxe foncière non renseignée : le plafond est plus élevé qu'avec elle (absent des rapports
    // enregistrés avant cette mention : aucune ligne).
    ...(ceiling.available && ceiling.propertyTaxMissing === true ? [PROPERTY_TAX_NOT_COUNTED] : []),
    // Vente notariale : ce que le calcul ne couvre pas, la mention d'une vente par offres et les
    // frais qui viennent d'une valeur par défaut.
    ...(typeof ceiling.scopeNote === "string" && ceiling.available ? [ceiling.scopeNote] : []),
    ...(typeof ceiling.reserveNotice === "string" && ceiling.available
      ? [ceiling.reserveNotice]
      : []),
    ...(Array.isArray(ceiling.estimatedFees) && ceiling.estimatedFees.length && ceiling.available
      ? [
          `Frais estimés, à confirmer : ${ceiling.estimatedFees
            .map((fee) => stringOrNumberValue(asRecord(fee).label, ""))
            .filter(Boolean)
            .join(", ")}`,
        ]
      : []),
    ...(ceiling.available &&
    numberValue(ceiling.maxBid) != null &&
    numberValue(sale.startingPrice) != null &&
    (numberValue(ceiling.maxBid) ?? Infinity) < (numberValue(sale.startingPrice) ?? 0)
      ? [wording.belowStartSentence]
      : []),
    ceiling.targetTotalCost
      ? `Coût complet cible: ${formatPrice(numberValue(ceiling.targetTotalCost))}`
      : "Coût complet cible: à compléter",
    ceiling.marketReferencePricePerM2
      ? `Référence marché retenue: ${formatPricePerM2(numberValue(ceiling.marketReferencePricePerM2))}`
      : "Référence marché retenue: à compléter",
    "",
    wording.audiencePreparation,
    `Synthèse: ${stringOrNumberValue(audienceReadinessAnalysis.summary, "préparation à compléter")}`,
    `Statut: ${stringOrNumberValue(audienceReadinessAnalysis.label, "à vérifier")}`,
    `Progression: ${formatCount(audienceReadinessAnalysis.progressPct, " %")}`,
    `Points prioritaires ouverts: ${formatCount(audienceReadinessAnalysis.highPriorityOpenCount)}`,
    ...(audienceChecklistItems.length
      ? audienceChecklistItems.slice(0, 8).map((item) => `- ${item}`)
      : ["- Checklist à compléter dans le dossier."]),
    ...(audienceReadinessActions.length
      ? [
          wording.audienceActions,
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
      : [`- Relire les pièces officielles ${wording.beforeAnyBid}.`]),
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
    // Dernière page, détachable : à montrer à la banque.
    ...financingDossierLines({
      title: stringOrNumberValue(
        cleanSaleTitle(stringOrNumberValue(sale.title, null)),
        redactPersonalText(report.title),
      ),
      generatedAt: stringOrNumberValue(snapshot.generatedAt, report.updated_at),
      sale,
      ceiling,
      acquisitionCosts,
      announcedGuarantee: consignation,
      documentsCount: analysis.documentsCount,
    }),
  ];
}
