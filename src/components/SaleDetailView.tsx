import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@/lib/router-compat";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import { fetchEnvironmentalContext, fetchPrecomputedMarketEstimate } from "@/lib/client-api";
import type { EnvironmentalContext } from "@/lib/environment.functions";
import type { MarketEstimate } from "@/lib/market.functions";
import { computeAcquisitionCosts, DEFAULTS } from "@/lib/profitability";
import { buildSaleProductSources } from "@/lib/sale-detail-sources";
import { saleDisplayTitle } from "@/lib/sale-title";
import type { AuctionSale } from "@/lib/types";
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
import { userMessage } from "@/lib/user-messages";

export { SaleDetailSkeleton, SaleNotFoundComponent } from "./SaleDetailFallbacks";
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
  const [environmentRequested] = useState(
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
    <main id="contenu" className="min-h-screen bg-background pb-28 text-foreground lg:pb-20">
      <ListingActionBar
        sale={sale}
        title={referenceLabel}
        location={location}
        returnTo={returnTo}
      />

      <DecisionHero
        sale={sale}
        title={referenceLabel}
        location={location}
        media={media}
        decision={decision}
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
                    userMessage(marketQuery.error, "L’estimation est momentanément indisponible.")}
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

          <ProofsSection sale={sale} product={product} />

          <BeforeAuctionSection sale={sale} decision={decision} acquisitionCost={acquisitionCost} />

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

export function SaleErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <main
      id="contenu"
      className="flex min-h-screen items-center justify-center bg-white px-4 py-16 text-center"
    >
      <div className="max-w-2xl rounded-lg border border-border bg-white p-8 shadow-xl shadow-slate-900/10">
        <h1 className="font-sans text-2xl font-semibold text-foreground">
          Impossible d'afficher cette annonce
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {userMessage(
            error,
            "Cette annonce est momentanément indisponible. Réessayez dans un instant.",
          )}
        </p>
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
