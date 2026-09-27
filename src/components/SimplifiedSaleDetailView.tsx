"use client";

import { ListingQualityNotice } from "@/components/ListingQualityNotice";
import { ListingPhoto } from "@/components/ListingPhoto";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, UIEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ChartNoAxesCombined from "lucide-react/dist/esm/icons/chart-no-axes-combined.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert.js";
import FileText from "lucide-react/dist/esm/icons/file-text.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import { BillingActions } from "@/components/BillingActions";
import { DocumentsList } from "@/components/DocumentsList";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { riskEvidence } from "@/lib/risk-evidence";
import { listingSaleStatus, listingValuationConflict } from "@/lib/listing-evidence";
import type { BidSimulationSnapshot } from "@/components/BidCeilingAssistant";
import { useAuth } from "@/hooks/use-auth";
import { LawyerReferralButton } from "@/components/LawyerReferralButton";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { useOutcomeGraphForecast } from "@/hooks/use-outcome-graph-forecast";
import { SaleVisual } from "@/components/SaleVisual";
import { SaleProcedurePanel, SaleProcedureSummary } from "@/components/SaleProcedurePanel";
import { ProfessionalPilotLauncher } from "@/components/ProfessionalPilotLauncher";
import { buildTribunalPilot } from "@/lib/professional-pilot-tribunal";
import { buildNotaryPilot } from "@/lib/professional-pilot-notary";
import { buildStatePilot } from "@/lib/professional-pilot-state";
import {
  ListingActions,
  ListingOverview,
  ListingPracticalDetails,
  ListingDescription,
  ListingLocation,
} from "@/components/sale-detail/SaleListing";
import { ListingBudget } from "@/components/sale-detail/ListingBudget";
import { ListingDataCoverage } from "@/components/sale-detail/ListingDataCoverage";
import { ListingWorks, WorksSpotlight } from "@/components/sale-detail/ListingWorks";
import { FinancingSimulator } from "@/components/sale-detail/FinancingSimulator";
import { UrbanismeCadastrePanel } from "@/components/sale-detail/UrbanismeCadastrePanel";
import { SaleDetailTabNav, type SaleDetailTab } from "@/components/sale-detail/SaleDetailTabNav";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import listingStyles from "@/components/sale-detail/SaleListing.module.css";
import { fetchPrecomputedMarketEstimate, fetchSaleUrbanismeCadastre } from "@/lib/client-api";
import { formatDate, formatPrice, formatPricePerM2, propertyTypeLabel } from "@/lib/format";
import type { MarketEstimate } from "@/lib/market.functions";
import { marketReferenceConfidence } from "@/lib/market-comparables-analysis";
import {
  computeRecommendedCeilings,
  computeAcquisitionCosts,
  type MarketCeilingResult,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
  estimateWorksBudget,
} from "@/lib/profitability";
import { Link } from "@/lib/router-compat";
import { listingCoordinates, listingDate } from "@/lib/sale-listing";
import { saleSession, saleWindow } from "@/lib/sale-window";
import { propertyImages } from "@/lib/sale-media";
import { saleDisplayTitle } from "@/lib/sale-title";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  participationModeLabel,
  saleHasVerifiedTribunal,
  saleIsTribunalVenue,
  saleProcedureIsConfirmed,
  stateSaleMethodLabel,
} from "@/lib/sale-procedure";
import { getMarketValuationSurfaces } from "@/lib/surface";
import type { AuctionSale, SaleRisk } from "@/lib/types";

const SaleTribunalHistory = dynamic(
  () => import("@/components/SaleTribunalHistory").then((module) => module.SaleTribunalHistory),
  {
    loading: () => (
      <p className="p-6 text-sm text-muted-foreground">Chargement de l’historique du tribunal…</p>
    ),
  },
);
const OutcomeForecast = dynamic(() =>
  import("@/components/OutcomeForecast").then((module) => module.OutcomeForecast),
);
const PropertyReportActions = dynamic(
  () => import("@/components/PropertyReportActions").then((module) => module.PropertyReportActions),
  {
    loading: () => (
      <p className="mt-3 text-sm text-muted-foreground">Chargement des actions du rapport…</p>
    ),
  },
);
const BidCeilingAssistant = dynamic(
  () => import("@/components/BidCeilingAssistant").then((module) => module.BidCeilingAssistant),
  { loading: () => <div className="h-80 animate-pulse rounded-lg bg-muted" /> },
);
const PhotoCarouselDialog = dynamic(
  () => import("@/components/PhotoCarouselDialog").then((module) => module.PhotoCarouselDialog),
  { ssr: false },
);

type SaleDetailProps = {
  sale: AuctionSale;
  marketEstimateOverride?: MarketEstimate | null;
  returnTo?: string;
  backLabel?: string;
  publicDemo?: boolean;
  adjudicationStatisticsEnabled?: boolean;
};

export function AnalysisSaleDetailView({
  sale,
  marketEstimateOverride = null,
  returnTo = "/sales",
  backLabel = "Retour aux ventes",
  publicDemo = false,
  adjudicationStatisticsEnabled = false,
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      key={sale.id}
      sale={sale}
      marketEstimateOverride={marketEstimateOverride}
      returnTo={returnTo}
      backLabel={backLabel}
      publicDemo={publicDemo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      access="analysis"
    />
  );
}

export function FreeSaleDetailView({ sale, returnTo = "/sales" }: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView key={sale.id} sale={sale} returnTo={returnTo} access="discovery" />
  );
}

