import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSharedPropertyReport } from "@/lib/property-reports";
import { ReportSourceChangedError } from "@/lib/property-report/source-integrity";
import { formatDate, formatPrice, formatPricePerM2 } from "@/lib/format";
import { reportSaleSchedule } from "@/lib/report-sale-schedule";
import { reportSimulationSchema } from "@/lib/report-simulation";
import { asRecord, numberValue, stringOrNumberValue } from "@/lib/guards";

type PageParams = {
  params: Promise<{ token: string }>;
};

export const metadata: Metadata = {
  title: "Rapport partagé",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function SharedReportPage({ params }: PageParams) {
  const { token } = await params;
  const report = await getSharedPropertyReport({ token }).catch((error: unknown) =>
    error instanceof ReportSourceChangedError ? error : null,
  );
  if (!report) notFound();
  if (report instanceof ReportSourceChangedError) {
    return (
      <main id="contenu" className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-semibold">Rapport à actualiser</h1>
        <p className="mt-4 text-slate-700">
          Les données de cette analyse ne peuvent plus être confirmées. Demandez à la personne qui
          vous a transmis ce lien de sauvegarder une nouvelle analyse depuis l’annonce, puis de vous
          partager le lien actualisé.
        </p>
      </main>
    );
  }

  const sale = report.sale;
  const analysis = report.analysis;
  const valueEstimate = asRecord(analysis.valueEstimate);
  const marketComparables = asRecord(analysis.marketComparablesAnalysis);
  const retainedComparables = normalizeMarketComparableRows(marketComparables.retainedComparables);
  const addressHistory = normalizeMarketComparableRows(marketComparables.addressHistory);
  const marketComparablesActions = normalizeStringList(marketComparables.nextActions);
  const valuationAudit = asRecord(analysis.valuationAudit);
  const valuationCheckpoints = normalizeValuationCheckpoints(valuationAudit.checkpoints);
  const valuationActions = normalizeStringList(valuationAudit.nextActions);
  const valuationRiskFlags = normalizeStringList(valuationAudit.riskFlags);
  const valuationLimitations = normalizeStringList(valuationAudit.limitations);
  const opportunity = asRecord(analysis.opportunity);
  const rentabilityScore = asRecord(opportunity.rentabilityScore);
  const acquisitionCosts = asRecord(opportunity.acquisitionCosts);
  const legalAttentionPoints = Array.isArray(analysis.legalAttentionPoints)
    ? analysis.legalAttentionPoints
    : [];
  const sourceTrace = report.sourceTrace;
  const limitations = report.limitations;
  const cadastral = asRecord(analysis.cadastralAnalysis);
  const cadastralReferences = normalizeCadastralReferences(cadastral.references);
  const cadastralActions = normalizeStringList(cadastral.nextActions);
  const cadastralSources = normalizeStringList(cadastral.sources);
  const nearbyServices = asRecord(analysis.nearbyServices);
  const nearbyCategories = normalizeNearbyCategoryLabels(nearbyServices.categories);
  const nearbyActions = normalizeStringList(nearbyServices.nextActions);
  const demographicAnalysis = asRecord(analysis.demographicAnalysis);
  const demographicSignals = normalizeDemographicSignals(demographicAnalysis.signals);
  const demographicActions = normalizeStringList(demographicAnalysis.nextActions);
  const demographicMissingData = normalizeStringList(demographicAnalysis.missingData);
  const demographicLimitations = normalizeStringList(demographicAnalysis.limitations);
  const occupancyAnalysis = asRecord(analysis.occupancyAnalysis);
  const occupancyEvidence = normalizeEvidence(occupancyAnalysis.evidence);
  const occupancyActions = normalizeStringList(occupancyAnalysis.nextActions);
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
  const urbanPlanningLimitations = normalizeStringList(urbanPlanningAnalysis.limitations);
  const dpe = asRecord(analysis.dpe);
  const dpeEvidence = normalizeEvidence(dpe.evidence);
  const dpeActions = normalizeStringList(dpe.nextActions);
  const renovationAnalysis = asRecord(analysis.renovationAnalysis);
  const renovationEvidence = normalizeEvidence(renovationAnalysis.evidence);
  const renovationActions = normalizeStringList(renovationAnalysis.nextActions);
  const renovationBudgetRange = formatRenovationBudgetRange(
    asRecord(renovationAnalysis.budgetRange),
  );
  const streetFacadeAnalysis = asRecord(analysis.streetFacadeAnalysis);
  const streetFacadeActions = normalizeStringList(streetFacadeAnalysis.nextActions);
  const streetFacadeLimitations = normalizeStringList(streetFacadeAnalysis.limitations);
  const streetLevelUrl = externalUrl(streetFacadeAnalysis.streetLevelUrl);
  const aerial3dUrl = externalUrl(streetFacadeAnalysis.aerial3dUrl);
  const mapUrl = externalUrl(streetFacadeAnalysis.mapUrl);
  const neighborhoodAnalysis = asRecord(analysis.neighborhoodAnalysis);
  const neighborhoodDimensions = normalizeStringList(neighborhoodAnalysis.dimensions);
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
  const ceiling = asRecord(report.ceiling);
  const personalSimulation = reportSimulationSchema.safeParse(ceiling.personalSimulation);

  return (
    <main id="contenu" className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <article className="mx-auto max-w-4xl rounded-lg border border-border bg-white/94 p-6 shadow-sm sm:p-8">
        <header className="border-b border-border pb-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-text">
            Rapport partagé Immojudis
          </p>
          <h1 className="mt-3 font-display text-3xl leading-tight text-foreground sm:text-4xl">
            {report.title}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Mis à jour le {formatDate(report.updatedAt)} · partagé le{" "}
            {report.sharedAt ? formatDate(report.sharedAt) : "date inconnue"}
          </p>
        </header>

        <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-2">
          <SharedMetric
            label="Localisation"
            value={joinValues(sale.address, sale.city, sale.department)}
          />
          <SharedMetric
            label="Tribunal"
            value={stringOrNumberValue(sale.tribunal, "À confirmer")}
          />
          {reportSaleSchedule(sale).map(({ label, value }) => (
            <SharedMetric key={label} label={label} value={value} />
          ))}
          <SharedMetric
            label="Préparation audience"
            value={stringOrNumberValue(audienceReadinessAnalysis.summary, "À compléter")}
          />
          <SharedMetric label="Mise à prix" value={formatPrice(numberValue(sale.startingPrice))} />
          <SharedMetric
            label="Occupation"
            value={stringOrNumberValue(
              occupancyAnalysis.summary,
              stringOrNumberValue(sale.occupancy, "À vérifier"),
            )}
          />
          <SharedMetric label="Type" value={stringOrNumberValue(sale.propertyType, "Bien")} />
          <SharedMetric
            label="Surface"
            value={stringOrNumberValue(sale.surfaceLabel, "À confirmer")}
          />
        </section>

        <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-2">
          <SharedMetric
            label="Prix/m² médian"
            value={
              valueEstimate.medianPricePerM2
                ? formatPricePerM2(numberValue(valueEstimate.medianPricePerM2))
                : "À compléter"
            }
          />
          <SharedMetric
            label="Échantillon DVF"
            value={`${stringOrNumberValue(valueEstimate.sampleSize, "0")} vente(s) comparable(s)`}
          />
          <SharedMetric
            label="Mise maximum conseillée"
            value={
              ceiling.available ? formatPrice(numberValue(ceiling.maxBid)) : "Données insuffisantes"
            }
          />
          <SharedMetric
            label="Qualité estimation"
            value={stringOrNumberValue(
              marketComparables.confidenceLabel,
              stringOrNumberValue(valueEstimate.qualityLabel, "Fragile"),
            )}
          />
          <SharedMetric
            label="Audit estimation"
            value={stringOrNumberValue(valuationAudit.summary, "Audit estimation à construire")}
          />
          <SharedMetric
            label="Analyse quartier"
            value={stringOrNumberValue(neighborhoodAnalysis.summary, "Quartier à qualifier")}
          />
          <SharedMetric
            label="Analyse démographique"
            value={stringOrNumberValue(
              demographicAnalysis.summary,
              "Données démographiques à enrichir",
            )}
          />
          <SharedMetric
            label="Comparables en vente"
            value={stringOrNumberValue(activeComparablesAnalysis.summary, "À rechercher")}
          />
        </section>

        {personalSimulation.success ? (
          <section className="border-b border-border py-5" aria-labelledby="shared-simulation">
            <h2 id="shared-simulation" className="text-lg font-semibold text-foreground">
              Scénario personnel sauvegardé
            </h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Prix simulé"
                value={formatPrice(personalSimulation.data.price)}
              />
              <SharedMetric
                label="Travaux saisis"
                value={formatPrice(personalSimulation.data.works)}
              />
              <SharedMetric
                label="Frais préalables saisis"
                value={formatPrice(personalSimulation.data.fpt)}
              />
              <SharedMetric
                label="Scénario"
                value={
                  { prudent: "Prudent", offensif: "Offensif", custom: "Personnalisé" }[
                    personalSimulation.data.scenario
                  ]
                }
              />
              <SharedMetric
                label="Marge de sécurité"
                value={formatPercent(numberValue(ceiling.safetyDiscountPct))}
              />
              <SharedMetric
                label="Base retenue"
                value={stringOrNumberValue(ceiling.basisLabel, "À confirmer")}
              />
              <SharedMetric
                label="Coût complet au prix simulé"
                value={
                  typeof acquisitionCosts.totalCost === "number"
                    ? formatPrice(acquisitionCosts.totalCost)
                    : "À confirmer"
                }
              />
              {personalSimulation.data.manualMarketPricePerM2 != null ? (
                <SharedMetric
                  label="Référence de marché saisie"
                  value={formatPricePerM2(personalSimulation.data.manualMarketPricePerM2)}
                />
              ) : null}
            </div>
          </section>
        ) : null}

        {marketComparables.available ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Comparables DVF
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(marketComparables.summary, "Comparables à compléter")}
              />
              <SharedMetric
                label="Mode"
                value={stringOrNumberValue(marketComparables.comparableModeLabel, "À confirmer")}
              />
              <SharedMetric
                label="Fenêtre surface"
                value={stringOrNumberValue(marketComparables.surfaceWindowLabel, "À confirmer")}
              />
              <SharedMetric
                label="Fourchette"
                value={stringOrNumberValue(marketComparables.priceRangeLabel, "À confirmer")}
              />
            </div>
            <SharedList items={retainedComparables} limit={5} />
            {addressHistory.length ? (
              <div className="mt-4">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                  Historique adresse
                </p>
                <ul className="mt-2 space-y-2 text-sm leading-relaxed text-foreground">
                  {addressHistory.slice(0, 3).map((row) => (
                    <li key={row}>{row}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <SharedList items={marketComparablesActions} limit={3} muted />
          </section>
        ) : null}

        {valuationAudit.available || valuationCheckpoints.length ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Audit de valorisation
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(valuationAudit.summary, "Audit estimation à construire")}
              />
              <SharedMetric
                label="Niveau"
                value={stringOrNumberValue(valuationAudit.confidenceLabel, "À vérifier")}
              />
              <SharedMetric
                label="Score"
                value={`${stringOrNumberValue(valuationAudit.score, "0")}/100`}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  valuationAudit.decisionImpact,
                  "Estimation à recouper avant plafond",
                )}
              />
            </div>
            <SharedList items={valuationCheckpoints} limit={8} />
            {valuationRiskFlags.length ? (
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Points à risque : {valuationRiskFlags.slice(0, 5).join(" · ")}
              </p>
            ) : null}
            <SharedList items={valuationActions} limit={4} muted />
            {valuationLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {valuationLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {activeComparablesAnalysis.available ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Biens comparables en vente
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(
                  activeComparablesAnalysis.summary,
                  "Comparables à rechercher",
                )}
              />
              <SharedMetric
                label="Périmètre"
                value={stringOrNumberValue(activeComparablesAnalysis.scopeLabel, "À confirmer")}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(activeComparablesAnalysis.confidenceLabel, "À vérifier")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  activeComparablesAnalysis.decisionImpact,
                  "À croiser avec le plafond",
                )}
              />
            </div>
            <SharedList items={activeComparableItems} limit={5} />
            <SharedList items={activeComparableActions} limit={3} muted />
          </section>
        ) : null}

        {audienceReadinessAnalysis.available ? (
          <section className="border-b border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Préparation audience
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(
                  audienceReadinessAnalysis.summary,
                  "Préparation à compléter",
                )}
              />
              <SharedMetric
                label="Urgence"
                value={stringOrNumberValue(
                  audienceReadinessAnalysis.urgencyLabel,
                  "Date à confirmer",
                )}
              />
              <SharedMetric
                label="Progression"
                value={`${stringOrNumberValue(audienceReadinessAnalysis.progressPct, "0")} %`}
              />
              <SharedMetric
                label="Points prioritaires"
                value={stringOrNumberValue(audienceReadinessAnalysis.highPriorityOpenCount, "0")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  audienceReadinessAnalysis.decisionImpact,
                  "À arbitrer avant enchère",
                )}
              />
              <SharedMetric
                label="Visites"
                value={`${normalizeStringList(audienceReadinessAnalysis.visitDates).length} mention(s)`}
              />
            </div>
            <SharedList items={audienceChecklistItems} limit={8} />
            <SharedList items={audienceReadinessActions} limit={4} muted />
          </section>
        ) : null}

        <section className="grid gap-4 border-b border-border py-5 sm:grid-cols-2">
          <SharedMetric
            label="Score d'opportunité"
            value={
              opportunity.score != null
                ? `${stringOrNumberValue(opportunity.score, "")}/100 · ${stringOrNumberValue(opportunity.label, "À qualifier")}`
                : "À compléter"
            }
          />
          <SharedMetric
            label="Décote apparente"
            value={formatPercent(numberValue(opportunity.apparentDiscountPct))}
          />
          <SharedMetric
            label="Valeur médiane estimée"
            value={formatPrice(numberValue(opportunity.estimatedMarketValue))}
          />
          <SharedMetric
            label="Rendement brut potentiel"
            value={formatPercent(numberValue(opportunity.grossYieldPct))}
          />
          <SharedMetric
            label="Score rentabilité"
            value={
              rentabilityScore.score != null
                ? `${stringOrNumberValue(rentabilityScore.score, "")}/100 · ${stringOrNumberValue(rentabilityScore.label, "À qualifier")}`
                : "À compléter"
            }
          />
          <SharedMetric
            label="Rendement net estimé"
            value={formatPercent(numberValue(rentabilityScore.netYieldPct))}
          />
          <SharedMetric
            label="Cashflow mensuel"
            value={formatPrice(numberValue(rentabilityScore.cashflowMonthly))}
          />
          <SharedMetric
            label="Frais estimés"
            value={stringOrNumberValue(
              auctionCostAnalysis.summary,
              formatPrice(numberValue(acquisitionCosts.acquisitionFeesTotal)),
            )}
          />
          <SharedMetric
            label="Travaux / état"
            value={stringOrNumberValue(renovationAnalysis.summary, "À qualifier")}
          />
          <SharedMetric
            label="Coût complet"
            value={formatPrice(numberValue(acquisitionCosts.totalCost))}
          />
        </section>

        <section className="grid gap-4 py-5 sm:grid-cols-2">
          <SharedMetric
            label="Cadastre"
            value={stringOrNumberValue(
              cadastral.summary,
              cadastral.available ? "Repère disponible" : "Référence cadastrale à confirmer",
            )}
          />
          <SharedMetric
            label="DPE / diagnostics"
            value={stringOrNumberValue(
              dpe.summary,
              dpe.available ? stringOrNumberValue(dpe.class, "Diagnostic repéré") : "À rechercher",
            )}
          />
          <SharedMetric
            label="Urbanisme / permis"
            value={stringOrNumberValue(
              urbanPlanningAnalysis.summary,
              "Urbanisme, permis et servitudes à vérifier",
            )}
          />
          <SharedMetric
            label="Travaux / état"
            value={stringOrNumberValue(renovationAnalysis.summary, "À qualifier")}
          />
          <SharedMetric
            label="Façade et rue"
            value={stringOrNumberValue(streetFacadeAnalysis.summary, "Localisation à confirmer")}
          />
          <SharedMetric
            label="Services de proximité"
            value={stringOrNumberValue(
              nearbyServices.summary,
              nearbyServices.available ? "Signaux repérés" : "À qualifier",
            )}
          />
          <SharedMetric
            label="Analyse du quartier"
            value={stringOrNumberValue(neighborhoodAnalysis.summary, "À qualifier")}
          />
          <SharedMetric
            label="Démographie locale"
            value={stringOrNumberValue(demographicAnalysis.summary, "Données locales à enrichir")}
          />
          <SharedMetric
            label="Documents"
            value={`${stringOrNumberValue(analysis.documentsCount, "0")} pièce(s)`}
          />
          <SharedMetric label="Vues du lien" value={String(report.viewCount)} />
        </section>

        {cadastral.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Analyse cadastrale
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(cadastral.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Surface terrain"
                value={formatSurfaceM2(numberValue(cadastral.landSurfaceM2))}
              />
            </div>
            <SharedList items={cadastralReferences} />
            {cadastralSources.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Sources : {cadastralSources.slice(0, 4).join(" · ")}
              </p>
            ) : null}
            <SharedList items={cadastralActions} limit={3} muted />
          </section>
        ) : null}

        {dpe.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              DPE et diagnostics
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(dpe.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact"
                value={stringOrNumberValue(dpe.impactLabel, "Impact à qualifier")}
              />
              <SharedMetric
                label="Priorité travaux"
                value={renovationPriorityLabel(stringOrNumberValue(dpe.renovationPriority, ""))}
              />
              <SharedMetric
                label="Source"
                value={dpeSourceLabel(stringOrNumberValue(dpe.source, ""))}
              />
            </div>
            <SharedList items={dpeEvidence} limit={4} />
            <SharedList items={dpeActions} limit={3} muted />
          </section>
        ) : null}

        {renovationAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Travaux et état
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Priorité"
                value={renovationPriorityLabel(
                  stringOrNumberValue(renovationAnalysis.priority, ""),
                )}
              />
              <SharedMetric
                label="Budget indicatif"
                value={renovationBudgetRange || "À chiffrer"}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(renovationAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  renovationAnalysis.decisionImpact,
                  "État à confirmer avant enchère",
                )}
              />
            </div>
            <SharedList items={renovationEvidence} limit={4} />
            <SharedList items={renovationActions} limit={3} muted />
          </section>
        ) : null}

        {urbanPlanningAnalysis.status || urbanPlanningMissingChecks.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Urbanisme, permis et servitudes
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(
                  urbanPlanningAnalysis.summary,
                  "Urbanisme, permis et servitudes à vérifier",
                )}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(urbanPlanningAnalysis.confidenceLabel, "À vérifier")}
              />
              <SharedMetric
                label="Contrôles manquants"
                value={`${urbanPlanningMissingChecks.length} point(s)`}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  urbanPlanningAnalysis.decisionImpact,
                  "À intégrer avant l’enchère plafond",
                )}
              />
            </div>
            <SharedList items={urbanPlanningItems} limit={6} />
            <SharedList items={urbanPlanningMissingChecks} limit={4} muted />
            <SharedList items={urbanPlanningActions} limit={4} muted />
            {urbanPlanningLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {urbanPlanningLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {streetFacadeAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Façade et rue
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(
                  streetFacadeAnalysis.summary,
                  "Localisation à confirmer",
                )}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(streetFacadeAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Adresse"
                value={stringOrNumberValue(streetFacadeAnalysis.addressLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  streetFacadeAnalysis.decisionImpact,
                  "Vérifier l'environnement visible avant enchère",
                )}
              />
            </div>
            {mapUrl || streetLevelUrl || aerial3dUrl ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {streetLevelUrl ? (
                  <SharedExternalLink href={streetLevelUrl} label="Vue 3D du quartier" />
                ) : null}
                {aerial3dUrl ? <SharedExternalLink href={aerial3dUrl} label="Vue 3D" /> : null}
                {mapUrl ? <SharedExternalLink href={mapUrl} label="Carte" /> : null}
              </div>
            ) : null}
            <SharedList items={streetFacadeActions} limit={3} muted />
            {streetFacadeLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {streetFacadeLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {neighborhoodAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Analyse du quartier
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(neighborhoodAnalysis.summary, "Quartier à qualifier")}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(neighborhoodAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Marché local"
                value={stringOrNumberValue(neighborhoodAnalysis.marketPositionLabel, "À calculer")}
              />
              <SharedMetric
                label="Services"
                value={stringOrNumberValue(
                  neighborhoodAnalysis.serviceCoverageLabel,
                  "À qualifier",
                )}
              />
              <SharedMetric
                label="Localisation"
                value={stringOrNumberValue(neighborhoodAnalysis.locationQualityLabel, "À géocoder")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  neighborhoodAnalysis.decisionImpact,
                  "À intégrer avant décision",
                )}
              />
            </div>
            {neighborhoodDimensions.length ? (
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Dimensions : {neighborhoodDimensions.join(" · ")}
              </p>
            ) : null}
            <SharedList items={neighborhoodSignals} limit={5} />
            <SharedList items={neighborhoodActions} limit={3} muted />
          </section>
        ) : null}

        {demographicAnalysis.status || demographicMissingData.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Analyse démographique
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(
                  demographicAnalysis.summary,
                  "Données démographiques à enrichir",
                )}
              />
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(demographicAnalysis.confidenceLabel, "À vérifier")}
              />
              <SharedMetric
                label="Profil local"
                value={stringOrNumberValue(demographicAnalysis.profileLabel, "Profil à enrichir")}
              />
              <SharedMetric
                label="Demande"
                value={stringOrNumberValue(demographicAnalysis.demandLabel, "Demande à qualifier")}
              />
              <SharedMetric
                label="Données manquantes"
                value={`${demographicMissingData.length} point(s)`}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  demographicAnalysis.decisionImpact,
                  "À intégrer avant de figer le scénario",
                )}
              />
            </div>
            <SharedList items={demographicSignals} limit={6} />
            <SharedList items={demographicMissingData} limit={4} muted />
            <SharedList items={demographicActions} limit={4} muted />
            {demographicLimitations.length ? (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {demographicLimitations.slice(0, 2).join(" · ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {nearbyServices.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Services de proximité
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(nearbyServices.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Localisation"
                value={locationQualityLabel(
                  stringOrNumberValue(nearbyServices.locationQuality, ""),
                )}
              />
            </div>
            <SharedList items={nearbyCategories} />
            <SharedList items={nearbyActions} limit={3} muted />
          </section>
        ) : null}

        {occupancyAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Occupation
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(occupancyAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Impact décision"
                value={stringOrNumberValue(
                  occupancyAnalysis.decisionImpact,
                  "À vérifier avant enchère",
                )}
              />
            </div>
            <SharedList items={occupancyEvidence} limit={4} />
            <SharedList items={occupancyActions} limit={3} muted />
          </section>
        ) : null}

        {auctionCostAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Frais et consignation
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Niveau de confiance"
                value={stringOrNumberValue(auctionCostAnalysis.confidenceLabel, "À confirmer")}
              />
              <SharedMetric
                label="Consignation"
                value={formatKnownPrice(numberValue(consignation.amountEur))}
              />
              <SharedMetric
                label="Émoluments TTC"
                value={formatKnownPrice(numberValue(auctionCostAnalysis.emolumentsTtcEur))}
              />
              <SharedMetric
                label="Droits estimés"
                value={formatKnownPrice(numberValue(auctionCostAnalysis.registrationDutiesEur))}
              />
            </div>
            <SharedList items={auctionCostSignals} limit={4} />
            <SharedList items={auctionCostActions} limit={3} muted />
          </section>
        ) : null}

        {legalAttentionAnalysis.available ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Revue juridique
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SharedMetric
                label="Synthèse"
                value={stringOrNumberValue(legalAttentionAnalysis.summary, "Points à relire")}
              />
              <SharedMetric
                label="Niveau de revue"
                value={stringOrNumberValue(legalAttentionAnalysis.confidenceLabel, "À vérifier")}
              />
            </div>
            <SharedList items={legalAttentionItems} limit={6} />
            <SharedList items={legalAttentionActions} limit={4} muted />
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {stringOrNumberValue(
                legalAttentionAnalysis.disclaimer,
                "Revue opérationnelle, sans avis juridique.",
              )}
            </p>
          </section>
        ) : null}

        {legalAttentionPoints.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Points d'attention
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-foreground">
              {legalAttentionPoints.map((point, index) => (
                <li key={`${index}-${String(point)}`}>{stringOrNumberValue(point, "")}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {sourceTrace.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Sources et traçabilité
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {sourceTrace.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border bg-muted/25 p-3">
                  <p className="text-sm font-semibold text-foreground">{entry.label}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {entry.sourceName}
                    {entry.capturedAt ? ` · ${formatDate(entry.capturedAt)}` : ""}
                  </p>
                  {entry.detail ? (
                    <p className="mt-2 text-xs leading-relaxed text-foreground">{entry.detail}</p>
                  ) : null}
                  <p className="mt-2 text-[11px] font-semibold text-muted-foreground">
                    {entry.confidenceLabel}
                  </p>
                  {entry.url ? (
                    <a
                      className="mt-2 inline-flex text-xs font-semibold text-gold-text underline-offset-4 hover:underline"
                      href={entry.url}
                      rel="noreferrer"
                      target={entry.url.startsWith("http") ? "_blank" : undefined}
                    >
                      Ouvrir la source
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {limitations.length ? (
          <section className="border-t border-border py-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              Limites à confirmer
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
              {limitations.map((limitation, index) => (
                <li key={`${index}-${limitation}`}>{limitation}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-4 rounded-lg border border-info/15 bg-info/8 p-4 text-sm leading-relaxed text-info">
          {report.disclaimer}
        </footer>
      </article>
    </main>
  );
}

function SharedMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value || "À confirmer"}</p>
    </div>
  );
}

function SharedList({
  items,
  limit,
  muted = false,
}: {
  items: string[];
  limit?: number;
  muted?: boolean;
}) {
  if (!items.length) return null;
  return (
    <ul
      className={
        muted
          ? "mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground"
          : "mt-4 space-y-2 text-sm leading-relaxed text-foreground"
      }
    >
      {(limit == null ? items : items.slice(0, limit)).map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function SharedExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="inline-flex min-h-10 items-center rounded-md border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:bg-muted/40"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {label}
    </a>
  );
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
}

function normalizeCadastralReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const section = stringOrNumberValue(record.section, "");
      const number = stringOrNumberValue(record.number, "");
      const raw = stringOrNumberValue(record.raw, "");
      const prefix = stringOrNumberValue(record.prefix, "");
      if (section && number) return `Section ${prefix ? `${prefix} ` : ""}${section} n° ${number}`;
      return raw;
    })
    .filter(Boolean);
}

function normalizeNearbyCategoryLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = stringOrNumberValue(record.status, "");
      if (status !== "mentioned") return "";
      return stringOrNumberValue(record.label, "");
    })
    .filter(Boolean);
}

function normalizeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringOrNumberValue(record.label, "");
      const source = stringOrNumberValue(record.source, "");
      const excerpt = stringOrNumberValue(record.excerpt, "");
      return [label, source, excerpt].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeNeighborhoodSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringOrNumberValue(record.label, "");
      const status = neighborhoodSignalStatusLabel(stringOrNumberValue(record.status, ""));
      const source = stringOrNumberValue(record.source, "");
      const detail = stringOrNumberValue(record.detail, "");
      return [status, label, source, detail].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeDemographicSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = demographicSignalStatusLabel(stringOrNumberValue(record.status, ""));
      const label = stringOrNumberValue(record.label, "");
      const source = stringOrNumberValue(record.source, "");
      const detail = stringOrNumberValue(record.detail, "");
      const impact = stringOrNumberValue(record.impact, "");
      return [status, label, source, detail, impact].filter(Boolean).join(" · ");
    })
    .filter(Boolean);
}

function normalizeLegalAttentionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = stringOrNumberValue(record.priority, "");
      const label = stringOrNumberValue(record.label, "");
      const reason = stringOrNumberValue(record.reason, "");
      const action = stringOrNumberValue(record.action, "");
      return [
        priority ? priorityLabel(priority) : null,
        label,
        reason,
        action ? `Action : ${action}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeUrbanPlanningItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const priority = priorityLabel(stringOrNumberValue(record.priority, ""));
      const status = urbanPlanningStatusLabel(stringOrNumberValue(record.status, ""));
      const label = stringOrNumberValue(record.label, "");
      const source = stringOrNumberValue(record.source, "");
      const detail = stringOrNumberValue(record.detail, "");
      const action = stringOrNumberValue(record.action, "");
      return [priority, status, label, source, detail, action ? `Action : ${action}` : null]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeMarketComparableRows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const date = stringOrNumberValue(record.date, "");
      const type = stringOrNumberValue(record.type, "Bien");
      const totalPrice = numberValue(record.totalPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const distance = numberValue(record.distanceM);
      return [
        date ? formatDate(date) : null,
        type,
        totalPrice != null ? formatPrice(totalPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m²` : null,
        distance != null ? `${Math.round(distance)} m` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeValuationCheckpoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const status = valuationStatusLabel(stringOrNumberValue(record.status, ""));
      const label = stringOrNumberValue(record.label, "");
      const detail = stringOrNumberValue(record.detail, "");
      const action = stringOrNumberValue(record.action, "");
      return [status, label, detail, action ? `Action : ${action}` : null]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeActiveComparableItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const title = stringOrNumberValue(record.title, "Bien actif");
      const city = stringOrNumberValue(record.city, "");
      const saleDate = stringOrNumberValue(record.saleDate, "");
      const startingPrice = numberValue(record.startingPriceEur);
      const pricePerM2 = numberValue(record.pricePerM2);
      const surface = numberValue(record.surfaceM2);
      const matchLabel = stringOrNumberValue(record.matchLabel, "");
      const matchScore = numberValue(record.matchScore);
      return [
        matchLabel && matchScore != null ? `${matchLabel} (${matchScore}/100)` : matchLabel,
        title,
        city,
        saleDate ? formatDate(saleDate) : null,
        startingPrice != null ? formatPrice(startingPrice) : null,
        pricePerM2 != null ? formatPricePerM2(pricePerM2) : null,
        surface != null ? `${Math.round(surface)} m²` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function normalizeAudienceChecklistItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const label = stringOrNumberValue(record.label, "");
      const status = audienceChecklistStatusLabel(stringOrNumberValue(record.status, ""));
      const priority = priorityLabel(stringOrNumberValue(record.priority, ""));
      const detail = stringOrNumberValue(record.detail, "");
      const action = stringOrNumberValue(record.action, "");
      return [status, priority, label, detail, action ? `Action : ${action}` : null]
        .filter(Boolean)
        .join(" · ");
    })
    .filter(Boolean);
}

