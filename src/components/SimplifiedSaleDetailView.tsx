"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { listingSaleStatus } from "@/lib/listing-evidence";
import { useAuth } from "@/hooks/use-auth";
import { PepiteViewTracker } from "@/components/sale-detail/PepiteViewTracker";
import { SaleUnlockPanel } from "@/components/sale-detail/SaleUnlockPanel";
import { pointsToVerify } from "@/lib/search/points-to-verify";
import {
  SaleUnlockOfferProvider,
  UnlockCallToAction,
} from "@/components/sale-detail/UnlockCallToAction";
import { useInvestorProfile } from "@/hooks/use-investor-profile";
import { useSalePepite } from "@/hooks/use-sale-pepite";
import { adjudicationVersusCeilingLine } from "@/lib/adjudication-vs-ceiling";
import type { SaleUnlockResult, SaleUnlockStatus } from "@/lib/sale-unlocks";
import { buildTribunalPilot } from "@/lib/professional-pilot-tribunal";
import { buildNotaryPilot } from "@/lib/professional-pilot-notary";
import { buildStatePilot } from "@/lib/professional-pilot-state";
import {
  ListingOverview,
  isPersistedSaleId,
  type CeilingWording,
  type OverviewAction,
  SaleDetailHeading,
  ListingDescription,
  ListingLocation,
} from "@/components/sale-detail/SaleListing";
import { FavoriteButton } from "@/components/FavoriteButton";
import { MarketReference } from "@/components/sale-detail/MarketReference";
import {
  FIRST_AUCTION_GUIDE_TITLE_ID,
  FirstAuctionGuide,
  useFirstAuctionGuide,
} from "@/components/sale-detail/FirstAuctionGuide";
import {
  PriceSummaryCard,
  type PriceSummaryCeiling,
  type PriceSummaryValue,
} from "@/components/sale-detail/PriceSummaryCard";
import { MobileActionBar } from "@/components/sale-detail/MobileActionBar";
import overviewStyles from "@/components/sale-detail/SaleOverview.module.css";
import { Terme } from "@/components/ceiling/Terme";
import { buildValuePreview, type ValuePreview } from "@/lib/value-preview";
import { marketGapWithheldReason } from "@/lib/market-gap-band";
import { loginPathWithRedirect, saleDetailPath } from "@/lib/navigation";
import { POINTS_TO_VERIFY_ANCHOR } from "@/lib/search/points-to-verify";
import { UNLOCK_PANEL_ID } from "@/components/sale-detail/UnlockCallToAction";
import { ListingBudget } from "@/components/sale-detail/ListingBudget";
import { ListingCharacteristics } from "@/components/sale-detail/ListingCharacteristics";
import { ListingChecks, ListingPreparation } from "@/components/sale-detail/ListingPreparation";
import type { WorksBreakdownItem } from "@/lib/works-breakdown";
import type { FinancingDraft, FinancingResult } from "@/components/sale-detail/FinancingSimulator";
import type { ListingRentalDraft } from "@/components/sale-detail/ListingRental";
import { DetailSection, WhenNear } from "@/components/sale-detail/SaleDetailLayout";
import { SaleDetailToc } from "@/components/sale-detail/SaleDetailToc";
import layoutStyles from "@/components/sale-detail/SaleDetailLayout.module.css";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import listingStyles from "@/components/sale-detail/SaleListing.module.css";
import {
  fetchFavoriteDossier,
  fetchPrecomputedMarketEstimate,
  fetchSaleAiReviewProjections,
  fetchSaleFactReliabilities,
  fetchValuePreview,
} from "@/lib/client-api";
import type { MarketEstimate } from "@/lib/market.server";
import { isDetailedMarketEstimate, showsPointEstimate } from "@/lib/market-estimate-ceiling";
import { estimateSourceNote } from "@/lib/market-estimate-display";
import { computeAcquisitionCosts } from "@/lib/profitability";
import { ceilingConfidence } from "@/lib/bid-ceiling-engine";
import { ceilingTermsFor, feeRegimeKeysForVenue, type FeeRegimeKey } from "@/lib/fee-regime";
import {
  assessSaleCeilingInputs,
  computeSaleCeiling,
  withEnteredSurface,
} from "@/lib/sale-ceiling";
import { investorProfileFinancingDraft, investorProfileToChoices } from "@/lib/investor-profile";
import {
  acceptsEnteredBuiltSurface,
  getMarketValuationSurfaces,
  getSaleSurface,
} from "@/lib/surface";
import { PriceScale } from "@/components/sale-detail/PriceScale";
import { AnalysisLead, hypothesesSummary } from "@/components/sale-detail/SaleAnalysisPanel";
import type { HousingTension } from "@/lib/housing-tension";
import type { RentReference } from "@/lib/rent-reference";
import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import {
  ceilingGap,
  UNPROFITABLE_HEADLINE,
  unlockCeilingGap,
  valueGapReason,
} from "@/lib/bid-ceiling-gaps";
import { buildDpeAnalysis } from "@/lib/dpe-analysis";
import { LaunchOfferIncludedTag } from "@/components/LaunchOfferIncludedTag";
import {
  choicesWithoutWorksBreakdown,
  useCeilingChoices,
  worksChoiceForAmount,
} from "@/components/ceiling/use-ceiling-choices";
import Link from "next/link";
import {
  getSaleProcedure,
  saleHasVerifiedTribunal,
  saleIsTribunalVenue,
} from "@/lib/sale-procedure";
import { buildReportRentalScenario } from "@/lib/report-simulation";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import type { AuctionSale } from "@/lib/types";
import { userMessage } from "@/lib/user-messages";
import { formatDate, formatSurface } from "@/lib/format";
import * as queryKeys from "@/lib/query-keys";
import { PropertyIdentity } from "@/components/sale-detail/SaleDetailPropertyIdentity";
import {
  AnalysisDecisionPanel,
  DiscoveryDecisionPanel,
  NonJudicialDecisionPanel,
} from "@/components/sale-detail/SaleDetailDecisionPanels";
import { TribunalEstimationEvidence } from "@/components/sale-detail/SaleDetailMarket";
import { AuctionScenariosSection } from "@/components/sale-detail/AuctionScenariosSection";
import { CeilingPlanner } from "@/components/ceiling/CeilingPlanner";
import { ProfessionalPilotLauncher } from "@/components/ProfessionalPilotLauncher";
import { SalePassagesSection } from "@/components/sale-detail/SalePassagesSection";
import { SaleDetailMarketSection } from "@/components/sale-detail/SaleDetailMarketSection";
import { SaleDetailPiecesSection } from "@/components/sale-detail/SaleDetailPiecesSection";
import { SaleDetailStepsSection } from "@/components/sale-detail/SaleDetailStepsSection";
import { SaleDetailTopbar } from "@/components/sale-detail/SaleDetailTopbar";
import { SaleDetailWorksFinancingSection } from "@/components/sale-detail/SaleDetailWorksFinancingSection";
import { useSaleDetailAnchors } from "@/components/sale-detail/use-sale-detail-anchors";