function SimplifiedSaleDetailView({
  sale,
  marketEstimateOverride = null,
  returnTo,
  backLabel = "Retour aux ventes",
  publicDemo = false,
  adjudicationStatisticsEnabled = false,
  access,
}: SaleDetailProps & { access: "discovery" | "analysis" }) {
  const [calculationOpen, setCalculationOpen] = useState(false);
  const [simulation, setSimulation] = useState<BidSimulationSnapshot | null>(null);
  const { user, loading: authLoading } = useAuth();
  const valuationConflict = listingValuationConflict(sale);
  const activeSimulation =
    !valuationConflict &&
    !authLoading &&
    simulation?.saleId === sale.id &&
    simulation.ownerId === (user?.id ?? "guest-demo")
      ? simulation
      : null;
  const isTribunalSale = saleIsTribunalVenue(sale);
  const budgetTarget =
    access === "analysis"
      ? isTribunalSale && !valuationConflict
        ? "calculation"
        : "budget"
      : "summary";
  const hasVerifiedTribunal = saleHasVerifiedTribunal(sale);
  const venueType = getSaleProcedure(sale).venueType;
  const marketSurfaces = getMarketValuationSurfaces(sale);
  const surface = marketSurfaces.builtSurfaceM2;
  const marketQuery = useQuery({
    queryKey: ["precomputed-market-estimate", sale.id],
    queryFn: () => fetchPrecomputedMarketEstimate({ saleId: sale.id }),
    enabled: access === "analysis" && marketEstimateOverride == null && !valuationConflict,
    staleTime: 24 * 60 * 60_000,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" && !query.state.data.estimate ? 15_000 : false,
  });
  const marketEstimate = valuationConflict
    ? null
    : (marketEstimateOverride ?? marketQuery.data?.estimate ?? null);
  const recommendations = useMemo(
    () =>
      computeRecommendedCeilings({
        surface,
        price: Math.max(0, sale.starting_price_eur ?? 0),
        fpt: DEFAULTS.fpt,
        scenario: DEFAULT_MARKET_CEILING_SCENARIO,
        medianPricePerM2:
          isTribunalSale && marketEstimate?.actionable === true
            ? marketEstimate.medianPricePerM2
            : null,
        p25PricePerM2:
          isTribunalSale && marketEstimate?.actionable === true
            ? marketEstimate.p25PricePerM2
            : null,
        p75PricePerM2:
          isTribunalSale && marketEstimate?.actionable === true
            ? marketEstimate.p75PricePerM2
            : null,
      }),
    [isTribunalSale, marketEstimate, sale.starting_price_eur, surface],
  );
  const worksBudget = estimateWorksBudget(surface, "rafraichissement");
  const heroCeilingResult = activeSimulation?.result ?? recommendations.withRefreshWorks;
  const heroCeiling =
    access === "analysis" && isTribunalSale && !valuationConflict && heroCeilingResult.available
      ? heroCeilingResult.maxBid
      : null;

  const [activeTab, setActiveTab] = useState<SaleDetailTab>("apercu");
  const [ceilingExplanationOpen, setCeilingExplanationOpen] = useState(false);
  const [anchorVisit, setAnchorVisit] = useState(0);
  const [expandedDetails, setExpandedDetails] = useState<Partial<Record<LegacyDetail, boolean>>>(
    {},
  );
  const setDetailOpen = (detail: LegacyDetail, open: boolean) => {
    setExpandedDetails((current) =>
      current[detail] === open ? current : { ...current, [detail]: open },
    );
  };

  useEffect(() => {
    const syncTabWithHash = () => {
      const anchor = window.location.hash.slice(1);
      setActiveTab(tabForAnchor(anchor));
      if (
        ["calculation", "budget", "budget-analysis"].includes(anchor) &&
        budgetTarget === "calculation"
      ) {
        setCalculationOpen(true);
      }
      if (anchor === "why-this-ceiling") setCeilingExplanationOpen(true);
      const detail = legacyDetailForAnchor(anchor, budgetTarget);
      if (detail) setDetailOpen(detail, true);
      setAnchorVisit((current) => current + 1);
    };
    syncTabWithHash();
    window.addEventListener("hashchange", syncTabWithHash);
    return () => window.removeEventListener("hashchange", syncTabWithHash);
  }, [budgetTarget]);

  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor || isTabAnchor(anchor) || tabForAnchor(anchor) !== activeTab) return;
    revealAnchor(anchor, budgetTarget);
  }, [activeTab, anchorVisit, budgetTarget]);

  const changeTab = (tab: SaleDetailTab) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
    document.getElementById("annonce-sections")?.scrollIntoView?.({ block: "start" });
  };

  const handleSectionLink = (event: ReactMouseEvent<HTMLElement>) => {
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const link = origin.closest<HTMLAnchorElement>('a[href^="#"]');
    const anchor = link?.getAttribute("href")?.slice(1);
    if (!anchor) return;
    const tab = knownTabForAnchor(anchor);
    if (!tab) return;
    if (
      ["calculation", "budget", "budget-analysis"].includes(anchor) &&
      budgetTarget === "calculation"
    ) {
      setCalculationOpen(true);
    }
    if (anchor === "why-this-ceiling") setCeilingExplanationOpen(true);
    const detail = legacyDetailForAnchor(anchor, budgetTarget);
    if (detail) setDetailOpen(detail, true);
    const target = document.getElementById(anchor);
    if (tab === activeTab && target && !target.closest("details:not([open])")) return;
    event.preventDefault();
    window.history.pushState(null, "", `#${anchor}`);
    setActiveTab(tab);
    setAnchorVisit((current) => current + 1);
  };

  return (
    <main className={listingStyles.page} onClickCapture={handleSectionLink}>
      <div className={listingStyles.container}>
        <div className={listingStyles.topbar}>
          <Link
            href={returnTo ?? "/sales"}
            className="inline-flex min-h-10 items-center gap-2 rounded-md text-sm font-semibold text-brand-navy transition-colors hover:text-gold-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            {backLabel}
          </Link>
          <ListingActions sale={sale} publicDemo={publicDemo} />
        </div>
        <div className={listingStyles.upper}>
          <PropertyIdentity key={sale.id} sale={sale} publicDemo={publicDemo} />
          <div className={listingStyles.heroSummary}>
            <ListingOverview
              sale={sale}
              publicDemo={publicDemo}
              premiumCeiling={heroCeiling}
              showPremiumTeaser={access === "discovery" && isTribunalSale}
            />
          </div>
        </div>
        <ListingDataCoverage sale={sale} />
        <WorksSpotlight sale={sale} />
      </div>

      <div id="annonce-sections" className={panelStyles.tabRegion}>
        <SaleDetailTabNav activeTab={activeTab} onTabChange={changeTab} />
        <div
          id={`sale-detail-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`sale-detail-tab-${activeTab}`}
          tabIndex={0}
          className={panelStyles.panel}
        >
          {activeTab === "apercu" ? (
            <>
              <PanelIntro
                eyebrow="01 / Le bien"
                title="L’essentiel sur le bien"
                description="Description, points à vérifier et situation de la parcelle."
              />
              <div className={panelStyles.twoColumns}>
                <ListingDescription sale={sale} />
                <ListingLocation sale={sale} />
              </div>
              {access === "analysis" ? (
                <RisksAndDocuments sale={sale} />
              ) : (
                <div id="risks" className={panelStyles.riskCard}>
                  <h2>Points à vérifier</h2>
                  <p>Consultez les pièces et faites confirmer l’état du bien avant de décider.</p>
                  <a href="#documents">Voir les pièces disponibles</a>
                </div>
              )}
              <UrbanismeSection
                sale={sale}
                loadStructuredUrbanism={
                  access === "analysis" && !publicDemo && !authLoading && Boolean(user)
                }
              />
              <details className={panelStyles.disclosure}>
                <summary>Vérifications de la source</summary>
                <ListingQualityNotice sale={sale} />
              </details>
            </>
          ) : null}

          {activeTab === "estimation" ? (
            <>
              <PanelIntro
                eyebrow="02 / Prix"
                title={isTribunalSale ? "Prix et mise plafond" : "Prix et marché"}
                description={
                  isTribunalSale
                    ? "Les trois montants à comparer avant de définir votre scénario."
                    : "Le prix publié et les références de marché disponibles."
                }
              />
              {access === "analysis" &&
              marketEstimateOverride == null &&
              !marketEstimate &&
              (marketQuery.data?.error || marketQuery.error) ? (
                <div className={panelStyles.warning} role="status" aria-live="polite">
                  <div>
                    <strong>Estimation de marché à compléter</strong>
                    <p>
                      {marketQuery.data?.error ??
                        (marketQuery.error instanceof Error
                          ? marketQuery.error.message
                          : "L’estimation est momentanément indisponible.")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void marketQuery.refetch()}
                    disabled={marketQuery.isFetching}
                  >
                    {marketQuery.isFetching ? "Calcul en cours…" : "Relancer l’estimation"}
                  </button>
                </div>
              ) : null}
              <section id="summary" className="scroll-mt-36">
                {valuationConflict ? (
                  <div role="alert" className={panelStyles.warning}>
                    <div>
                      <h2>Estimation suspendue : données contradictoires</h2>
                      <p>{valuationConflict}</p>
                      {access === "analysis" ? (
                        <p>
                          Les caractéristiques seront vérifiées par ImmoJudis avant toute mise à
                          jour.
                        </p>
                      ) : (
                        <a href="#rendez-vous">Consulter les coordonnées du dossier</a>
                      )}
                    </div>
                  </div>
                ) : access === "analysis" && isTribunalSale ? (
                  <AnalysisDecisionPanel
                    sale={sale}
                    marketEstimate={marketEstimate}
                    marketLoading={marketQuery.isLoading && marketEstimate == null}
                    worksBudget={
                      activeSimulation?.worksKnown === false
                        ? null
                        : (activeSimulation?.works ?? (surface == null ? null : worksBudget))
                    }
                    recommendedCeiling={heroCeilingResult.maxBid}
                    ceilingAvailable={heroCeilingResult.available}
                    onAdjust={() => setCalculationOpen(true)}
                  />
                ) : access === "analysis" ? (
                  <NonJudicialDecisionPanel
                    sale={sale}
                    marketEstimate={marketEstimate}
                    marketLoading={marketQuery.isLoading && marketEstimate == null}
                  />
                ) : (
                  <DiscoveryDecisionPanel sale={sale} />
                )}
              </section>
              {access === "analysis" && isTribunalSale && !valuationConflict ? (
                <>
                  <details
                    id="why-this-ceiling-details"
                    className={panelStyles.disclosure}
                    open={ceilingExplanationOpen}
                    onToggle={(event) => setCeilingExplanationOpen(event.currentTarget.open)}
                  >
                    <summary>Comprendre le calcul du plafond</summary>
                    <CeilingExplanation
                      recommendations={recommendations}
                      surface={surface}
                      resultOverride={activeSimulation?.result}
                      worksOverride={activeSimulation?.works}
                    />
                  </details>
                  <details
                    id="calculation"
                    className={panelStyles.disclosure}
                    open={calculationOpen}
                    onToggle={(event) => setCalculationOpen(event.currentTarget.open)}
                  >
                    <summary>Ajuster les hypothèses</summary>
                    {calculationOpen ? (
                      <BidCeilingAssistant
                        sale={sale}
                        marketEstimateOverride={marketEstimate}
                        onSimulationChange={setSimulation}
                      />
                    ) : null}
                  </details>
                </>
              ) : access === "analysis" ? (
                <details className={panelStyles.disclosure} open={Boolean(expandedDetails.budget)}>
                  <summary
                    onClick={(event) => {
                      event.preventDefault();
                      setDetailOpen("budget", !expandedDetails.budget);
                    }}
                  >
                    Frais et hypothèses
                  </summary>
                  <ListingBudget sale={sale} />
                </details>
              ) : null}
              {access === "analysis" ? (
                <details className={panelStyles.disclosure} open={Boolean(expandedDetails.market)}>
                  <summary
                    onClick={(event) => {
                      event.preventDefault();
                      setDetailOpen("market", !expandedDetails.market);
                    }}
                  >
                    Voir les références de marché
                  </summary>
                  {marketEstimate?.actionable === true || isTribunalSale ? (
                    <MarketEvidence
                      marketEstimate={marketEstimate}
                      marketLoading={marketQuery.isLoading && marketEstimate == null}
                    />
                  ) : (
                    <p>
                      Références insuffisantes pour afficher une estimation exploitable sur cette
                      vente.
                    </p>
                  )}
                </details>
              ) : null}
              {access === "analysis" && !publicDemo && hasVerifiedTribunal ? (
                <TribunalEstimationEvidence
                  sale={sale}
                  valuationConflict={Boolean(valuationConflict)}
                  adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
                  open={Boolean(expandedDetails["tribunal-history"])}
                  onOpenChange={(open) => setDetailOpen("tribunal-history", open)}
                />
              ) : null}
            </>
          ) : null}

          {activeTab === "travaux" ? (
            <>
              <ListingWorks
                sale={sale}
                estimatedBudget={
                  access === "analysis" && isTribunalSale && activeSimulation?.worksKnown === false
                    ? null
                    : (activeSimulation?.works ?? (surface == null ? null : worksBudget))
                }
              />
            </>
          ) : null}

          {activeTab === "financement" ? (
            <>
              <div id="financing" className="scroll-mt-36">
                <FinancingSimulator sale={sale} />
              </div>
            </>
          ) : null}

          {activeTab === "demarches" ? (
            <>
              <PanelIntro
                eyebrow="05 / Participation"
                title="Préparer la vente"
                description="Date, interlocuteur, pièces et étapes à suivre."
              />
              <div className={panelStyles.practical}>
                <ListingPracticalDetails sale={sale} />
              </div>
              <div className={panelStyles.steps}>
                <h2>Vos prochaines étapes</h2>
                <ol>
                  <li>Consulter les conditions et les pièces officielles.</li>
                  <li>Confirmer les visites et les modalités de participation.</li>
                  <li>
                    {isTribunalSale
                      ? "Choisir un avocat compétent avant de préparer une enchère."
                      : "Contacter l’organisateur pour préparer votre dossier."}
                  </li>
                </ol>
              </div>
              <SaleDocumentsSection
                sale={sale}
                open={Boolean(expandedDetails.documents)}
                onOpenChange={(open) => setDetailOpen("documents", open)}
              />
              <LawyerSection sale={sale} />
              <details
                className={panelStyles.disclosure}
                open={Boolean(expandedDetails.participation)}
              >
                <summary
                  onClick={(event) => {
                    event.preventDefault();
                    setDetailOpen("participation", !expandedDetails.participation);
                  }}
                >
                  Voir toutes les conditions de la vente
                </summary>
                <SaleProcedurePanel sale={sale} />
              </details>
              {access === "analysis" && !publicDemo && isTribunalSale && !valuationConflict ? (
                <section
                  aria-label="Sauvegarde et export du rapport"
                  className={panelStyles.reportActions}
                >
                  <h2>Conserver votre analyse</h2>
                  <p>Sauvegardez le dossier ou exportez le rapport avec le scénario courant.</p>
                  <PropertyReportActions
                    saleId={sale.id}
                    compact
                    simulation={
                      activeSimulation?.result.available ? activeSimulation.reportInput : undefined
                    }
                    requireSimulation
                  />
                </section>
              ) : null}
              {access === "analysis" && !publicDemo ? (
                <details
                  className={panelStyles.disclosure}
                  open={Boolean(expandedDetails["professional-pilot"])}
                >
                  <summary
                    onClick={(event) => {
                      event.preventDefault();
                      setDetailOpen("professional-pilot", !expandedDetails["professional-pilot"]);
                    }}
                  >
                    Préparer le dossier de travail
                  </summary>
                  <ProfessionalPilotLauncher
                    sale={sale}
                    definition={
                      isTribunalSale
                        ? buildTribunalPilot(sale)
                        : venueType === "notary"
                          ? buildNotaryPilot(sale)
                          : buildStatePilot(sale)
                    }
                    publicDemo={publicDemo}
                  />
                </details>
              ) : null}
              {access === "analysis" ? <InformationAvailabilityNotice /> : null}
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}

const SALE_DETAIL_TABS = ["apercu", "estimation", "travaux", "financement", "demarches"] as const;
type LegacyDetail =
  | "market"
  | "budget"
  | "participation"
  | "documents"
  | "professional-pilot"
  | "tribunal-history";

function legacyDetailForAnchor(anchor: string, budgetTarget: string): LegacyDetail | null {
  if (["budget", "budget-analysis", "calculation"].includes(anchor)) {
    return budgetTarget === "budget" ? "budget" : null;
  }
  if (
    ["market", "participation", "documents", "professional-pilot", "tribunal-history"].includes(
      anchor,
    )
  ) {
    return anchor as LegacyDetail;
  }
  return null;
}

function isTabAnchor(anchor: string): anchor is SaleDetailTab {
  return SALE_DETAIL_TABS.includes(anchor as SaleDetailTab);
}

function tabForAnchor(anchor: string): SaleDetailTab {
  return knownTabForAnchor(anchor) ?? "apercu";
}

function knownTabForAnchor(anchor: string): SaleDetailTab | null {
  if (isTabAnchor(anchor)) return anchor;
  if (
    ["market", "budget", "budget-analysis", "summary", "calculation", "why-this-ceiling"].includes(
      anchor,
    )
  ) {
    return "estimation";
  }
  if (anchor === "tribunal-history") return "estimation";
  if (anchor === "works") return "travaux";
  if (anchor === "financing") return "financement";
  if (
    ["rendez-vous", "participation", "documents", "lawyer", "professional-pilot"].includes(anchor)
  ) {
    return "demarches";
  }
  if (["description-ia", "localisation", "urbanism", "risks"].includes(anchor)) {
    return "apercu";
  }
  return null;
}

function revealAnchor(anchor: string, budgetTarget: string) {
  const fallback = ["budget", "budget-analysis", "calculation"].includes(anchor)
    ? budgetTarget
    : ["market", "tribunal-history", "why-this-ceiling"].includes(anchor)
      ? "summary"
      : tabForAnchor(anchor) === "demarches"
        ? "sale-detail-panel-demarches"
        : null;
  const target = document.getElementById(anchor) ?? (fallback && document.getElementById(fallback));
  if (!target) return;
  let parent = target.closest("details");
  while (parent) {
    parent.open = true;
    parent = parent.parentElement?.closest("details") ?? null;
  }
  target.scrollIntoView?.({ block: "start" });
}

function PanelIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className={panelStyles.intro}>
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      <span>{description}</span>
    </header>
  );
}

function TribunalEstimationEvidence({
  sale,
  valuationConflict,
  adjudicationStatisticsEnabled,
  open,
  onOpenChange,
}: {
  sale: AuctionSale;
  valuationConflict: boolean;
  adjudicationStatisticsEnabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const forecastQuery = useOutcomeGraphForecast(sale.id, !valuationConflict);
  const forecastReady = !valuationConflict && forecastQuery.data?.forecast.status === "ready";
  return (
    <details className={panelStyles.disclosure} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          onOpenChange(!open);
        }}
      >
        Historique et perspective d’adjudication
      </summary>
      {forecastReady ? <OutcomeForecast forecastQuery={forecastQuery} /> : null}
      <SaleTribunalHistory
        sale={sale}
        premium={adjudicationStatisticsEnabled}
        propertyTypeVerified={!valuationConflict}
      />
    </details>
  );
}

function UrbanismeSection({
  sale,
  loadStructuredUrbanism = false,
}: {
  sale: AuctionSale;
  loadStructuredUrbanism?: boolean;
}) {
  const urbanismQuery = useQuery({
    queryKey: ["sale-urbanisme-cadastre", sale.id, sale.source_url],
    queryFn: () => fetchSaleUrbanismeCadastre(sale.id),
    enabled: loadStructuredUrbanism && Boolean(sale.source_url),
    staleTime: 10 * 60_000,
  });

  return (
    <div id="urbanism" className="mt-6 scroll-mt-36">
      <div>
        {urbanismQuery.isPending && urbanismQuery.isFetching ? (
          <p role="status" className="mb-4 text-sm text-brand-navy/70">
            Chargement des données cadastrales et d’urbanisme collectées pour cette annonce…
          </p>
        ) : null}
        {urbanismQuery.isError ? (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          >
            <p>
              Les données cadastrales complémentaires sont momentanément indisponibles. Le bloc
              ci-dessous repose sur les pièces de l’annonce.
            </p>
            <button
              type="button"
              className="mt-2 font-semibold underline underline-offset-2"
              onClick={() => void urbanismQuery.refetch()}
            >
              Réessayer
            </button>
          </div>
        ) : null}
        <UrbanismeCadastrePanel
          sale={sale}
          cadastralParcels={urbanismQuery.data?.cadastralParcels}
          urbanPlanningSignals={urbanismQuery.data?.urbanPlanningSignals}
        />
      </div>
    </div>
  );
}

function PropertyIdentity({
  sale,
  publicDemo = false,
}: {
  sale: AuctionSale;
  publicDemo?: boolean;
}) {
  const images = propertyImages(sale.media);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  const [mobilePhotoIndex, setMobilePhotoIndex] = useState(0);
  const mobileCarouselRef = useRef<HTMLDivElement>(null);
  const title = saleDisplayTitle(sale, propertyTypeLabel(sale.property_type));
  const address = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const mapLocation = listingCoordinates(sale);

  const handleMobileCarouselScroll = (event: UIEvent<HTMLDivElement>) => {
    const carousel = event.currentTarget;
    if (!carousel.clientWidth) return;
    const nextIndex = Math.round(carousel.scrollLeft / carousel.clientWidth);
    setMobilePhotoIndex(Math.min(Math.max(nextIndex, 0), images.length - 1));
  };

  const goToMobilePhoto = (nextIndex: number) => {
    const carousel = mobileCarouselRef.current;
    if (!carousel || !images.length) return;
    const clampedIndex = Math.min(Math.max(nextIndex, 0), images.length - 1);
    carousel.scrollTo({ left: clampedIndex * carousel.clientWidth, behavior: "smooth" });
    setMobilePhotoIndex(clampedIndex);
  };

  return (
    <div className="min-w-0">
      <div className={listingStyles.photo}>
        {images[0] ? (
          <>
            <div
              ref={mobileCarouselRef}
              role="region"
              aria-roledescription="carrousel"
              aria-label={`Photos de ${title}`}
              onScroll={handleMobileCarouselScroll}
              className="flex h-[clamp(15rem,65vw,22rem)] snap-x snap-mandatory scroll-smooth overflow-x-auto overscroll-x-contain bg-muted [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
            >
              {images.map((image, index) => (
                <button
                  key={`${image.url}-${index}`}
                  type="button"
                  onClick={() => setGalleryIndex(index)}
                  className="group relative block h-full w-full max-w-full flex-none snap-start snap-always overflow-hidden bg-muted text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold"
                  aria-label={`Ouvrir la photo ${index + 1} sur ${images.length}`}
                >
                  <ListingPhoto
                    src={image.url}
                    alt={
                      index === 0
                        ? `Photo principale de ${title}`
                        : `Photo ${index + 1} de ${title}`
                    }
                    className="h-full w-full object-cover"
                    loading={index === 0 ? "eager" : "lazy"}
                    fetchPriority={index === 0 ? "high" : "low"}
                    decoding="async"
                    draggable={false}
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </button>
              ))}
            </div>
            {images.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex - 1)}
                  disabled={mobilePhotoIndex === 0}
                  className="absolute left-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo précédente"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex + 1)}
                  disabled={mobilePhotoIndex === images.length - 1}
                  className="absolute right-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo suivante"
                >
                  <ArrowRight className="h-5 w-5" aria-hidden />
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(0)}
              className="group relative hidden h-[440px] w-full overflow-hidden bg-muted text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold md:block"
              aria-label="Ouvrir la galerie photos"
            >
              <ListingPhoto
                src={images[0].url}
                fetchPriority="high"
                alt={`Photo principale de ${title}`}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.015]"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
            {mapLocation ? (
              <div className="absolute bottom-8 left-3 z-10 md:bottom-4 md:left-4">
                <MapboxPreviewButton
                  mode="streetLevel"
                  lat={mapLocation.lat}
                  lng={mapLocation.lng}
                  label="Quartier 3D"
                  title="Vue 3D du quartier"
                  description={address || "Adresse de l'annonce"}
                  ariaLabel="Afficher la vue 3D Mapbox du quartier"
                  icon={MapPin}
                  className="inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                />
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(mobilePhotoIndex)}
              className="absolute bottom-8 right-3 z-10 inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold md:bottom-4 md:right-4"
              aria-label={`Ouvrir la galerie de ${images.length} photos`}
            >
              <Camera className="h-4 w-4" aria-hidden />
              <span className="md:hidden" aria-live="polite">
                {mobilePhotoIndex + 1} / {images.length}
              </span>
              <span className="hidden md:inline">
                {images.length} photo{images.length > 1 ? "s" : ""}
              </span>
            </button>
          </>
        ) : (
          <SaleVisual
            sale={sale}
            title={title}
            className="h-[250px] md:h-[440px] [&>span]:bottom-8 md:[&>span]:bottom-2"
            eager
          />
        )}
      </div>

      {images.length > 1 ? (
        <div className="mt-2 hidden grid-cols-3 gap-2 md:grid">
          {images.slice(1, 4).map((image, index) => (
            <button
              key={image.url}
              type="button"
              onClick={() => setGalleryIndex(index + 1)}
              className="h-20 overflow-hidden rounded-xl border border-brand-navy/10 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              aria-label={`Ouvrir la photo ${index + 2}`}
            >
              <ListingPhoto
                src={image.url}
                alt={`Photo ${index + 2} de ${title}`}
                compactFallback
                className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
          ))}
        </div>
      ) : null}

      {galleryIndex != null ? (
        <PhotoCarouselDialog
          images={images.map((image, index) => ({
            id: `${image.url}-${index}`,
            url: image.url,
            alt: index === 0 ? `Photo principale de ${title}` : `Photo ${index + 1} de ${title}`,
            source: image.source,
          }))}
          initialIndex={galleryIndex}
          title={title}
          onClose={() => setGalleryIndex(null)}
        />
      ) : null}
    </div>
  );
}

function AnalysisDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
  worksBudget,
  recommendedCeiling,
  ceilingAvailable,
  onAdjust,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
  worksBudget: number | null;
  recommendedCeiling: number;
  ceilingAvailable: boolean;
  onAdjust: () => void;
}) {
  const ceiling = ceilingAvailable ? recommendedCeiling : null;
  const marketValue =
    marketEstimate?.actionable === true ? (marketEstimate.estimatedValueEur ?? null) : null;
  const markers = comparisonMarkerPositions({
    start: sale.starting_price_eur,
    ceiling,
    market: marketValue,
  });

  return (
    <aside className={panelStyles.estimationCard} aria-label="Votre analyse de prix">
      <dl className={panelStyles.priceGrid}>
        {markers.map((marker) => (
          <div key={marker.label}>
            <dt>{marker.label}</dt>
            <dd>
              {marker.value == null
                ? marker.label === "Valeur estimée" && marketLoading
                  ? "Calcul…"
                  : "À compléter"
                : formatPrice(marker.value)}
            </dd>
          </div>
        ))}
      </dl>
      <div className={panelStyles.estimationFoot}>
        <p>
          <strong>
            Travaux inclus : {worksBudget == null ? "À chiffrer" : formatPrice(worksBudget)}
          </strong>
          <span>Plafond indicatif selon vos hypothèses de marché, de frais et de travaux.</span>
        </p>
        <div>
          <a href="#calculation" onClick={onAdjust}>
            Ajuster mes hypothèses
          </a>
          <a href="#why-this-ceiling">Voir le calcul</a>
        </div>
      </div>
      {getMarketValuationSurfaces(sale).builtSurfaceEstimated ? (
        <p className={panelStyles.surfaceCaution}>
          Surface provisoire : {getMarketValuationSurfaces(sale).builtSurfaceAssumption}. À
          confirmer avant de retenir ce plafond.
        </p>
      ) : null}
      {ceiling != null && sale.starting_price_eur != null && ceiling < sale.starting_price_eur ? (
        <p role="status" className={panelStyles.surfaceCaution}>
          Ce scénario donne un plafond inférieur à la mise à prix de{" "}
          {formatPrice(sale.starting_price_eur)}.
        </p>
      ) : null}
    </aside>
  );
}

function NonJudicialDecisionPanel({
  sale,
  marketEstimate,
  marketLoading,
}: {
  sale: AuctionSale;
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
}) {
  const venue = getSaleProcedure(sale).venueType;
  const value =
    marketEstimate?.actionable === true ? (marketEstimate.estimatedValueEur ?? null) : null;
  return (
    <aside className={panelStyles.estimationCard} aria-label="Repères de prix">
      <dl className={panelStyles.priceGrid}>
        <div>
          <dt>{venue === "state" ? "Prix publié" : "Mise à prix"}</dt>
          <dd>
            {sale.starting_price_eur == null ? "À confirmer" : formatPrice(sale.starting_price_eur)}
          </dd>
        </div>
        <div>
          <dt>Valeur estimée</dt>
          <dd>
            {value == null ? (marketLoading ? "Calcul…" : "À compléter") : formatPrice(value)}
          </dd>
        </div>
        <div>
          <dt>Conditions de vente</dt>
          <dd className={panelStyles.textValue}>À vérifier dans le dossier officiel</dd>
        </div>
      </dl>
      <div className={panelStyles.estimationFoot}>
        <p>Les frais et les modalités dépendent des conditions publiées par l’organisateur.</p>
        <a href="#participation">Voir les démarches</a>
      </div>
    </aside>
  );
}

function DiscoveryDecisionPanel({ sale }: { sale: AuctionSale }) {
  return (
    <aside className={panelStyles.estimationCard} aria-label="Aperçu des repères de prix">
      <dl className={panelStyles.priceGrid}>
        <div>
          <dt>Mise à prix</dt>
          <dd>
            {sale.starting_price_eur == null ? "À confirmer" : formatPrice(sale.starting_price_eur)}
          </dd>
        </div>
        <div>
          <dt>Valeur estimée</dt>
          <dd className={panelStyles.textValue}>Avec l’offre Analyse</dd>
        </div>
        <div>
          <dt>Mise plafond</dt>
          <dd className={panelStyles.textValue}>Avec l’offre Analyse</dd>
        </div>
      </dl>
      <div className={panelStyles.estimationFoot}>
        <p>Comparez le prix de départ au marché avant de fixer votre budget.</p>
        <BillingActions hideHelper className={listingStyles.discoveryBilling} />
      </div>
    </aside>
  );
}

function comparisonMarkerPositions({
  start,
  ceiling,
  market,
}: {
  start: number | null;
  ceiling: number | null;
  market: number | null;
}) {
  const values = [start, ceiling, market].filter((value): value is number => value != null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = Math.max(1, max - min);
  const position = (value: number | null, fallback: number) =>
    value == null ? fallback : 8 + ((value - min) / span) * 84;

  return [
    { label: "Mise à prix", value: start, position: position(start, 8) },
    { label: "Mise plafond", value: ceiling, position: position(ceiling, 50) },
    { label: "Valeur estimée", value: market, position: position(market, 92) },
  ];
}

type Recommendations = ReturnType<typeof computeRecommendedCeilings>;

function SaleDocumentsSection({
  sale,
  open,
  onOpenChange,
}: {
  sale: AuctionSale;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const documents = collectSaleDocuments(sale);
  return (
    <section
      id="documents"
      aria-label="Pièces du dossier"
      className="mx-auto max-w-[1260px] scroll-mt-36 px-4 pb-8 sm:px-6 lg:px-8"
    >
      <details
        className="group mt-4 rounded-lg border border-brand-navy/12 bg-white shadow-sm"
        open={open}
      >
        <summary
          className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 sm:px-7"
          onClick={(event) => {
            event.preventDefault();
            onOpenChange(!open);
          }}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
            <FileText className="h-5 w-5" aria-hidden />
          </span>
          <span>
            <span className="block font-display text-2xl font-semibold text-brand-navy">
              Consulter les pièces du dossier
            </span>
            <span className="mt-1 block text-sm text-brand-navy/62">
              {documents.length > 0
                ? "Consultez les pièces jointes ; vérifiez leur nature et leur date."
                : "Aucune pièce attachée à cette annonce pour le moment."}
            </span>
          </span>
          <ChevronDown className="ml-auto h-5 w-5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-brand-navy/10 px-5 py-3 sm:px-7">
          {documents.length > 0 ? (
            <DocumentsList documents={documents} />
          ) : (
            <p role="status" className="text-sm text-brand-navy/70">
              Les pièces vérifiées apparaîtront ici lorsqu’elles seront disponibles.
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

function CeilingExplanation({
  recommendations,
  surface,
  resultOverride,
  worksOverride,
}: {
  recommendations: Recommendations;
  surface: number | null;
  resultOverride?: MarketCeilingResult;
  worksOverride?: number;
}) {
  const result = resultOverride ?? recommendations.withRefreshWorks;
  const works = worksOverride ?? recommendations.refreshWorksBudget;
  const ceilingCosts = computeAcquisitionCosts({
    price: result.maxBid,
    works,
    fpt: result.simulated.fpt,
  });
  const marketBase = result.available
    ? Math.round(result.marketReferencePricePerM2 * Math.max(0, surface ?? 0))
    : null;
  const safetyMargin =
    marketBase != null ? Math.round(marketBase * (result.safetyDiscountPct / 100)) : null;
  const rows = [
    ["Référence de marché du scénario", marketBase],
    ["Marge de sécurité", safetyMargin == null ? null : -safetyMargin],
    [
      "Frais estimés au plafond",
      result.available ? -Math.round(ceilingCosts.acquisitionFeesTotal) : null,
    ],
    ["Travaux inclus", -works],
  ] as const;

  return (
    <div id="why-this-ceiling" className="min-w-0 scroll-mt-36 lg:pr-10">
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Pourquoi {result.available ? formatPrice(result.maxBid) : "ce plafond"} ?
      </h2>
      <dl className="mt-7 border-y border-brand-navy/18">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4 border-b border-brand-navy/12 py-3.5 last:border-b-0"
          >
            <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
            <dd
              className={`font-display text-xl font-semibold sm:text-2xl ${
                value != null && value < 0 ? "text-gold-soft" : "text-brand-navy"
              }`}
            >
              {value == null ? "À compléter" : signedPrice(value)}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 border-t border-brand-navy/50 py-5">
          <dt className="font-display text-2xl font-semibold text-brand-navy">
            Mise plafond recommandée
          </dt>
          <dd className="font-display text-3xl font-semibold text-brand-navy sm:text-4xl">
            {result.available ? formatPrice(result.maxBid) : "À compléter"}
          </dd>
        </div>
      </dl>
      <p className="mt-6 max-w-2xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
        Calcul selon les hypothèses du simulateur. Les frais sont estimés au prix plafond ; les
        arrondis peuvent produire un léger écart avec le total affiché.
      </p>
    </div>
  );
}

function signedPrice(value: number) {
  if (value < 0) return `− ${formatPrice(Math.abs(value))}`;
  return formatPrice(value);
}

function MarketEvidence({
  marketEstimate,
  marketLoading,
}: {
  marketEstimate: MarketEstimate | null;
  marketLoading: boolean;
}) {
  const usesAddressHistory = marketEstimate?.comparableMode === "address_history";
  const comparables = usesAddressHistory
    ? (marketEstimate?.addressHistory ?? []).map((sale) => ({
        ...sale,
        distanceM: null,
        unitCount: null,
      }))
    : (marketEstimate?.recentTransactions ?? []);
  const usesAggregateStatistics = marketEstimate?.comparableMode === "geographic_aggregate";
  const usesParkingSales = marketEstimate?.comparableMode === "unit_sales";
  const sampleCount = usesAddressHistory
    ? (marketEstimate?.addressHistory.length ?? 0)
    : (marketEstimate?.sampleSize ?? 0);
  const sampleLabel = !marketEstimate
    ? "Échantillon indisponible"
    : usesAddressHistory
      ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} à cette adresse`
      : usesParkingSales
        ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de stationnement`
        : usesAggregateStatistics
          ? `${sampleCount} vente${sampleCount > 1 ? "s" : ""} de référence`
          : `${sampleCount} vente${sampleCount > 1 ? "s" : ""} comparable${sampleCount > 1 ? "s" : ""}`;

  return (
    <div id="market" className="min-w-0 scroll-mt-36">
      <h2 className="font-display text-4xl font-medium text-brand-navy sm:text-5xl">
        Marché local
      </h2>
      <dl className="mt-7 grid gap-4">
        <MarketFact
          icon={<BadgeEuro className="h-5 w-5" />}
          label="Valeur estimée"
          value={
            marketEstimate?.estimatedValueEur
              ? formatPrice(marketEstimate.estimatedValueEur)
              : marketLoading
                ? "Calcul…"
                : "À compléter"
          }
        />
        <MarketFact
          icon={<ChartNoAxesCombined className="h-5 w-5" />}
          label={sampleLabel}
          value={
            marketEstimate?.medianUnitPriceEur
              ? `Médiane ${formatPrice(marketEstimate.medianUnitPriceEur)} / place`
              : marketEstimate?.medianPricePerM2
                ? `Médiane ${formatPricePerM2(marketEstimate.medianPricePerM2)}`
                : "Échantillon à compléter"
          }
        />
        <MarketFact
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Solidité des références"
          value={marketReferenceConfidence(marketEstimate).confidenceLabel}
        />
      </dl>

      {marketEstimate && (
        <div className="mt-5 space-y-2 text-sm leading-relaxed text-brand-navy/75">
          <p>
            Source : {marketEstimate.source} · Période de recherche : {marketEstimate.yearsBack} ans
            {usesAddressHistory
              ? " · Historique de la parcelle à cette adresse"
              : usesAggregateStatistics
                ? ` · Échelle ${aggregateScopeLabel(marketEstimate.geographyLevel)}`
                : ` · Rayon de recherche : ${marketEstimate.radiusM} m`}
            .
          </p>
          <p>
            Ce niveau décrit les données disponibles. Il ne garantit ni le prix de revente, ni
            l’état du bien, ni le résultat des enchères.
          </p>
          {usesAddressHistory && (
            <p>
              Repli sur l’historique d’adresse faute de comparables proches. Ces transactions
              peuvent concerner des lots différents ; elles ne prouvent pas une vente antérieure de
              ce logement.
            </p>
          )}
          {marketEstimate.qualityWarnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5" aria-label="Limites des données de marché">
              {marketEstimate.qualityWarnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {comparables.length ? (
        <div className="mt-7 rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <h3 className="font-display text-2xl font-semibold text-brand-navy sm:text-3xl">
            {usesAddressHistory
              ? "Historique des ventes à cette adresse"
              : "Ventes de référence à proximité"}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            {sampleCount} référence{sampleCount > 1 ? "s" : ""} retenue
            {sampleCount > 1 ? "s" : ""} · {comparables.length} détaillée
            {comparables.length > 1 ? "s" : ""} ci-dessous.
          </p>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            Transactions DVF · ces prix ne constituent pas des résultats d’adjudication.
          </p>
          <ul
            className="mt-4 divide-y divide-slate-200 border-t border-slate-200"
            aria-label={usesAddressHistory ? "Historique d’adresse" : "Comparables de marché"}
          >
            {comparables.map((item, index) => (
              <li
                key={`${item.date}-${item.totalPrice}-${index}`}
                className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)_auto] sm:items-center sm:gap-4"
              >
                <div>
                  <p className="text-sm font-semibold">
                    {usesParkingSales
                      ? `${item.unitCount ?? 1} place${(item.unitCount ?? 1) > 1 ? "s" : ""}`
                      : item.surface != null && item.surface > 0
                        ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(item.surface)} m²`
                        : "Surface non renseignée"}
                    {item.distanceM != null ? (
                      <span className="font-normal text-slate-500"> · à {item.distanceM} m</span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">{item.type}</p>
                </div>
                <p className="text-sm text-slate-600">{formatDate(item.date)}</p>
                <div className="sm:text-right">
                  <p className="text-lg font-bold text-brand-navy">
                    {formatPrice(item.totalPrice)}
                  </p>
                  {item.pricePerM2 != null && item.pricePerM2 > 0 ? (
                    <p className="text-xs text-slate-500">{formatPricePerM2(item.pricePerM2)}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-7 border-y border-brand-navy/12 py-5 text-sm leading-relaxed text-brand-navy/64">
          {usesAggregateStatistics
            ? `Estimation indicative fondée sur la médiane DVF à l’échelle ${aggregateScopeLabel(marketEstimate?.geographyLevel)}. Les ventes détaillées apparaîtront dès qu’un échantillon local homogène sera disponible.`
            : "Les ventes comparables seront affichées ici dès qu'un échantillon homogène est disponible."}
        </p>
      )}
    </div>
  );
}

function aggregateScopeLabel(level: MarketEstimate["geographyLevel"]): string {
  if (level === "commune") return "de la commune";
  if (level === "epci") return "de l’intercommunalité";
  return "du département";
}

function MarketFact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3">
      <span className="text-gold-soft" aria-hidden>
        {icon}
      </span>
      <dt className="text-sm font-medium text-brand-navy sm:text-base">{label}</dt>
      <dd className="text-right text-sm font-semibold text-brand-navy sm:text-base">{value}</dd>
    </div>
  );
}