function priorityLabel(value: string): string {
  const labels: Record<string, string> = {
    high: "Prioritaire",
    medium: "À vérifier",
    low: "Contrôle",
  };
  return labels[value] ?? value;
}

function audienceChecklistStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    done: "OK",
    to_do: "À faire",
    watch: "À vérifier",
  };
  return labels[value] ?? value;
}

function urbanPlanningStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    documented: "Documenté",
    to_verify: "À confirmer",
    missing: "Manquant",
  };
  return labels[value] ?? value;
}

function renovationPriorityLabel(value: string): string {
  const labels: Record<string, string> = {
    low: "Faible",
    medium: "À calibrer",
    high: "Prioritaire",
    unknown: "À qualifier",
  };
  return labels[value] ?? "À confirmer";
}

function dpeSourceLabel(value: string): string {
  const labels: Record<string, string> = {
    source_blocks: "Données source",
    documents: "Pièces du dossier",
    risk_evidence: "Preuves de risques",
  };
  return labels[value] ?? "À confirmer";
}

function locationQualityLabel(value: string): string {
  const labels: Record<string, string> = {
    coordinates: "Coordonnées disponibles",
    address: "Adresse disponible",
    commune: "Commune disponible",
    missing: "À géocoder",
  };
  return labels[value] ?? "À confirmer";
}

function neighborhoodSignalStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    positive: "Atout",
    watch: "À vérifier",
    to_enrich: "À enrichir",
  };
  return labels[value] ?? value;
}

function demographicSignalStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    source_signal: "Signal source",
    proxy: "Proxy",
  };
  return labels[value] ?? value;
}

function valuationStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    ok: "OK",
    watch: "À surveiller",
    risk: "Risque",
    missing: "Manquant",
  };
  return labels[value] ?? value;
}

function formatSurfaceM2(value: number | null): string {
  if (value == null) return "À confirmer";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} m²`;
}

function formatKnownPrice(value: number | null): string {
  return value == null ? "À confirmer" : formatPrice(value);
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value)} %`;
}

function formatRenovationBudgetRange(range: Record<string, unknown>): string {
  const lowEur = numberValue(range.lowEur);
  const highEur = numberValue(range.highEur);
  if (lowEur != null && highEur != null) {
    return `${formatPrice(lowEur)} - ${formatPrice(highEur)}`;
  }
  const lowPerM2 = numberValue(range.lowPerM2);
  const highPerM2 = numberValue(range.highPerM2);
  if (lowPerM2 != null && highPerM2 != null) {
    return `${formatPricePerM2(lowPerM2)} - ${formatPricePerM2(highPerM2)}`;
  }
  return "";
}

function externalUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.startsWith("https://") || trimmed.startsWith("http://") ? trimmed : "";
}

function joinValues(...values: unknown[]): string {
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join(", ");
}