// « Mon dossier » gratuit (point 68) : chargé à la demande, hors du JavaScript initial de la fiche.
const SaleFileCard = dynamic(() =>
  import("@/components/sale-detail/SaleFileCard").then((module) => module.SaleFileCard),
);
// « Mon plafond face au tribunal » (n° 92) : chargé à la demande, hors du JavaScript initial de la fiche.
const CeilingVsCourt = dynamic(() =>
  import("@/components/sale-detail/CeilingVsCourt").then((module) => module.CeilingVsCourt),
);
// Dossier du panneau « Votre analyse », changements de la vente et « Enregistrer ce plafond » (offre
// Analyse) : chargés à la demande avec « Mon dossier » (même morceau), hors du JavaScript initial.
const DossierActions = dynamic(() =>
  import("@/components/sale-detail/SaleFileCard").then((module) => module.DossierActions),
);
const SaleFollowChanges = dynamic(() =>
  import("@/components/sale-detail/SaleFileCard").then((module) => module.SaleFollowChanges),
);
const SaveCeilingButton = dynamic(() =>
  import("@/components/sale-detail/SaleFileCard").then((module) => module.SaveCeilingButton),
);
// Bloc « Pourquoi cette pépite » : chargé à la demande, seule une pépite l'affiche.
const PepiteBlock = dynamic(() =>
  import("@/components/sale-detail/PepiteBlock").then((module) => module.PepiteBlock),
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
  /** Choix de départ de l'enchère plafond (annonce exemple) ; ceux du visiteur passent devant. */
  defaultCeilingChoices?: CeilingUserChoices;
  adjudicationStatisticsEnabled?: boolean;
  /** Sous la synthèse du haut de page (annonce exemple : le bouton d'inscription). */
  summaryFooter?: ReactNode;
  /**
   * Bandeau en tête du contenu, sous la pilule de navigation (annonce exemple : « Exemple fictif »).
   * Placé avant la page, il passait sous l'en-tête fixe (repasse design n° 3).
   */
  topNotice?: ReactNode;
  /**
   * Fee regimes whose bid ceiling is open (server switch `CEILING_FEE_REGIMES_OPEN`, see
   * `parseOpenFeeRegimes`). Absent: every regime whose rules are defined (the tribunal is always open).
   */
  openFeeRegimes?: readonly FeeRegimeKey[];
  /** Référence de loyer de la vente (carte ANIL à la commune), résolue par le serveur ; `null` : repli départemental. */
  rentReference?: RentReference | null;
  /** Zonage « zone tendue » de la commune, lu par le serveur ; `null` : inconnu. */
  housingTension?: HousingTension | null;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  /**
   * Repère « Pépite » déjà lu par le serveur avec la fiche publique (`preview.pepite`, vrai
   * seulement pour une pépite) : la liste de toutes les pépites n'est alors pas relue côté client.
   */
  pepiteKnown?: boolean;
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
  defaultCeilingChoices,
  adjudicationStatisticsEnabled = false,
  summaryFooter,
  topNotice,
  openFeeRegimes,
  rentReference = null,
  housingTension = null,
  aiReviewProjections = null,
  pepiteKnown,
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      key={sale.id}
      sale={sale}
      marketEstimateOverride={marketEstimateOverride}
      returnTo={returnTo}
      backLabel={backLabel}
      publicDemo={publicDemo}
      defaultCeilingChoices={defaultCeilingChoices}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      summaryFooter={summaryFooter}
      topNotice={topNotice}
      openFeeRegimes={openFeeRegimes}
      rentReference={rentReference}
      housingTension={housingTension}
      aiReviewProjections={aiReviewProjections}
      pepiteKnown={pepiteKnown}
      access="analysis"
    />
  );
}

