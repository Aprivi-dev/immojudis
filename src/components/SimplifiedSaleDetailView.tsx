"use client";

import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import { listingValuationConflict } from "@/lib/listing-evidence";
import { useAuth } from "@/hooks/use-auth";
import { salesReturnHref, salesReturnLabel } from "@/lib/navigation";
import { DocumentReadingSection } from "@/components/sale-detail/DocumentReadingSection";
import { SalePassagesSection } from "@/components/sale-detail/SalePassagesSection";
import { SaleUnlockPanel } from "@/components/sale-detail/SaleUnlockPanel";
import { SalePointsToVerify } from "@/components/sale-detail/SalePointsToVerify";
import { pointsToVerify } from "@/lib/search/points-to-verify";
import { SaleUnlockOfferProvider } from "@/components/sale-detail/UnlockCallToAction";
import type { SaleUnlockResult, SaleUnlockStatus } from "@/lib/sale-unlocks";
import { AuctionScenariosSection } from "@/components/sale-detail/AuctionScenariosSection";
import { ListingEnvironmentalRisks } from "@/components/sale-detail/ListingEnvironmentalRisks";
import { ListingWeatherHistory } from "@/components/sale-detail/ListingWeatherHistory";
import { EXAMPLE_COMMUNE_RISKS } from "@/lib/example-commune-risks";
import { SaleProcedurePanel } from "@/components/SaleProcedurePanel";
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
import { ListingCharacteristics } from "@/components/sale-detail/ListingCharacteristics";
import { ListingPreparation } from "@/components/sale-detail/ListingPreparation";
import { SaleKeyFactsBand } from "@/components/sale-detail/SaleKeyFactsBand";
import type { WorksBreakdownItem } from "@/lib/works-breakdown";
import type { FinancingDraft, FinancingResult } from "@/components/sale-detail/FinancingSimulator";
import type { ListingRentalDraft } from "@/components/sale-detail/ListingRental";
import { SaleDetailTabNav, type SaleDetailTab } from "@/components/sale-detail/SaleDetailTabNav";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import listingStyles from "@/components/sale-detail/SaleListing.module.css";
import {
  fetchPrecomputedMarketEstimate,
  fetchSaleAiReviewProjections,
  fetchSaleFactReliabilities,
} from "@/lib/client-api";
import type { MarketEstimate } from "@/lib/market.server";
import { isDetailedMarketEstimate } from "@/lib/market-estimate-ceiling";
import { computeAcquisitionCosts } from "@/lib/profitability";
import { buildCeilingHypotheses } from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan, maxWorksAtBid } from "@/lib/bid-ceiling-engine";
import { ceilingGap, valueGapReason } from "@/lib/bid-ceiling-gaps";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { CeilingPlanner } from "@/components/ceiling/CeilingPlanner";
import { LaunchOfferIncludedTag } from "@/components/LaunchOfferIncludedTag";
import {
  choicesWithoutWorksBreakdown,
  useCeilingChoices,
  worksChoiceForAmount,
} from "@/components/ceiling/use-ceiling-choices";
import Link from "next/link";
import { listingCoordinates } from "@/lib/sale-listing";
import {
  getSaleProcedure,
  saleHasVerifiedTribunal,
  saleIsTribunalVenue,
} from "@/lib/sale-procedure";
import { getMarketValuationSurfaces } from "@/lib/surface";
import { buildReportRentalScenario } from "@/lib/report-simulation";
import {
  AI_REVIEW_SURFACE_FIELD_KEYS,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import type { AuctionSale } from "@/lib/types";
import { userMessage } from "@/lib/user-messages";
import { queryKeys } from "@/lib/query-keys";
import {
  isTabAnchor,
  knownTabForAnchor,
  type LegacyDetail,
  legacyDetailForAnchor,
  revealAnchor,
  tabForAnchor,
} from "@/components/sale-detail/sale-detail-anchors";
import { saleForAiReviewDisplay } from "@/components/sale-detail/ai-review-display";
import { PropertyIdentity } from "@/components/sale-detail/SaleDetailPropertyIdentity";
import {
  AnalysisDecisionPanel,
  DiscoveryDecisionPanel,
  NonJudicialDecisionPanel,
} from "@/components/sale-detail/SaleDetailDecisionPanels";
import {
  MarketEvidence,
  MarketSnapshot,
  TribunalEstimationEvidence,
} from "@/components/sale-detail/SaleDetailMarket";
import {
  LawyerSection,
  PanelIntro,
  RisksAndDocuments,
  SaleDocumentsSection,
  UrbanismeSection,
} from "@/components/sale-detail/SaleDetailSections";

const ListingStatistics = dynamic(
  () =>
    import("@/components/sale-detail/ListingStatistics").then((module) => module.ListingStatistics),
  {
    loading: () => (
      <p className="p-6 text-sm text-muted-foreground">Chargement des statistiques du tribunal…</p>
    ),
  },
);
const PropertyReportActions = dynamic(
  () => import("@/components/PropertyReportActions").then((module) => module.PropertyReportActions),
  {
    loading: () => (
      <p className="mt-3 text-sm text-muted-foreground">Chargement des actions du rapport…</p>
    ),
  },
);
// « Mon dossier » gratuit (point 68) : chargé à la demande, hors du JavaScript initial de la fiche.
const SaleFileCard = dynamic(() =>
  import("@/components/sale-detail/SaleFileCard").then((module) => module.SaleFileCard),
);
const ListingWorks = dynamic(
  () => import("@/components/sale-detail/ListingWorks").then((module) => module.ListingWorks),
  {
    loading: () => <p className="p-6 text-sm text-muted-foreground">Chargement des travaux…</p>,
  },
);
const FinancingSimulator = dynamic(
  () =>
    import("@/components/sale-detail/FinancingSimulator").then(
      (module) => module.FinancingSimulator,
    ),
  {
    loading: () => <p className="p-6 text-sm text-muted-foreground">Chargement du financement…</p>,
  },
);
const ListingRental = dynamic(() =>
  import("@/components/sale-detail/ListingRental").then((module) => module.ListingRental),
);

/**
 * What the account reads: the free view, a sale unlocked with « 3 déblocages par mois » (the sale
 * rows are open, and the bid ceiling, document reading, sale history, tribunal statistics and
 * official documents with them), or the full Analyse view.
 */
type SaleDetailAccess = "discovery" | "unlocked" | "analysis";

type SaleDetailProps = {
  sale: AuctionSale;
  marketEstimateOverride?: MarketEstimate | null;
  returnTo?: string;
  /** Libellé du lien de retour ; absent : il suit la page d'origine (voir `salesReturnLabel`). */
  backLabel?: string;
  publicDemo?: boolean;
  adjudicationStatisticsEnabled?: boolean;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  /** Where the account stands this month; drives the « Débloquer cette vente » panel. */
  unlockStatus?: SaleUnlockStatus | null;
  /** The sale was unlocked on this page a moment ago: the result takes the focus. */
  justUnlocked?: boolean;
  onSaleUnlocked?: (result: SaleUnlockResult) => void;
};

export function AnalysisSaleDetailView({
  sale,
  marketEstimateOverride = null,
  returnTo = "/sales",
  backLabel,
  publicDemo = false,
  adjudicationStatisticsEnabled = false,
  aiReviewProjections = null,
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
      aiReviewProjections={aiReviewProjections}
      access="analysis"
    />
  );
}

export function FreeSaleDetailView({
  sale,
  returnTo = "/sales",
  adjudicationStatisticsEnabled = false,
  aiReviewProjections = null,
  unlockStatus = null,
  justUnlocked = false,
  onSaleUnlocked,
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      key={sale.id}
      sale={sale}
      returnTo={returnTo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      aiReviewProjections={aiReviewProjections}
      unlockStatus={unlockStatus}
      justUnlocked={justUnlocked}
      onSaleUnlocked={onSaleUnlocked}
      access="discovery"
    />
  );
}

/** A Découverte account reading a sale it unlocked (« 3 déblocages par mois »). */
export function UnlockedSaleDetailView({
  sale,
  returnTo = "/sales",
  adjudicationStatisticsEnabled = false,
  aiReviewProjections = null,
  unlockStatus = null,
  justUnlocked = false,
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      key={sale.id}
      sale={sale}
      returnTo={returnTo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      aiReviewProjections={aiReviewProjections}
      unlockStatus={unlockStatus}
      justUnlocked={justUnlocked}
      access="unlocked"
    />
  );
}

function SimplifiedSaleDetailView(props: SaleDetailProps & { access: SaleDetailAccess }) {
  const { user } = useAuth();
  return <SaleDetailWorkspace key={`${user?.id ?? "guest-demo"}:${props.sale.id}`} {...props} />;
}

function SaleDetailWorkspace({
  sale,
  marketEstimateOverride = null,
  returnTo,
  backLabel,
  publicDemo = false,
  adjudicationStatisticsEnabled = false,
  aiReviewProjections = null,
  unlockStatus = null,
  justUnlocked = false,
  onSaleUnlocked,
  access,
}: SaleDetailProps & { access: SaleDetailAccess }) {
  const [personalWorksBudget, setPersonalWorksBudget] = useState<number | null>(null);
  const [financingDraft, setFinancingDraft] = useState<FinancingDraft | null>(null);
  const [financingResult, setFinancingResult] = useState<FinancingResult | null>(null);
  const [rentalDraft, setRentalDraft] = useState<ListingRentalDraft | null>(null);
  const { user, loading: authLoading } = useAuth();
  const ceilingChoices = useCeilingChoices(user?.id ?? "guest-demo", sale.id);
  // The sale rows are open (Analyse, or a sale this account unlocked). Everything below that
  // only Analyse has stays on `access === "analysis"`.
  const fullData = access !== "discovery";
  const aiReviewQuery = useQuery({
    queryKey: queryKeys.saleAiReview(sale.id, user?.id ?? "anonymous"),
    queryFn: () => fetchSaleAiReviewProjections(sale.id),
    enabled: Boolean(
      fullData && user && !publicDemo && !authLoading && aiReviewProjections == null,
    ),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const aiReviewStatus: AiReviewRequestStatus =
    access === "discovery"
      ? "disabled"
      : aiReviewProjections !== null
        ? "ready"
        : !user || publicDemo || authLoading
          ? "disabled"
          : aiReviewQuery.isError
            ? "error"
            : aiReviewQuery.data
              ? "ready"
              : "loading";
  const resolvedAiReviewProjections = fullData
    ? (aiReviewProjections ?? aiReviewQuery.data?.projections ?? null)
    : null;
  const displaySale = useMemo(
    () => saleForAiReviewDisplay(sale, resolvedAiReviewProjections, aiReviewStatus),
    [aiReviewStatus, resolvedAiReviewProjections, sale],
  );
  const factReliabilityQuery = useQuery({
    queryKey: queryKeys.saleFactReliability(sale.id, user?.id ?? "anonymous"),
    queryFn: () => fetchSaleFactReliabilities(sale.id),
    // The reliability of the listing facts is an Analyse read: an unlocked sale does not open it.
    enabled: Boolean(access === "analysis" && user && !publicDemo && !authLoading),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const factReliabilities =
    access === "analysis" ? (factReliabilityQuery.data?.facts ?? null) : null;
  const valuationConflict = listingValuationConflict(sale);
  const priceReview = getAiReviewFieldResult(
    resolvedAiReviewProjections,
    "sale.starting_price_eur",
    aiReviewStatus,
  );
  const surfaceBlocked = AI_REVIEW_SURFACE_FIELD_KEYS.some(
    (fieldKey) =>
      getAiReviewFieldResult(resolvedAiReviewProjections, fieldKey, aiReviewStatus).blocked,
  );
  const propertyTypeReview = getAiReviewFieldResult(
    resolvedAiReviewProjections,
    "property.property_type",
    aiReviewStatus,
  );
  const roomsReview = getAiReviewFieldResult(
    resolvedAiReviewProjections,
    "property.rooms_count",
    aiReviewStatus,
  );
  const criticalAnalysisInputsBlocked =
    priceReview.blocked || surfaceBlocked || propertyTypeReview.blocked || roomsReview.blocked;
  const isTribunalSale = saleIsTribunalVenue(sale);
  // Les statistiques des tribunaux restent fermées tant que le drapeau l'est : ni l'onglet, ni
  // son aperçu verrouillé, ni les ancres qui y mènent.
  const statisticsAvailable = isTribunalSale && adjudicationStatisticsEnabled;
  const budgetTarget =
    fullData && isTribunalSale && !valuationConflict
      ? "calculation"
      : access === "analysis"
        ? "budget"
        : "summary";
  const hasVerifiedTribunal = saleHasVerifiedTribunal(sale);
  const venueType = getSaleProcedure(sale).venueType;
  // Le dossier de travail (offre Analyse) existe pour les ventes au tribunal, chez le notaire et
  // domaniales ; « Mon dossier » en est l'unique porte.
  const workspaceAvailable =
    access === "analysis" &&
    !publicDemo &&
    (venueType === "tribunal" || venueType === "notary" || venueType === "state");
  const marketSurfaces = getMarketValuationSurfaces(displaySale);
  const surface = criticalAnalysisInputsBlocked ? null : marketSurfaces.builtSurfaceM2;
  // The market estimate feeds the bid ceiling (judicial sales) and, for Analyse, the market blocks.
  const marketAccess = access === "analysis" || (access === "unlocked" && isTribunalSale);
  const marketQuery = useQuery({
    queryKey: queryKeys.precomputedMarketEstimate(sale.id, user?.id, access),
    queryFn: () => fetchPrecomputedMarketEstimate({ saleId: sale.id }),
    enabled:
      marketAccess &&
      marketEstimateOverride == null &&
      !valuationConflict &&
      !criticalAnalysisInputsBlocked,
    staleTime: 24 * 60 * 60_000,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" && !query.state.data.estimate ? 15_000 : false,
  });
  // What the ceiling reads: the whole estimate (Analyse) or its ceiling projection (unlock).
  const marketEstimate =
    !marketAccess || valuationConflict || criticalAnalysisInputsBlocked
      ? null
      : (marketEstimateOverride ?? marketQuery.data?.estimate ?? null);
  // The detailed blocks (range, references, comparables) exist for Analyse only.
  const detailedMarketEstimate =
    access === "analysis" && isDetailedMarketEstimate(marketEstimate) ? marketEstimate : null;
  const ceilingEnabled =
    fullData && isTribunalSale && !valuationConflict && !criticalAnalysisInputsBlocked;
  const ceilingHypotheses = useMemo(() => {
    const built = buildCeilingHypotheses(displaySale, ceilingEnabled ? marketEstimate : null, {
      ...ceilingChoices.choices,
      works:
        ceilingChoices.choices.works ?? worksChoiceForAmount(surface, personalWorksBudget ?? 0),
    });
    return { ...built, surface: ceilingEnabled ? surface : null };
  }, [
    ceilingChoices.choices,
    ceilingEnabled,
    displaySale,
    marketEstimate,
    personalWorksBudget,
    surface,
  ]);
  const ceilingPlan = useMemo(() => computeCeilingPlan(ceilingHypotheses), [ceilingHypotheses]);
  const marketPending = marketQuery.isLoading && marketEstimate == null;
  const valueReason = marketPending
    ? "estimation en cours"
    : valueGapReason({ surface, marketStatus: marketQuery.data?.status });
  const ceilingMissing = ceilingGap(ceilingPlan, valueReason);
  const dpeClass = useMemo(() => buildDpeAnalysis(displaySale).class, [displaySale]);
  // Aucun travaux n'est supposé tant que l'utilisateur n'en a pas chiffré.
  const retainedWorks =
    !fullData || valuationConflict || criticalAnalysisInputsBlocked
      ? null
      : ceilingHypotheses.works.amount;
  const projectCosts =
    ceilingEnabled && retainedWorks != null && (displaySale.starting_price_eur ?? 0) > 0
      ? computeAcquisitionCosts({
          price: displaySale.starting_price_eur!,
          works: retainedWorks,
          ...ceilingHypotheses.fees,
        })
      : null;
  const activeFinancingResult =
    (!valuationConflict && !criticalAnalysisInputsBlocked) ||
    financingDraft?.projectPriceSource === "manual"
      ? financingResult
      : null;
  const reportSimulation = useMemo(() => {
    if (!ceilingEnabled || !ceilingPlan.available || !ceilingPlan.reachable) return undefined;
    const rentalScenario = buildReportRentalScenario({
      draft: rentalDraft,
      acquisitionCost: activeFinancingResult?.totalProjectCost ?? projectCosts?.totalCost ?? null,
      monthlyDebtService: activeFinancingResult?.monthlyPayment ?? null,
    });
    return {
      version: 2 as const,
      // Le détail des postes reste dans le navigateur : seul le budget retenu est enregistré.
      choices: {
        ...choicesWithoutWorksBreakdown(ceilingChoices.choices),
        works: ceilingHypotheses.works,
      },
      expectedMaxBid: ceilingPlan.maxBid,
      ...(rentalScenario ? { rentalScenario } : {}),
    };
  }, [
    activeFinancingResult,
    ceilingChoices.choices,
    ceilingEnabled,
    ceilingHypotheses.works,
    ceilingPlan,
    projectCosts,
    rentalDraft,
  ]);
  // Scenario (or « Aucun travaux ») picked in the Travaux tab. Without a ceiling (non-judicial
  // sale), the amount only feeds the displayed budget.
  const selectWorksBudget = (amount: number) => {
    if (access !== "analysis" || !Number.isFinite(amount) || amount < 0) return;
    setPersonalWorksBudget(Math.max(0, amount));
    if (ceilingEnabled) {
      ceilingChoices.update((choices) => ({
        ...choices,
        works: worksChoiceForAmount(surface, amount),
      }));
    }
  };
  // « Détail de vos travaux » : les postes restent dans le navigateur avec les autres choix, et leur
  // total (quand il est supérieur à 0) devient le budget travaux. Un détail vidé ne touche pas au
  // budget : celui-ci a pu être saisi autrement.
  const changeWorksBreakdown = (items: WorksBreakdownItem[], total: number) => {
    ceilingChoices.update((choices) =>
      items.length ? { ...choices, worksBreakdown: items } : choicesWithoutWorksBreakdown(choices),
    );
    if (total > 0) selectWorksBudget(total);
  };
  const heroCeiling =
    ceilingEnabled && ceilingPlan.available && ceilingPlan.reachable ? ceilingPlan.maxBid : null;
  const ceilingContext =
    heroCeiling != null
      ? {
          worksAmount: ceilingHypotheses.works.amount,
          worksPriced: ceilingChoices.choices.works != null || personalWorksBudget != null,
          marginPct: ceilingPlan.marginPct + ceilingPlan.dataMarginPct,
          valueAmount: ceilingHypotheses.value.amount,
          valueSource:
            ceilingHypotheses.value.source === "saisie"
              ? "votre prix au m²"
              : (marketEstimate?.source ?? "DVF"),
          valueDate:
            ceilingHypotheses.value.source === "saisie"
              ? null
              : (marketEstimate?.sourceUpdatedAt ?? marketQuery.data?.computedAt ?? null),
        }
      : null;

  const [activeTab, setActiveTab] = useState<SaleDetailTab>("apercu");
  const [anchorVisit, setAnchorVisit] = useState(0);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
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
      setActiveTab(tabForAnchor(anchor, statisticsAvailable));
      const detail = legacyDetailForAnchor(anchor, budgetTarget);
      if (detail) setDetailOpen(detail, true);
      setAnchorVisit((current) => current + 1);
    };
    syncTabWithHash();
    window.addEventListener("hashchange", syncTabWithHash);
    return () => window.removeEventListener("hashchange", syncTabWithHash);
  }, [budgetTarget, statisticsAvailable]);

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
    const tab = knownTabForAnchor(anchor, statisticsAvailable);
    if (!tab) return;
    const detail = legacyDetailForAnchor(anchor, budgetTarget);
    if (detail) setDetailOpen(detail, true);
    const target = document.getElementById(anchor);
    if (tab === activeTab && target && !target.closest("details:not([open])")) return;
    event.preventDefault();
    window.history.pushState(null, "", `#${anchor}`);
    setActiveTab(tab);
    setAnchorVisit((current) => current + 1);
  };

  // The previews that say « ou en débloquant cette vente » link to the unlock card, which exists
  // only for a signed-in Découverte account on a sale that can be unlocked and is not unlocked yet.
  const unlockOffer =
    !publicDemo &&
    user &&
    access === "discovery" &&
    unlockStatus?.unlockable &&
    !unlockStatus.unlocked
      ? unlockStatus
      : null;

  return (
    <SaleUnlockOfferProvider status={unlockOffer}>
      <main id="contenu" className={listingStyles.page} onClickCapture={handleSectionLink}>
        <div className={listingStyles.container}>
          <div className={listingStyles.topbar}>
            <Link
              href={salesReturnHref(returnTo, sale.id)}
              className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold text-brand-navy transition-colors hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {backLabel ?? salesReturnLabel(returnTo)}
            </Link>
            <ListingActions sale={displaySale} publicDemo={publicDemo} />
          </div>
          <div className={listingStyles.upper}>
            <PropertyIdentity
              key={sale.id}
              sale={displaySale}
              aiReviewProjections={resolvedAiReviewProjections}
              aiReviewStatus={aiReviewStatus}
              publicDemo={publicDemo}
            />
            <div className={listingStyles.heroSummary}>
              <ListingOverview
                sale={displaySale}
                publicDemo={publicDemo}
                premiumCeiling={heroCeiling}
                ceilingContext={ceilingContext}
                showPremiumTeaser={access === "discovery" && isTribunalSale}
                factReliabilities={factReliabilities}
                aiReviewProjections={resolvedAiReviewProjections}
                aiReviewStatus={aiReviewStatus}
                scenarioSummary={
                  projectCosts
                    ? {
                        purchasePrice: projectCosts.price,
                        works: projectCosts.works,
                        totalCost: projectCosts.totalCost,
                        marketValue: marketEstimate?.actionable
                          ? (marketEstimate.estimatedValueEur ?? null)
                          : null,
                        personalized:
                          ceilingChoices.choices.works != null || personalWorksBudget != null,
                      }
                    : null
                }
              />
            </div>
          </div>
          <SaleKeyFactsBand
            sale={displaySale}
            aiReviewProjections={resolvedAiReviewProjections}
            aiReviewStatus={aiReviewStatus}
          />
          {/* Cible de `#points-a-verifier` : les points de la pastille de la liste. */}
          <SalePointsToVerify
            className="mt-4"
            points={pointsToVerify(displaySale, { occupancyVisible: true })}
            saleId={sale.id}
          />
          <ListingPreparation
            key={`${user?.id ?? "guest-demo"}:${sale.id}`}
            sale={displaySale}
            publicDemo={publicDemo}
            ownerId={user?.id ?? "guest-demo"}
            factReliabilities={factReliabilities}
            aiReviewProjections={resolvedAiReviewProjections}
            aiReviewStatus={aiReviewStatus}
            canSimulate={
              fullData && isTribunalSale && !valuationConflict && !criticalAnalysisInputsBlocked
            }
          />
          {!publicDemo && user && access !== "analysis" ? (
            <SaleUnlockPanel
              saleId={sale.id}
              status={unlockStatus}
              // Just unlocked, while the unlocked read is still loading: the free view stays on screen
              // and the card already says so.
              unlocked={access === "unlocked" || unlockStatus?.unlocked === true}
              opens={{ ceiling: isTribunalSale, statistics: statisticsAvailable }}
              announce={justUnlocked}
              onUnlocked={(result) => onSaleUnlocked?.(result)}
            />
          ) : null}
          {!publicDemo && user ? (
            <SaleFileCard
              saleId={sale.id}
              calculatedCeiling={heroCeiling}
              calculationPending={ceilingEnabled && marketPending}
              // « Mon dossier » est l'unique porte du dossier de travail (offre Analyse).
              onOpenWorkspace={workspaceAvailable ? () => setWorkspaceOpen(true) : undefined}
            />
          ) : null}
          {workspaceAvailable && workspaceOpen ? (
            <ProfessionalPilotLauncher
              sale={displaySale}
              definition={
                venueType === "tribunal"
                  ? buildTribunalPilot(displaySale)
                  : venueType === "notary"
                    ? buildNotaryPilot(displaySale)
                    : buildStatePilot(displaySale)
              }
              publicDemo={publicDemo}
              open
              onOpenChange={setWorkspaceOpen}
            />
          ) : null}
        </div>

        <div id="annonce-sections" className={panelStyles.tabRegion}>
          <SaleDetailTabNav
            activeTab={activeTab}
            onTabChange={changeTab}
            showStatistics={statisticsAvailable}
          />
          <div
            id={`sale-detail-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`sale-detail-tab-${activeTab}`}
            tabIndex={0}
            className={panelStyles.panel}
          >
            {activeTab === "apercu" ? (
              <>
                <PanelIntro eyebrow="01 / Le bien" title="L’essentiel sur le bien" />
                <div className={panelStyles.twoColumns}>
                  <ListingDescription
                    sale={displaySale}
                    aiReviewProjections={resolvedAiReviewProjections}
                    aiReviewStatus={aiReviewStatus}
                  />
                  <ListingLocation
                    sale={displaySale}
                    aiReviewProjections={resolvedAiReviewProjections}
                    aiReviewStatus={aiReviewStatus}
                  />
                </div>
                <ListingCharacteristics sale={displaySale} />
                <LaunchOfferIncludedTag />
                <DocumentReadingSection
                  saleId={sale.id}
                  enabled={!publicDemo && !authLoading && Boolean(user)}
                  access={access}
                  userKey={user?.id}
                />
                <SalePassagesSection
                  saleId={sale.id}
                  startingPrice={displaySale.starting_price_eur ?? null}
                  enabled={!publicDemo && !authLoading && Boolean(user)}
                  access={access}
                  userKey={user?.id}
                />
                {access === "analysis" ? (
                  <RisksAndDocuments sale={displaySale} />
                ) : (
                  <div id="risks" className={panelStyles.riskCard}>
                    <h2>Points à vérifier</h2>
                    <p>Consultez les pièces et faites confirmer l’état du bien avant de décider.</p>
                    <a href="#documents">Voir les pièces disponibles</a>
                  </div>
                )}
                <UrbanismeSection
                  sale={displaySale}
                  mapLocation={sale}
                  loadStructuredUrbanism={
                    access === "analysis" && !publicDemo && !authLoading && Boolean(user)
                  }
                />
                <ListingEnvironmentalRisks
                  saleId={sale.id}
                  demoProfile={publicDemo ? EXAMPLE_COMMUNE_RISKS : undefined}
                  enabled={
                    !getAiReviewFieldResult(
                      resolvedAiReviewProjections,
                      "property.city",
                      aiReviewStatus,
                    ).blocked &&
                    Boolean(
                      displaySale.city ||
                      displaySale.postal_code ||
                      listingCoordinates(displaySale),
                    )
                  }
                />
                {!publicDemo ? <ListingWeatherHistory saleId={sale.id} /> : null}
              </>
            ) : null}

            {activeTab === "estimation" ? (
              <>
                <PanelIntro
                  eyebrow="02 / Prix"
                  title={isTribunalSale ? "Prix et enchère plafond" : "Prix et marché"}
                  description={
                    isTribunalSale
                      ? "Les trois montants à comparer avant de définir votre scénario."
                      : "Le prix publié et les références de marché disponibles."
                  }
                />
                {marketAccess &&
                marketEstimateOverride == null &&
                !marketEstimate &&
                (marketQuery.data?.error || marketQuery.error) ? (
                  <div className={panelStyles.warning} role="status" aria-live="polite">
                    <div>
                      <strong>Estimation de marché à compléter</strong>
                      <p>
                        {marketQuery.data?.error ??
                          userMessage(
                            marketQuery.error,
                            "L’estimation est momentanément indisponible.",
                          )}
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
                            Les caractéristiques seront vérifiées par Immojudis avant toute mise à
                            jour.
                          </p>
                        ) : (
                          <a href="#rendez-vous">Consulter les coordonnées du dossier</a>
                        )}
                      </div>
                    </div>
                  ) : fullData && isTribunalSale ? (
                    <AnalysisDecisionPanel
                      sale={displaySale}
                      marketEstimate={marketEstimate}
                      marketLoading={marketQuery.isLoading && marketEstimate == null}
                      worksBudget={retainedWorks}
                      recommendedCeiling={ceilingPlan.maxBid}
                      ceilingAvailable={ceilingPlan.available && ceilingPlan.reachable}
                      ceilingGap={ceilingMissing}
                      valueReason={valueReason}
                      onAdjust={() => undefined}
                      onEditWorks={() => changeTab("travaux")}
                    />
                  ) : access === "analysis" ? (
                    <NonJudicialDecisionPanel
                      sale={displaySale}
                      marketEstimate={detailedMarketEstimate}
                      marketLoading={marketQuery.isLoading && marketEstimate == null}
                    />
                  ) : (
                    <DiscoveryDecisionPanel sale={displaySale} />
                  )}
                </section>
                {access === "analysis" ? (
                  <MarketSnapshot
                    estimate={detailedMarketEstimate}
                    computedAt={marketQuery.data?.computedAt ?? null}
                    loading={marketQuery.isLoading && marketEstimate == null}
                  />
                ) : null}
                {fullData && isTribunalSale && !valuationConflict ? (
                  <div id="calculation" className="scroll-mt-36">
                    <LaunchOfferIncludedTag className="mb-2" />
                    <CeilingPlanner
                      hypotheses={ceilingHypotheses}
                      plan={ceilingPlan}
                      choices={ceilingChoices.choices}
                      onChoicesChange={ceilingChoices.update}
                      onReset={ceilingChoices.reset}
                      onEditWorks={() => changeTab("travaux")}
                      marketLoading={marketQuery.isLoading && marketEstimate == null}
                      valueReason={valueReason}
                      dpeClass={dpeClass}
                    />
                  </div>
                ) : access === "analysis" ? (
                  <details
                    className={panelStyles.disclosure}
                    open={Boolean(expandedDetails.budget)}
                  >
                    <summary
                      onClick={(event) => {
                        event.preventDefault();
                        setDetailOpen("budget", !expandedDetails.budget);
                      }}
                    >
                      Frais et hypothèses
                    </summary>
                    <ListingBudget
                      sale={displaySale}
                      aiReviewProjections={resolvedAiReviewProjections}
                      aiReviewStatus={aiReviewStatus}
                    />
                  </details>
                ) : null}
                {access === "analysis" ? (
                  <details
                    className={panelStyles.disclosure}
                    open={Boolean(expandedDetails.market)}
                  >
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
                        marketEstimate={detailedMarketEstimate}
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
                    sale={displaySale}
                    valuationConflict={Boolean(valuationConflict)}
                    statisticsAvailable={statisticsAvailable}
                    open={Boolean(expandedDetails["tribunal-perspective"])}
                    onOpenChange={(open) => setDetailOpen("tribunal-perspective", open)}
                  />
                ) : null}
              </>
            ) : null}

            {activeTab === "statistiques" && statisticsAvailable ? (
              fullData ? (
                <>
                  <AuctionScenariosSection
                    saleId={sale.id}
                    enabled={!publicDemo}
                    access={access}
                    userKey={user?.id}
                  />
                  <ListingStatistics
                    sale={sale}
                    premium={fullData && adjudicationStatisticsEnabled}
                    showUpcomingListings={access === "analysis"}
                    publicDemo={publicDemo}
                    propertyTypeVerified={!valuationConflict && !propertyTypeReview.blocked}
                  />
                </>
              ) : (
                <PremiumFeaturePreview
                  title={
                    user && !publicDemo
                      ? "Les statistiques du tribunal avec l’offre Analyse ou en débloquant cette vente"
                      : "Les statistiques du tribunal avec l’offre Analyse"
                  }
                  description="Consultez les tendances, les adjudications et les indicateurs disponibles pour préparer votre enchère."
                  labels={["Scénarios d’enchères", "Prix d’adjudication", "Activité du tribunal"]}
                  unlockOffer={Boolean(user && !publicDemo)}
                />
              )
            ) : null}

            {activeTab === "travaux" ? (
              access === "analysis" ? (
                <>
                  {valuationConflict || criticalAnalysisInputsBlocked ? (
                    <div className={panelStyles.warning} role="status">
                      <p>
                        Les caractéristiques nécessaires au calcul restent à confirmer. Votre détail
                        travaux peut être préparé, puis intégré au scénario après vérification.
                      </p>
                    </div>
                  ) : null}
                  <ListingWorks
                    sale={displaySale}
                    estimatedBudget={retainedWorks}
                    worksBreakdown={ceilingChoices.choices.worksBreakdown}
                    onWorksBreakdownChange={changeWorksBreakdown}
                    surface={surface}
                    onScenarioSelect={retainedWorks != null ? selectWorksBudget : undefined}
                    maxWorks={
                      heroCeiling != null
                        ? maxWorksAtBid(ceilingHypotheses, displaySale.starting_price_eur ?? 0)
                        : null
                    }
                  />
                </>
              ) : (
                <PremiumFeaturePreview
                  title="Estimez vos travaux avec l’offre Analyse"
                  description="Préparez une enveloppe par poste et intégrez-la à votre scénario d’achat."
                  labels={["Budget travaux", "Détail par poste", "Coût du projet"]}
                />
              )
            ) : null}

            {activeTab === "financement" ? (
              <>
                <div id="financing" className="scroll-mt-36">
                  <FinancingSimulator
                    sale={displaySale}
                    aiReviewProjections={resolvedAiReviewProjections}
                    aiReviewStatus={aiReviewStatus}
                    projectPriceOverride={projectCosts?.totalCost ?? null}
                    initialDraft={financingDraft}
                    onDraftChange={setFinancingDraft}
                    onResultChange={setFinancingResult}
                    initialInsuranceRate={0.3}
                  />
                  <ListingRental
                    saleId={sale.id}
                    acquisitionCost={
                      activeFinancingResult?.totalProjectCost ?? projectCosts?.totalCost ?? null
                    }
                    monthlyDebtService={activeFinancingResult?.monthlyPayment ?? null}
                    initialDraft={rentalDraft}
                    onDraftChange={setRentalDraft}
                  />
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
                  <ListingPracticalDetails
                    sale={displaySale}
                    aiReviewProjections={resolvedAiReviewProjections}
                    aiReviewStatus={aiReviewStatus}
                  />
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
                  sale={displaySale}
                  open={Boolean(expandedDetails.documents)}
                  onOpenChange={(open) => setDetailOpen("documents", open)}
                  locked={!fullData}
                />
                <LawyerSection sale={displaySale} />
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
                  <SaleProcedurePanel sale={displaySale} />
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
                      simulation={reportSimulation}
                      requireSimulation
                    />
                  </section>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </main>
    </SaleUnlockOfferProvider>
  );
}
