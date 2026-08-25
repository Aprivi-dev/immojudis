import { useEffect, useState } from "react";
import type * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@/lib/router-compat";
import { toast } from "sonner";
import BadgeEuro from "lucide-react/dist/esm/icons/badge-euro.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CircleHelp from "lucide-react/dist/esm/icons/circle-help.js";
import ClipboardCheck from "lucide-react/dist/esm/icons/clipboard-check.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import Share2 from "lucide-react/dist/esm/icons/share-2.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Target from "lucide-react/dist/esm/icons/target.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import Users from "lucide-react/dist/esm/icons/users.js";
import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import {
  formatPrice,
  formatDate,
  formatDateTime,
  formatNumber,
  documentTypeLabel,
  formatPricePerM2,
  occupancyLabel,
  propertyTypeLabel,
  saleStatusLabel,
} from "@/lib/format";
import { getDisplaySurface, getMarketValuationSurfaces, getSaleSurface } from "@/lib/surface";
import { isEmbeddableDocumentUrl, parseDocs } from "@/lib/documents";
import { safeExternalHttpUrl } from "@/lib/external-url";
import { BidCeilingAssistant } from "@/components/BidCeilingAssistant";
import { FavoriteButton } from "@/components/FavoriteButton";
import { FeaturedLawyerPlacement } from "@/components/FeaturedLawyerPlacement";
import { PropertyReportActions } from "@/components/PropertyReportActions";
import { InformationRequestAgent } from "@/components/InformationRequestAgent";
import { SaleCountdown } from "@/components/SaleCountdown";
import { SaleLocationHero } from "@/components/SaleLocationHero";
import { MapThumbnail } from "@/components/MapThumbnail";
import { BrandMark } from "@/components/BrandLogo";
import { EvidenceTrail } from "@/components/EvidenceTrail";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { PhotoCarouselDialog, type CarouselImage } from "@/components/PhotoCarouselDialog";
import { RotatingCamera360 } from "@/components/RotatingCamera360";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  createSaleAnalysisSet,
  createSaleWorkspaceAnnotationClient,
  fetchEnvironmentalContext,
  fetchPrecomputedMarketEstimate,
  fetchMarketAnalytics,
  fetchSaleHistory,
  fetchSaleWorkspace,
  fetchSaleWorkspaceCollaboration,
  fetchValuationBacktest,
  inviteSaleWorkspaceCollaboratorClient,
  saveSaleWorkspace,
  updateSaleWorkspaceAnnotationClient,
} from "@/lib/client-api";
import type { EnvironmentalContext } from "@/lib/environment.functions";
import type { MarketEstimate } from "@/lib/market.functions";
import {
  DEFAULT_DOCUMENT_REVIEW,
  DEFAULT_SALE_CHECKLIST,
  DOCUMENT_REVIEW_STATUS_LABELS,
  SALE_WORKSPACE_STATUS_LABELS,
  isUuid,
  type SaleWorkspaceDocumentReview,
  type SaleWorkspaceDocumentReviewStatus,
  type SaleWorkspaceDocumentReviews,
  type SaleWorkspaceStatus,
} from "@/lib/sale-workspace-shared";
import { cn } from "@/lib/utils";
import { propertyImages } from "@/lib/sale-media";
import { saleSourceLinks } from "@/lib/sale-source-links";
import {
  computeAcquisitionCosts,
  computeRecommendedCeilings,
  DEFAULT_MARKET_CEILING_SCENARIO,
  DEFAULTS,
  REFRESH_WORKS_PRICE_PER_M2,
  type MarketCeilingResult,
} from "@/lib/profitability";
import {
  buildSaleProductSources,
  type ProductFact,
  type ProductGroup,
  type ProductHistoryRow,
  type ProductRisk,
  type ProductWeatherMonth,
  type SaleProductSources,
} from "@/lib/sale-detail-sources";
import { getSaleDisplayDescription, hasSaleAiDescription } from "@/lib/sale-description";
import { saleDisplayTitle } from "@/lib/sale-title";
import type { AuctionSale, SaleDocumentRich, SaleMedia, SaleRiskOccurrence } from "@/lib/types";
import {
  AiPropertyDescriptionCard,
  BeforeAuctionSection,
  CeilingCalculationSection,
  DecisionActionRail,
  DecisionHero,
  DecisionIntroGrid,
  FAQSection,
  KeyFiguresSection,
  MobileActionBar,
  PriceChangingRisksSection,
  ProofsSection,
  TechnicalDetailsSection,
  VerdictSection,
} from "./sale-detail/decision-view";
import { buildDecisionSummary, countDocuments, saleLocation } from "./sale-detail/detail-helpers";
import { ListingActionBar, saleImages } from "./sale-detail/detail-primitives";
/**
 * Presentational detail view. Split out from the route so it can be rendered
 * with any AuctionSale (route data, previews, tests). Organised around the maximum
 * bid the investor should not exceed, with sources and context below the decision.
 */