export function FreeSaleDetailView({
  sale,
  returnTo = "/sales",
  adjudicationStatisticsEnabled = false,
  openFeeRegimes,
  rentReference = null,
  housingTension = null,
  aiReviewProjections = null,
  unlockStatus = null,
  justUnlocked = false,
  onSaleUnlocked,
  pepiteKnown,
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      key={sale.id}
      sale={sale}
      returnTo={returnTo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      openFeeRegimes={openFeeRegimes}
      rentReference={rentReference}
      housingTension={housingTension}
      aiReviewProjections={aiReviewProjections}
      unlockStatus={unlockStatus}
      justUnlocked={justUnlocked}
      onSaleUnlocked={onSaleUnlocked}
      pepiteKnown={pepiteKnown}
      access="discovery"
    />
  );
}

/** A Découverte account reading a sale it unlocked (« 3 déblocages par mois »). */
export function UnlockedSaleDetailView({
  sale,
  returnTo = "/sales",
  adjudicationStatisticsEnabled = false,
  openFeeRegimes,
  rentReference = null,
  housingTension = null,
  aiReviewProjections = null,
  unlockStatus = null,
  justUnlocked = false,
  pepiteKnown,
}: SaleDetailProps) {
  return (
    <SimplifiedSaleDetailView
      key={sale.id}
      sale={sale}
      returnTo={returnTo}
      adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      openFeeRegimes={openFeeRegimes}
      rentReference={rentReference}
      housingTension={housingTension}
      aiReviewProjections={aiReviewProjections}
      unlockStatus={unlockStatus}
      justUnlocked={justUnlocked}
      pepiteKnown={pepiteKnown}
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
  defaultCeilingChoices,
  adjudicationStatisticsEnabled = false,
  summaryFooter,
  topNotice,
  openFeeRegimes,
  rentReference = null,
  housingTension = null,
  aiReviewProjections = null,
  unlockStatus = null,
  justUnlocked = false,
  onSaleUnlocked,
  pepiteKnown,
  access,
}: SaleDetailProps & { access: SaleDetailAccess }) {
  const [personalWorksBudget, setPersonalWorksBudget] = useState<number | null>(null);
  const [financingDraft, setFinancingDraft] = useState<FinancingDraft | null>(null);
  const [financingResult, setFinancingResult] = useState<FinancingResult | null>(null);
  const [rentalDraft, setRentalDraft] = useState<ListingRentalDraft | null>(null);
  const { user, loading: authLoading } = useAuth();
  // Profil d'investisseur du compte (n° 93) : les hypothèses de départ du plafond de chaque vente,
  // que le visiteur modifie ensuite vente par vente.
  const investor = useInvestorProfile(user?.id);
  const profileChoices = useMemo(() => {
    // Une surface estimée (20 m² d'un studio sans surface publiée) ne sert jamais à chiffrer les
    // travaux du profil : on ne multiplie pas par une surface inventée.
    const surface = getSaleSurface(sale);
    return investorProfileToChoices(investor.profile, {
      surfaceM2: surface.estimated ? null : surface.value,
    });
  }, [investor.profile, sale]);
  const profileFinancingDraft = useMemo(
    () => investorProfileFinancingDraft(investor.profile),
    [investor.profile],
  );
  const ceilingChoices = useCeilingChoices(
    user?.id ?? "guest-demo",
    sale.id,
    defaultCeilingChoices,
    profileChoices,
  );
  // The sale rows are open (Analyse, or a sale this account unlocked). Everything below that
  // only Analyse has stays on `access === "analysis"`.
  const fullData = access !== "discovery";
  // Repère « Pépite » : sa présence (liste publique, lue une fois) et ses critères ; le détail avec le montant
  // seulement pour une fiche dont les lignes sont ouvertes (Analyse, vente débloquée), la route vérifie le droit.
  const pepite = useSalePepite({
    saleId: sale.id,
    view: fullData ? "detail" : "criteria",
    userKey: user?.id ?? "guest-demo",
    known: pepiteKnown,
    enabled: !publicDemo && !authLoading,
  });
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
  // Les gardes du plafond (conflit de valorisation, champs bloqués par la relecture IA, surface,
  // régime de frais) : `computeSaleCeiling` s'appuie sur le même résultat plus bas.
  const listingCeilingInputs = useMemo(
    () =>
      assessSaleCeilingInputs({
        sale,
        aiProjections: resolvedAiReviewProjections,
        aiReviewStatus,
        regimes: openFeeRegimes,
      }),
    [aiReviewStatus, openFeeRegimes, resolvedAiReviewProjections, sale],
  );
  // « Surface lue dans les pièces » (« Mon dossier ») : quand l'annonce ne publie pas la surface
  // bâtie, celle que le compte a saisie sert à SON plafond. Même requête (même clé) que la carte.
  const enteredSurfaceAccepted =
    Boolean(user) &&
    !publicDemo &&
    isPersistedSaleId(sale.id) &&
    !listingCeilingInputs.blocked.critical &&
    acceptsEnteredBuiltSurface(listingCeilingInputs.displaySale);
  const dossierQuery = useQuery({
    queryKey: queryKeys.favoriteDossier(user?.id ?? null, sale.id),
    queryFn: () => fetchFavoriteDossier(sale.id),
    enabled: enteredSurfaceAccepted && !authLoading,
  });
  const enteredSurfaceM2 = enteredSurfaceAccepted
    ? (dossierQuery.data?.dossier.userSurfaceM2 ?? null)
    : null;
  const ceilingInputs = useMemo(
    () => withEnteredSurface(listingCeilingInputs, enteredSurfaceM2),
    [enteredSurfaceM2, listingCeilingInputs],
  );
  const surfaceEnteredByUser = ceilingInputs.surfaceEnteredByUser === true;
  const { displaySale, valuationConflict, surface } = ceilingInputs;
  const priceBlocked = ceilingInputs.blocked.price;
  const propertyTypeBlocked = ceilingInputs.blocked.propertyType;
  const criticalAnalysisInputsBlocked = ceilingInputs.blocked.critical;
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
  // Propre au tribunal : statistiques du tribunal, étape « choisir un avocat », questions à l'avocat.
  const isTribunalSale = saleIsTribunalVenue(sale);
  // Ce qui décide du plafond : le régime de frais de la vente, quand son calcul est ouvert (le
  // tribunal aujourd'hui). Pas de régime, pas de plafond.
  const feeRegime = ceilingInputs.regime;
  const ceilingOpen = feeRegime != null;
  // Avant le déblocage (compte Découverte), les conditions d'une vente notariale ne sont pas lues :
  // on ne sait pas si la vente est à la bougie ou interactive. Le déblocage est promis dès qu'un des
  // régimes de ce type de vente est ouvert, avec les deux termes possibles.
  const venueCeilingTerms = ceilingTermsFor(
    feeRegimeKeysForVenue(getSaleProcedure(sale).venueType, openFeeRegimes),
  );
  const ceilingPromised = ceilingOpen || (access === "discovery" && venueCeilingTerms != null);
  // Une vente débloquée dont le mode reste inconnu (conditions illisibles) n'a pas de plafond : on ne
  // le promet plus, seul le compte qui n'a pas encore débloqué la vente reçoit les deux termes possibles.
  const ceilingTerms = feeRegime?.labels ?? (access === "discovery" ? venueCeilingTerms : null);
  // « Surface lue dans les pièces » dans « Mon dossier » : seulement quand elle peut servir au plafond.
  const surfaceEntryOpen = enteredSurfaceAccepted && ceilingPromised;
  // Action principale de la synthèse et du bloc « À vérifier » : le calcul du plafond quand il est
  // possible, sinon les rendez-vous et contacts du dossier.
  const preparation = ceilingOpen
    ? {
        href:
          fullData && !valuationConflict && !criticalAnalysisInputsBlocked
            ? "#calculation"
            : "#rendez-vous",
        label: feeRegime.labels.planner.prepareLabel,
      }
    : { href: "#rendez-vous", label: "Préparer ma démarche" };
  // Les statistiques des tribunaux restent fermées tant que le drapeau l'est : ni l'onglet, ni
  // son aperçu verrouillé, ni les ancres qui y mènent.
  const statisticsAvailable = isTribunalSale && adjudicationStatisticsEnabled;
  const budgetTarget =
    fullData && ceilingOpen && !valuationConflict
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
  // The market estimate feeds the bid ceiling (judicial sales) and, for Analyse, the market blocks.
  const marketAccess = access === "analysis" || (access === "unlocked" && ceilingOpen);
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
  // Surface saisie par le compte : la valeur du plafond est recalculée sur elle par le serveur (rien
  // n'est stocké). Les blocs de marché détaillés gardent l'estimation de l'annonce.
  const enteredSurfaceMarketQuery = useQuery({
    queryKey: queryKeys.enteredSurfaceMarketEstimate(sale.id, user?.id, enteredSurfaceM2 ?? 0),
    queryFn: () => fetchPrecomputedMarketEstimate({ saleId: sale.id, enteredSurface: true }),
    enabled:
      marketAccess &&
      surfaceEnteredByUser &&
      marketEstimateOverride == null &&
      !valuationConflict &&
      !criticalAnalysisInputsBlocked,
    staleTime: 24 * 60 * 60_000,
    retry: false,
  });
  const ceilingMarketQuery = surfaceEnteredByUser ? enteredSurfaceMarketQuery : marketQuery;
  const listingMarketEstimate =
    !marketAccess || valuationConflict || criticalAnalysisInputsBlocked
      ? null
      : (marketEstimateOverride ?? marketQuery.data?.estimate ?? null);
  // What the ceiling reads: the whole estimate (Analyse) or its ceiling projection (unlock).
  const marketEstimate =
    !marketAccess || valuationConflict || criticalAnalysisInputsBlocked
      ? null
      : (marketEstimateOverride ??
        (surfaceEnteredByUser
          ? (enteredSurfaceMarketQuery.data?.estimate ?? null)
          : (marketQuery.data?.estimate ?? null)));
  // The detailed blocks (range, references, comparables) exist for Analyse only.
  const detailedMarketEstimate =
    access === "analysis" && isDetailedMarketEstimate(listingMarketEstimate)
      ? listingMarketEstimate
      : null;
  // Hypothèses et plan du plafond : la chaîne de `computeSaleCeiling`, la même que celle du rapport.
  const ceiling = useMemo(
    () =>
      computeSaleCeiling({
        assessed: ceilingInputs,
        estimate: marketEstimate,
        fullData,
        rentReference,
        choices: {
          ...ceilingChoices.choices,
          works:
            ceilingChoices.choices.works ?? worksChoiceForAmount(surface, personalWorksBudget ?? 0),
        },
      }),
    [
      ceilingChoices.choices,
      ceilingInputs,
      fullData,
      marketEstimate,
      personalWorksBudget,
      rentReference,
      surface,
    ],
  );
  const { enabled: ceilingEnabled, hypotheses: ceilingHypotheses, plan: ceilingPlan } = ceiling;
  // Le vocabulaire du plafond de cette vente (« offre plafond », « première offre possible »…), pour
  // le haut de page et le panneau de prix.
  const ceilingWording: CeilingWording | null = feeRegime
    ? {
        label: feeRegime.labels.ceilingSimulationLabel,
        terms: feeRegime.labels,
        byOffers: feeRegime.labels.byOffers,
      }
    : venueCeilingTerms
      ? { label: venueCeilingTerms.ceilingSimulationLabel }
      : null;
  const marketPending = ceilingMarketQuery.isLoading && marketEstimate == null;
  const valueReason = marketPending
    ? "estimation en cours"
    : valueGapReason({ surface, marketStatus: ceilingMarketQuery.data?.status });
  const ceilingMissing = ceilingGap(ceilingPlan, valueReason);
  // Ce qui empêchera (avant le déblocage) ou empêche (après) le plafond d'être chiffré : la carte du
  // déblocage le dit avant la confirmation et ne titre pas « plafond débloqué ». Avant le déblocage,
  // seules les gardes lisibles sur la vente gratuite comptent (surface) ; une estimation ou une
  // relecture en cours n'est pas un manque.
  const unlockGap =
    ceilingTerms && !dossierQuery.isLoading
      ? unlockCeilingGap({
          inputs: ceilingInputs,
          gap: fullData ? ceilingMissing : null,
          pending: !fullData || marketPending || aiReviewStatus === "loading",
        })
      : null;
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
    // Le rapport est recalculé par le serveur sur les données de l'annonce : un plafond qui repose
    // sur la surface saisie par le compte n'y entre pas (le serveur ne le retrouverait pas).
    if (!ceilingEnabled || surfaceEnteredByUser || !ceilingPlan.available || !ceilingPlan.reachable)
      return undefined;
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
    surfaceEnteredByUser,
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
  // Calculé mais inatteignable : le hero le dit au lieu de rester vide.
  const heroCeilingUnreachable = ceilingEnabled && ceilingPlan.available && !ceilingPlan.reachable;
  // Après la vente : le prix d'adjudication connu, placé par rapport au plafond du compte (neutre).
  const adjudicationLine = adjudicationVersusCeilingLine({
    adjudicationEur: displaySale.adjudication_price_eur,
    ceilingEur: criticalAnalysisInputsBlocked ? null : heroCeiling,
    saleDate: displaySale.sale_date,
    ceilingTerm: feeRegime?.labels.ceilingTerm,
    byOffers: feeRegime?.labels.byOffers,
  });
  // Repère marché et carte « Le prix » : la fourchette de valeur du même aperçu que le panneau de
  // prix (clé de requête partagée). Un visiteur n'y a pas droit ; l'annonce exemple la calcule sur
  // son estimation fictive. Rien tant que la valeur ou le prix sont en cours de vérification.
  const valuePreviewQuery = useQuery({
    queryKey: ["value-preview", sale.id],
    queryFn: () => fetchValuePreview(sale.id),
    enabled: Boolean(user) && !publicDemo,
    staleTime: 60 * 60_000,
    retry: false,
  });
  const valueGuarded = Boolean(valuationConflict || criticalAnalysisInputsBlocked || priceBlocked);
  const startingPrice =
    priceBlocked || !((displaySale.starting_price_eur ?? 0) > 0)
      ? null
      : displaySale.starting_price_eur!;
  const rawValuePreview = valueGuarded
    ? null
    : publicDemo
      ? marketEstimateOverride
        ? buildValuePreview(marketEstimateOverride, startingPrice, displaySale.occupancy_status)
        : null
      : user && valuePreviewQuery.data?.available
        ? valuePreviewQuery.data
        : null;
  // Le serveur retient l'écart sur l'occupation brute ; la fiche le retient aussi quand l'occupation
  // affichée n'est pas un bien libre connu (relecture IA en cours : `displaySale` la met à `null`).
  const occupancyGapWithheld = marketGapWithheldReason(displaySale.occupancy_status);
  const valuePreview: ValuePreview | null =
    rawValuePreview && occupancyGapWithheld && !rawValuePreview.gapWithheld
      ? {
          ...rawValuePreview,
          gapWithheld: occupancyGapWithheld,
          discountPct: null,
          discountNotSignificant: false,
          startingPricePerM2: null,
        }
      : rawValuePreview;
  const signupHref =
    !user && !publicDemo && !authLoading
      ? loginPathWithRedirect(saleDetailPath(sale.id), { reason: "fiche" })
      : null;
  // Action principale du haut de page et de la barre mobile : créer un compte (visiteur), débloquer
  // le plafond (compte Découverte qui peut débloquer cette vente), sinon préparer l'enchère.
  const heroAction: OverviewAction = signupHref
    ? { href: signupHref, label: "Créer un compte gratuit" }
    : access === "discovery" &&
        user &&
        !publicDemo &&
        ceilingPromised &&
        unlockStatus?.unlockable &&
        !unlockStatus.unlocked &&
        (unlockStatus.remaining ?? 0) > 0
      ? {
          href: `#${UNLOCK_PANEL_ID}`,
          label: `Débloquer ${ceilingTerms?.ceilingTermWithArticle ?? "le plafond"}`,
        }
      : preparation;
  const ceilingSummaryLabel =
    ceilingTerms?.ceilingSimulationLabel ?? "Enchère plafond (simulation)";
  // Fourchette de l'estimation détaillée (offre Analyse) : case « Valeur estimée » et réglette.
  const marketRange =
    detailedMarketEstimate?.actionable &&
    (detailedMarketEstimate.estimatedValueLowEur ?? 0) > 0 &&
    (detailedMarketEstimate.estimatedValueHighEur ?? 0) > 0
      ? {
          low: detailedMarketEstimate.estimatedValueLowEur!,
          high: detailedMarketEstimate.estimatedValueHighEur!,
        }
      : null;
  const priceSummaryValue: PriceSummaryValue | null = valueGuarded
    ? null
    : fullData && marketEstimate && showsPointEstimate(marketEstimate)
      ? {
          kind: "amount",
          amount: Math.round((marketEstimate.estimatedValueEur ?? 0) / 1000) * 1000,
          note: estimateSourceNote(marketEstimate),
          range: marketRange,
        }
      : valuePreview?.lowEur != null && valuePreview.highEur != null
        ? { kind: "range", low: valuePreview.lowEur, high: valuePreview.highEur }
        : signupHref
          ? { kind: "signup", href: signupHref }
          : (user && valuePreviewQuery.isLoading) || marketPending
            ? { kind: "pending" }
            : null;
  // Valeur d'un bien libre : jamais placée face à la mise à prix d'un bien occupé ou d'occupation
  // inconnue (réglette, tête « Votre analyse ») ; la case « Le prix » la libelle comme telle.
  const comparedValue =
    !occupancyGapWithheld && priceSummaryValue?.kind === "amount" ? priceSummaryValue.amount : null;
  const priceSummaryCeiling: PriceSummaryCeiling | null = !ceilingPromised
    ? null
    : fullData
      ? valuationConflict || criticalAnalysisInputsBlocked
        ? { kind: "note", note: "En cours de vérification" }
        : heroCeiling != null
          ? {
              kind: "amount",
              amount: heroCeiling,
              note: "selon vos hypothèses",
              reliability: ceilingConfidence(ceilingHypotheses).label,
              startGap: startingPrice != null ? ceilingPlan.startingPriceGap : null,
              startTerm: feeRegime?.labels.referencePriceTerm,
            }
          : heroCeilingUnreachable
            ? { kind: "note", note: UNPROFITABLE_HEADLINE }
            : ceilingEnabled && marketPending
              ? { kind: "note", note: "Calcul…" }
              : ceilingMissing
                ? { kind: "note", note: `À compléter : ${ceilingMissing.reason}` }
                : null
      : signupHref
        ? {
            kind: "locked",
            action: (
              <>
                <Link href={signupHref}>Créez un compte gratuit</Link>, puis débloquez la vente ou
                choisissez l’offre Analyse
              </>
            ),
          }
        : {
            kind: "locked",
            action: (
              <>
                Avec l’offre Analyse ou en débloquant cette vente{" "}
                <UnlockCallToAction offerLabel="Découvrir l’offre Analyse" />
              </>
            ),
          };
  const guide = useFirstAuctionGuide();
  const ceilingDetailHref =
    fullData && ceilingOpen && !valuationConflict ? "#calculation" : "#summary";
  const startingPriceSignal =
    isTribunalSale && startingPrice != null && !listingSaleStatus(displaySale)
      ? {
          title: "La mise à prix est un prix de départ",
          text: "Les enchères partent de ce montant : le prix final dépendra des enchères.",
          todo: "fixez votre plafond avant l’audience.",
        }
      : null;

  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const { activeSection, forced, expandedDetails, setDetailOpen, goToAnchor, handleSectionLink } =
    useSaleDetailAnchors({ statisticsAvailable, budgetTarget });
  const editWorks = () => goToAnchor("works");

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
  const cityBlocked = getAiReviewFieldResult(
    resolvedAiReviewProjections,
    "property.city",
    aiReviewStatus,
  ).blocked;
  // Offre Analyse, vente dont le plafond existe : le panneau collant devient « Votre analyse ».
  const analysisPanel = access === "analysis" && ceilingPromised;
  const dossierInPanel = analysisPanel && Boolean(user) && !publicDemo;
  const dateBlocked = getAiReviewFieldResult(
    resolvedAiReviewProjections,
    "sale.sale_date",
    aiReviewStatus,
  ).blocked;
  const followHiddenTopics = useMemo(() => {
    const hidden = new Set<"price" | "date">();
    if (priceBlocked) hidden.add("price");
    if (dateBlocked) hidden.add("date");
    return hidden;
  }, [dateBlocked, priceBlocked]);

  // « Mon dossier » : dans la colonne principale, ou à l'ancre `#mon-dossier` des démarches quand le
  // panneau « Votre analyse » le résume. « Mon dossier » est l'unique porte du dossier de travail.
  const fileCard = (
    <SaleFileCard
      saleId={sale.id}
      calculatedCeiling={heroCeiling}
      calculationPending={ceilingEnabled && marketPending}
      surfaceEntry={surfaceEntryOpen}
      onOpenWorkspace={workspaceAvailable ? () => setWorkspaceOpen(true) : undefined}
    />
  );

  const startLabelText =
    getSaleProcedure(displaySale).venueType === "state"
      ? "Prix publié"
      : ceilingWording?.byOffers
        ? "Première offre possible"
        : "Mise à prix";

  return (
    <SaleUnlockOfferProvider status={unlockOffer}>
      <main id="contenu" className={listingStyles.page} onClickCapture={handleSectionLink}>
        <div className={listingStyles.container}>
          {topNotice}
          <SaleDetailTopbar
            saleId={sale.id}
            displaySale={displaySale}
            returnTo={returnTo}
            backLabel={backLabel}
            cityBlocked={cityBlocked}
            publicDemo={publicDemo}
            showFavorite={dossierInPanel && isPersistedSaleId(sale.id)}
          />
          <SaleDetailHeading
            sale={displaySale}
            publicDemo={publicDemo}
            aiReviewProjections={resolvedAiReviewProjections}
            aiReviewStatus={aiReviewStatus}
            pepite={pepite != null}
            pepiteFloodExposed={pepite?.flood?.verdict === "exposed"}
            showAddress
          />
          <div className={layoutStyles.split}>
            <div className={layoutStyles.gallery}>
              <PropertyIdentity
                key={sale.id}
                sale={displaySale}
                aiReviewProjections={resolvedAiReviewProjections}
                aiReviewStatus={aiReviewStatus}
                publicDemo={publicDemo}
              />
            </div>
            <div className={layoutStyles.side}>
              <div className={listingStyles.heroSummary}>
                <ListingOverview
                  sale={displaySale}
                  preparation={heroAction}
                  ceilingWording={ceilingWording}
                  factReliabilities={factReliabilities}
                  aiReviewProjections={resolvedAiReviewProjections}
                  aiReviewStatus={aiReviewStatus}
                  marketReference={
                    valueGuarded ? null : (
                      <MarketReference
                        startingPrice={startingPrice}
                        preview={valuePreview}
                        loading={Boolean(user) && !publicDemo && valuePreviewQuery.isLoading}
                        signupHref={signupHref}
                        startLabel={
                          ceilingWording?.byOffers ? "La première offre possible" : "La mise à prix"
                        }
                      />
                    )
                  }
                  showSecondaryAction={!summaryFooter}
                  lead={
                    analysisPanel ? (
                      <AnalysisLead
                        label={
                          <Terme
                            terme={ceilingWording?.byOffers ? "offre-plafond" : "enchere-plafond"}
                          >
                            {ceilingSummaryLabel}
                          </Terme>
                        }
                        ceiling={priceSummaryCeiling}
                        startLabel={startLabelText}
                        startingPrice={startingPrice}
                        value={comparedValue}
                        hypotheses={
                          heroCeiling != null ? hypothesesSummary(ceilingHypotheses) : null
                        }
                        modifyHref="#calculation"
                      />
                    ) : null
                  }
                  actions={
                    dossierInPanel ? (
                      <DossierActions
                        saleId={sale.id}
                        onOpenWorkspace={
                          workspaceAvailable ? () => setWorkspaceOpen(true) : undefined
                        }
                        reportHref={ceilingOpen && !valuationConflict ? "#rapport" : null}
                        // Même condition que « Ajouter à mon agenda » dans les rendez-vous de la vente.
                        calendarHref={
                          isTribunalSale &&
                          displaySale.sale_date &&
                          !dateBlocked &&
                          !listingSaleStatus(displaySale)
                            ? "#rendez-vous"
                            : null
                        }
                      />
                    ) : null
                  }
                  followAction={
                    !publicDemo && isPersistedSaleId(sale.id) ? (
                      <FavoriteButton saleId={sale.id} className="min-h-11 w-full px-4 text-sm" />
                    ) : null
                  }
                />
                {summaryFooter}
              </div>
              {dossierInPanel && user ? (
                <SaleFollowChanges
                  saleId={sale.id}
                  userId={user.id}
                  hiddenTopics={followHiddenTopics}
                />
              ) : null}
            </div>
            <div className={layoutStyles.main}>
              {!publicDemo && user && access !== "analysis" ? (
                <SaleUnlockPanel
                  saleId={sale.id}
                  status={unlockStatus}
                  // Just unlocked, while the unlocked read is still loading: the free view stays on
                  // screen and the card already says so.
                  unlocked={access === "unlocked" || unlockStatus?.unlocked === true}
                  opens={{
                    ceiling: ceilingTerms?.ceilingTermWithArticle ?? null,
                    ceilingTerm: ceilingTerms?.ceilingTerm ?? null,
                    statistics: statisticsAvailable,
                    pepite: pepite != null,
                    ceilingGap: unlockGap,
                  }}
                  announce={justUnlocked}
                  onUnlocked={(result) => {
                    onSaleUnlocked?.(result);
                    // Le plafond est ce que le déblocage ouvre : on y va, la confirmation reste en haut.
                    if (ceilingTerms) goToAnchor("calculation");
                  }}
                />
              ) : null}
              {!publicDemo && user && !dossierInPanel ? fileCard : null}
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

              <SaleDetailToc active={activeSection} />

              <DetailSection id="bien">
                {pepite ? (
                  <div>
                    <PepiteViewTracker payload={pepite} saleId={sale.id} />
                    <PepiteBlock
                      className="w-full"
                      payload={pepite}
                      saleId={sale.id}
                      userCeilingEur={heroCeiling}
                      lockedAction={
                        <UnlockCallToAction
                          offerLabel="Découvrir l’offre Analyse"
                          primaryClassName="font-semibold text-gold-text underline underline-offset-4"
                        />
                      }
                    />
                  </div>
                ) : null}
                <ListingCharacteristics sale={displaySale} />
                <ListingDescription
                  sale={displaySale}
                  aiReviewProjections={resolvedAiReviewProjections}
                  aiReviewStatus={aiReviewStatus}
                />
                {isTribunalSale && guide.visible && !listingSaleStatus(displaySale) ? (
                  <FirstAuctionGuide
                    ceilingHref={ceilingDetailHref}
                    eligibleBar={getSaleProcedure(displaySale).eligibleBar}
                    onHide={() => {
                      guide.hide();
                      // Le focus passe au bloc suivant au lieu de se perdre avec le bouton.
                      window.requestAnimationFrame(() =>
                        document.getElementById(`${POINTS_TO_VERIFY_ANCHOR}-title`)?.focus(),
                      );
                    }}
                  />
                ) : null}
                <ListingChecks
                  sale={displaySale}
                  points={pointsToVerify(displaySale, { occupancyVisible: true })}
                  showRisks={access === "analysis"}
                  saleId={sale.id}
                  ownerId={user?.id ?? "guest-demo"}
                  preparation={preparation}
                  startingPriceSignal={startingPriceSignal}
                  factReliabilities={factReliabilities}
                  aiReviewProjections={resolvedAiReviewProjections}
                  aiReviewStatus={aiReviewStatus}
                />
                <ListingPreparation
                  sale={displaySale}
                  publicDemo={publicDemo}
                  factReliabilities={factReliabilities}
                  aiReviewProjections={resolvedAiReviewProjections}
                  aiReviewStatus={aiReviewStatus}
                  compactSources
                />
                <ListingLocation
                  sale={displaySale}
                  aiReviewProjections={resolvedAiReviewProjections}
                  aiReviewStatus={aiReviewStatus}
                />
                <p className={overviewStyles.footLine}>
                  <a
                    href="#quartier"
                    className="font-semibold text-gold-text underline underline-offset-4"
                  >
                    Urbanisme, risques de la commune et marché locatif
                  </a>
                  {isTribunalSale && guide.hidden ? (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className={overviewStyles.reshow}
                        onClick={() => {
                          guide.show();
                          window.requestAnimationFrame(() => {
                            const title = document.getElementById(FIRST_AUCTION_GUIDE_TITLE_ID);
                            title?.scrollIntoView?.({ block: "center" });
                            title?.focus({ preventScroll: true });
                          });
                        }}
                      >
                        Réafficher le guide de première vente
                      </button>
                    </>
                  ) : null}
                </p>
              </DetailSection>

              <DetailSection
                id="prix"
                title={ceilingOpen ? `Prix et ${feeRegime.labels.ceilingTerm}` : "Prix et marché"}
              >
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
                {adjudicationLine ? (
                  <p
                    data-testid="adjudication-vs-ceiling"
                    className="text-sm font-medium text-foreground"
                  >
                    {adjudicationLine}
                  </p>
                ) : null}
                {startingPrice != null || priceSummaryValue || priceSummaryCeiling ? (
                  <PriceSummaryCard
                    startLabel={
                      getSaleProcedure(displaySale).venueType === "state" ? (
                        "Prix publié"
                      ) : ceilingWording?.byOffers ? (
                        <Terme terme="premiere-offre">Première offre possible</Terme>
                      ) : (
                        <Terme terme="mise-a-prix">Mise à prix</Terme>
                      )
                    }
                    startingPrice={startingPrice}
                    value={priceSummaryValue}
                    valueWithheld={occupancyGapWithheld}
                    ceilingLabel={
                      <Terme terme={ceilingWording?.byOffers ? "offre-plafond" : "enchere-plafond"}>
                        {ceilingSummaryLabel}
                      </Terme>
                    }
                    ceiling={priceSummaryCeiling}
                    // Dans la section du prix, le calcul (ou le panneau de prix) suit juste en dessous.
                    detailHref={null}
                  />
                ) : null}
                <div id="summary" className="scroll-mt-2">
                  {valuationConflict ? (
                    <div role="alert" className={panelStyles.warning}>
                      <div>
                        <h3>Estimation suspendue : données contradictoires</h3>
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
                  ) : access === "analysis" && ceilingOpen ? (
                    <>
                      <PriceScale
                        startingPrice={startingPrice}
                        startLabel={startLabelText}
                        ceiling={criticalAnalysisInputsBlocked ? null : heroCeiling}
                        value={comparedValue}
                        range={occupancyGapWithheld ? null : marketRange}
                      />
                      {surfaceEnteredByUser ? (
                        <p className={panelStyles.surfaceCaution}>
                          Surface saisie par vous : {formatSurface(surface ?? 0)}, lue dans les
                          pièces. Elle sert à votre seul calcul ; l’annonce n’est pas modifiée.
                        </p>
                      ) : getMarketValuationSurfaces(displaySale).builtSurfaceEstimated ? (
                        <p className={panelStyles.surfaceCaution}>
                          Surface provisoire :{" "}
                          {getMarketValuationSurfaces(displaySale).builtSurfaceAssumption}. À
                          confirmer avant de retenir ce plafond.
                        </p>
                      ) : null}
                    </>
                  ) : fullData && ceilingOpen ? (
                    <AnalysisDecisionPanel
                      sale={displaySale}
                      marketEstimate={marketEstimate}
                      marketLoading={marketPending}
                      worksBudget={retainedWorks}
                      recommendedCeiling={ceilingPlan.maxBid}
                      ceilingAvailable={ceilingPlan.available && ceilingPlan.reachable}
                      startingPriceGap={ceilingPlan.startingPriceGap}
                      ceilingGap={ceilingMissing}
                      ceilingWording={ceilingWording}
                      valueReason={valueReason}
                      onAdjust={() => undefined}
                      onEditWorks={editWorks}
                    />
                  ) : access === "analysis" ? (
                    <NonJudicialDecisionPanel
                      sale={displaySale}
                      marketEstimate={detailedMarketEstimate}
                      marketLoading={marketQuery.isLoading && marketEstimate == null}
                      priceBlocked={priceBlocked}
                    />
                  ) : access === "discovery" ? (
                    <DiscoveryDecisionPanel sale={displaySale} openFeeRegimes={openFeeRegimes} />
                  ) : null}
                </div>
                {fullData && ceilingOpen && !valuationConflict ? (
                  <div id="calculation" className="scroll-mt-2">
                    <LaunchOfferIncludedTag className="mb-2" />
                    <CeilingPlanner
                      hypotheses={ceilingHypotheses}
                      plan={ceilingPlan}
                      choices={ceilingChoices.choices}
                      onChoicesChange={ceilingChoices.update}
                      onReset={ceilingChoices.reset}
                      onEditWorks={editWorks}
                      marketLoading={marketPending}
                      valueReason={valueReason}
                      dpeClass={dpeClass}
                      surfaceEntryHref={surfaceEntryOpen && user ? "#mon-dossier" : null}
                      saveAction={
                        access === "analysis" && user && !publicDemo ? (
                          <SaveCeilingButton
                            saleId={sale.id}
                            ceiling={criticalAnalysisInputsBlocked ? null : heroCeiling}
                          />
                        ) : null
                      }
                    />
                    {statisticsAvailable && heroCeiling != null && user && !publicDemo ? (
                      <CeilingVsCourt
                        saleId={sale.id}
                        ceiling={heroCeiling}
                        access={access}
                        userKey={user.id}
                      />
                    ) : null}
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
                {statisticsAvailable && fullData ? (
                  <WhenNear force={forced("prix")} placeholder="Scénarios d’enchères…">
                    <AuctionScenariosSection
                      saleId={sale.id}
                      enabled={!publicDemo}
                      access={access}
                      userKey={user?.id}
                    />
                  </WhenNear>
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
                <WhenNear
                  force={forced("prix")}
                  placeholder="Historique de la vente…"
                  minHeight={120}
                >
                  <SalePassagesSection
                    saleId={sale.id}
                    startingPrice={displaySale.starting_price_eur ?? null}
                    enabled={!publicDemo && !authLoading && Boolean(user)}
                    access={access}
                    userKey={user?.id}
                  />
                </WhenNear>
              </DetailSection>

              <SaleDetailMarketSection
                sale={sale}
                displaySale={displaySale}
                access={access}
                fullData={fullData}
                publicDemo={publicDemo}
                signedIn={Boolean(user)}
                authLoading={authLoading}
                force={forced("marche")}
                detailedMarketEstimate={detailedMarketEstimate}
                marketComputedAt={marketQuery.data?.computedAt ?? null}
                marketLoading={marketQuery.isLoading && marketEstimate == null}
                marketActionable={marketEstimate?.actionable === true}
                ceilingOpen={ceilingOpen}
                startingPrice={startingPrice}
                rentReference={rentReference}
                housingTension={housingTension}
                statisticsAvailable={statisticsAvailable}
                adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
                propertyTypeVerified={!valuationConflict && !propertyTypeBlocked}
                cityBlocked={cityBlocked}
              />

              <SaleDetailWorksFinancingSection
                saleId={sale.id}
                displaySale={displaySale}
                access={access}
                force={forced("travaux-financement")}
                inputsToConfirm={Boolean(valuationConflict || criticalAnalysisInputsBlocked)}
                retainedWorks={retainedWorks}
                worksBreakdown={ceilingChoices.choices.worksBreakdown}
                onWorksBreakdownChange={changeWorksBreakdown}
                surface={surface}
                onScenarioSelect={selectWorksBudget}
                heroCeiling={heroCeiling}
                ceilingHypotheses={ceilingHypotheses}
                aiReviewProjections={resolvedAiReviewProjections}
                aiReviewStatus={aiReviewStatus}
                financingLoading={authLoading || investor.loading}
                projectCost={projectCosts?.totalCost ?? null}
                financingDraft={financingDraft ?? profileFinancingDraft}
                onFinancingDraftChange={setFinancingDraft}
                onFinancingResultChange={setFinancingResult}
                acquisitionCost={
                  activeFinancingResult?.totalProjectCost ?? projectCosts?.totalCost ?? null
                }
                monthlyDebtService={activeFinancingResult?.monthlyPayment ?? null}
                rentalDraft={rentalDraft}
                onRentalDraftChange={setRentalDraft}
              />

              <SaleDetailPiecesSection
                saleId={sale.id}
                sale={displaySale}
                documentsOpen={Boolean(expandedDetails.documents)}
                onDocumentsOpenChange={(open) => setDetailOpen("documents", open)}
                locked={!fullData}
                force={forced("pieces")}
                readingEnabled={!publicDemo && !authLoading && Boolean(user)}
                access={access}
                userKey={user?.id}
              />

              <SaleDetailStepsSection
                saleId={sale.id}
                displaySale={displaySale}
                access={access}
                fullData={fullData}
                publicDemo={publicDemo}
                userId={user?.id}
                isTribunalSale={isTribunalSale}
                priceBlocked={priceBlocked}
                dateBlocked={dateBlocked}
                aiReviewProjections={resolvedAiReviewProjections}
                aiReviewStatus={aiReviewStatus}
                fileCard={dossierInPanel ? fileCard : null}
                participationOpen={Boolean(expandedDetails.participation)}
                onParticipationToggle={() =>
                  setDetailOpen("participation", !expandedDetails.participation)
                }
                reportAvailable={
                  access === "analysis" && !publicDemo && ceilingOpen && !valuationConflict
                }
                surfaceEnteredByUser={surfaceEnteredByUser}
                reportSimulation={reportSimulation}
              />
            </div>
          </div>
        </div>
        <MobileActionBar
          priceLabel={startLabelText}
          price={startingPrice}
          ceiling={criticalAnalysisInputsBlocked ? null : heroCeiling}
          action={
            activeSection === "prix" && heroAction.href === "#calculation" ? null : heroAction
          }
          dossier={
            dossierInPanel && workspaceAvailable && heroCeiling != null
              ? {
                  caption: `votre plafond${
                    !dateBlocked && displaySale.sale_date
                      ? ` · ${formatDate(displaySale.sale_date)}`
                      : ""
                  }`,
                  onOpen: () => setWorkspaceOpen(true),
                }
              : null
          }
        />
      </main>
    </SaleUnlockOfferProvider>
  );
}