function RisksAndDocuments({ sale }: { sale: AuctionSale }) {
  const risks = sale.risks ?? [];
  const documentCount = collectSaleDocuments(sale).length;
  const preview = risks.slice(0, 2);

  return (
    <section id="risks" className={panelStyles.riskCard} aria-labelledby="risk-summary-title">
      <h2 id="risk-summary-title">Points à vérifier</h2>
      {preview.length ? (
        <ul className={panelStyles.riskPreview}>
          {preview.map((risk) => (
            <li key={`${risk.risk_type}-${risk.risk_label}`}>
              <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />
              <span>{risk.risk_label}</span>
              <strong>
                {risk.severity != null && risk.severity >= 4 ? "Prioritaire" : "À vérifier"}
              </strong>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          Aucun point particulier n’est décrit dans les éléments disponibles. Vérifiez le dossier
          officiel.
        </p>
      )}
      {risks.length > 2 ? (
        <p>
          {risks.length - 2} autre{risks.length > 3 ? "s" : ""} point{risks.length > 3 ? "s" : ""}{" "}
          dans le dossier.
        </p>
      ) : null}
      <p>
        {documentCount > 0 ? `${documentCount} pièce(s) consultable(s)` : "Aucune pièce attachée"}
        {" · "}
        <a href="#documents">Consulter les pièces du dossier</a>
      </p>
      {risks.length ? (
        <details className={panelStyles.riskEvidence}>
          <summary>Voir les sources et actions à confirmer</summary>
          <div>
            {risks.map((risk) => {
              const evidence = riskEvidence(risk);
              return (
                <article key={`${risk.risk_type}-${risk.risk_label}`}>
                  <h3>{risk.risk_label}</h3>
                  <p>{evidence.action}</p>
                  {evidence.proofs.map((proof, index) => (
                    <div key={`${index}-${proof.label}`}>
                      {proof.url ? (
                        <a href={proof.url} target="_blank" rel="noopener noreferrer">
                          {proof.label} (nouvel onglet)
                        </a>
                      ) : (
                        <span>{proof.label}</span>
                      )}
                      {proof.page != null ? <span> · page {proof.page}</span> : null}
                      {proof.excerpt ? <blockquote>{proof.excerpt}</blockquote> : null}
                    </div>
                  ))}
                </article>
              );
            })}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function LawyerSection({ sale }: { sale: AuctionSale }) {
  const procedure = getSaleProcedure(sale);
  const saleStatus = listingSaleStatus(sale);
  const isJudicial = procedure.venueType === "tribunal" && saleProcedureIsConfirmed(procedure);
  const showLawyerDirectory = isJudicial && !saleStatus;
  const organizerName = procedure.organizerName?.trim() || null;
  const hasOrganizerContact = Boolean(procedure.organizerContact?.trim());
  const isPersistedSale =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sale.id);
  const directoryHref = isPersistedSale
    ? `/avocats?saleId=${encodeURIComponent(sale.id)}&city=${encodeURIComponent(sale.city ?? "")}`
    : `/avocats?city=${encodeURIComponent(sale.city ?? "")}`;

  return (
    <section id="lawyer" className="scroll-mt-36 bg-white">
      <div className="mx-auto max-w-[1380px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid gap-7 rounded-lg border border-[#a9c9df] bg-[#eef7ff] p-6 sm:p-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(420px,1.15fr)] lg:items-center">
          <div>
            <h2 className="font-display text-3xl font-medium leading-tight text-brand-navy sm:text-4xl">
              {saleStatus
                ? saleStatus
                : isJudicial
                  ? "Prêt à enchérir ? Mandatez l’avocat compétent."
                  : "Préparez votre participation avec l’organisateur."}
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
              {saleStatus
                ? "Contactez l’organisateur pour confirmer le résultat ou les suites de la vente avant de préparer une participation."
                : isJudicial
                  ? "La représentation par avocat est obligatoire : il vérifie le dossier, reçoit votre mandat et porte les enchères."
                  : `${lawyerRequirementLabel(procedure)}. Participation ${participationModeLabel(procedure.participationMode).toLowerCase()} selon les conditions de la vente.`}
            </p>
          </div>
          <div className="rounded-lg border border-brand-navy/14 bg-white p-5 shadow-sm sm:flex sm:items-center sm:gap-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-gold/10 text-gold-soft">
              <Scale className="h-6 w-6" aria-hidden />
            </span>
            <div className="mt-3 min-w-0 flex-1 sm:mt-0">
              <p className="font-display text-2xl font-semibold text-brand-navy">
                {showLawyerDirectory
                  ? (procedure.eligibleBar ?? sale.tribunal_city ?? "Barreau compétent")
                  : (organizerName ?? "Organisateur à confirmer")}
              </p>
              <p className="mt-1 text-sm text-brand-navy/70">
                {showLawyerDirectory
                  ? "Avocats référencés par Immojudis"
                  : hasOrganizerContact
                    ? "Coordonnées mentionnées dans le dossier"
                    : "Coordonnées non renseignées"}
              </p>
            </div>
            {showLawyerDirectory ? (
              <a
                href={directoryHref}
                className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-soft sm:mt-0"
              >
                Voir les avocats disponibles
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            ) : hasOrganizerContact ? (
              <a
                href="#rendez-vous"
                className="mt-4 inline-flex min-h-11 items-center justify-center rounded-md bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gold-soft sm:mt-0"
              >
                Consulter les coordonnées du dossier
              </a>
            ) : (
              <p className="mt-4 text-sm text-brand-navy/70 sm:mt-0">
                Coordonnées à confirmer par ImmoJudis.
              </p>
            )}
          </div>
          {isPersistedSale && isJudicial && !saleStatus ? (
            <div className="lg:col-start-2">
              <LawyerReferralButton saleId={sale.id} className="min-h-11 w-full sm:w-auto" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function InformationAvailabilityNotice() {
  return (
    <section
      aria-labelledby="information-availability-title"
      className="border-b border-brand-navy/10 bg-[#eef7ff]"
    >
      <div className="mx-auto max-w-[1260px] px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-lg border border-[#a9c9df] bg-white p-5 shadow-sm sm:p-7">
          <h2
            id="information-availability-title"
            className="font-display text-2xl font-semibold text-brand-navy"
          >
            Informations complémentaires
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-brand-navy/70">
            Les enrichissements sont initiés et validés par ImmoJudis. Les informations et pièces
            confirmées seront ajoutées à cette annonce lorsqu’elles seront disponibles.
          </p>
        </div>
      </div>
    </section>
  );
}