export function SaleDetailView({
  sale,
  marketEstimateOverride,
  returnTo = "/sales",
}: {
  sale: AuctionSale;
  marketEstimateOverride?: MarketEstimate | null;
  returnTo?: string;
}) {
  const location = saleLocation(sale.address, sale.postal_code, sale.city);
  const referenceLabel = saleDisplayTitle(sale);
  const media = saleImages(sale.media);
  const marketQuery = useQuery({
    queryKey: ["precomputed-market-estimate", sale.id],
    queryFn: () => fetchPrecomputedMarketEstimate({ saleId: sale.id }),
    enabled: marketEstimateOverride == null,
    staleTime: 24 * 60 * 60_000,
    refetchInterval: (query) =>
      query.state.data?.status === "queued" && !query.state.data.estimate ? 15_000 : false,
  });
  const marketEstimate = marketEstimateOverride ?? marketQuery.data?.estimate ?? null;
  const marketLoading = marketEstimateOverride == null && marketQuery.isLoading;
  const marketError =
    marketEstimateOverride == null &&
    Boolean(marketQuery.isError || marketQuery.data?.ok === false);
  const [environmentRequested, setEnvironmentRequested] = useState(
    () => typeof window !== "undefined" && window.location.hash === "#context",
  );
  const environmentalQuery = useQuery({
    queryKey: ["environmental-context", sale.id, location, sale.latitude, sale.longitude],
    queryFn: () =>
      fetchEnvironmentalContext({
        data: {
          address: location,
          lat: sale.latitude,
          lng: sale.longitude,
        },
      }),
    enabled:
      environmentRequested &&
      Boolean(location || (sale.latitude != null && sale.longitude != null)),
    staleTime: 7 * 24 * 60 * 60_000,
  });
  const environmentalContext: EnvironmentalContext | null =
    environmentalQuery.data?.context ?? null;
  const environmentalLoading = environmentalQuery.isLoading;
  const environmentalError = Boolean(
    environmentalQuery.isError || environmentalQuery.data?.ok === false,
  );
  const decision = buildDecisionSummary(sale, marketEstimate);
  const acquisitionCost = computeAcquisitionCosts({
    price: decision.ceiling?.available
      ? decision.ceiling.maxBid
      : Math.max(0, sale.starting_price_eur ?? 0),
    works: decision.refreshWorksBudget,
    fpt: DEFAULTS.fpt,
  });
  const product = buildSaleProductSources({
    sale,
    ceiling: decision.ceiling,
    ceilingWithoutWorks: decision.ceilingWithoutWorks,
    ceilingWithRefreshWorks: decision.ceilingWithRefreshWorks,
    primaryCheck: decision.primaryCheck,
    primaryDocument: decision.primaryDocument,
    action: decision.action,
    acquisitionCost,
    marketEstimate,
    marketLoading,
    marketError,
    environmentalContext,
    environmentalLoading,
    environmentalError,
  });
  const documentCount = countDocuments(sale);

  return (
    <main className="min-h-screen bg-[#eef7ff] pb-28 text-foreground lg:pb-20">
      <ListingActionBar
        sale={sale}
        title={referenceLabel}
        decision={decision}
        location={location}
        returnTo={returnTo}
      />

      <DecisionHero
        sale={sale}
        title={referenceLabel}
        location={location}
        media={media}
        decision={decision}
        acquisitionCost={acquisitionCost}
      />

      {marketEstimateOverride == null &&
      !marketEstimate &&
      (marketQuery.data?.error || marketQuery.error) ? (
        <div className="mx-auto max-w-[1360px] px-4 pt-6 sm:px-6 lg:px-8">
          <div
            className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div>
                <p className="font-semibold">Estimation de marché à compléter</p>
                <p className="mt-0.5">
                  {marketQuery.data?.error ??
                    (marketQuery.error instanceof Error
                      ? marketQuery.error.message
                      : "L’estimation est momentanément indisponible.")}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void marketQuery.refetch()}
              disabled={marketQuery.isFetching}
              className="min-h-10 shrink-0 rounded-lg border border-amber-400 bg-white px-3 font-semibold transition-colors hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60"
            >
              {marketQuery.isFetching ? "Calcul en cours…" : "Relancer l’estimation"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mx-auto grid max-w-[1360px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:px-8">
        <div className="min-w-0 space-y-6">
          <AiPropertyDescriptionCard sale={sale} decision={decision} />

          <DecisionIntroGrid
            sale={sale}
            decision={decision}
            acquisitionCost={acquisitionCost}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <VerdictSection
            sale={sale}
            decision={decision}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <KeyFiguresSection
            sale={sale}
            decision={decision}
            acquisitionCost={acquisitionCost}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <PriceChangingRisksSection sale={sale} decision={decision} />

          <CeilingCalculationSection
            sale={sale}
            decision={decision}
            acquisitionCost={acquisitionCost}
            marketEstimate={marketEstimate}
            marketLoading={marketLoading}
            marketError={marketError}
          />

          <ProofsSection sale={sale} decision={decision} product={product} />

          <BeforeAuctionSection sale={sale} decision={decision} acquisitionCost={acquisitionCost} />

          <InformationRequestAgent sale={sale} />

          <FAQSection />

          <TechnicalDetailsSection sale={sale} product={product} documentCount={documentCount} />
        </div>

        <DecisionActionRail
          sale={sale}
          decision={decision}
          acquisitionCost={acquisitionCost}
          documentCount={documentCount}
        />
      </div>

      <MobileActionBar sale={sale} decision={decision} />
    </main>
  );
}

export function SaleDetailSkeleton() {
  return (
    <main className="min-h-screen bg-white px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <Skeleton className="h-4 w-20 bg-muted" />
        <Skeleton className="mt-4 h-8 w-2/3 bg-muted" />
        <Skeleton className="mt-2 h-4 w-1/2 bg-muted" />
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Skeleton className="h-96 w-full rounded-lg bg-muted" />
            <Skeleton className="h-40 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </div>
          <aside className="space-y-4">
            <Skeleton className="h-48 w-full rounded-lg bg-muted" />
            <Skeleton className="h-32 w-full rounded-lg bg-muted" />
          </aside>
        </div>
      </div>
    </main>
  );
}

export function SaleNotFoundComponent() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center">
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <BrandMark className="mx-auto h-14 w-14" />
        <h1 className="mt-5 font-sans text-2xl font-semibold text-foreground">
          Annonce introuvable
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cette vente n'existe plus ou a été retirée. Elle peut avoir été adjugée ou supprimée par
          la source.
        </p>
        <Link
          to="/sales"
          className="mt-6 inline-flex items-center rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90"
        >
          ← Retour aux annonces
        </Link>
      </div>
    </main>
  );
}

export function SaleErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center">
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <h1 className="font-sans text-2xl font-semibold text-foreground">
          Impossible d'afficher cette annonce
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:bg-foreground/90"
          >
            Réessayer
          </button>
          <Link
            to="/sales"
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:border-gold"
          >
            ← Retour aux annonces
          </Link>
        </div>
      </div>
    </main>
  );
}
