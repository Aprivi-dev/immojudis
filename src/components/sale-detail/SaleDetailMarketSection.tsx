"use client";

import dynamic from "next/dynamic";
import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import { DetailSection, WhenNear } from "@/components/sale-detail/SaleDetailLayout";
import { MarketEvidence, MarketSnapshot } from "@/components/sale-detail/SaleDetailMarket";
import { RentalMarketBlockLazy } from "@/components/sale-detail/RentalMarketBlockLazy";
import layoutStyles from "@/components/sale-detail/SaleDetailLayout.module.css";
import { EXAMPLE_COMMUNE_RISKS } from "@/lib/example-commune-risks";
import type { HousingTension } from "@/lib/housing-tension";
import type { MarketEstimate } from "@/lib/market.server";
import type { SaleAccessMode } from "@/lib/query-keys";
import type { RentReference } from "@/lib/rent-reference";
import { listingCoordinates } from "@/lib/sale-listing";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

const ListingStatistics = dynamic(
  () =>
    import("@/components/sale-detail/ListingStatistics").then((module) => module.ListingStatistics),
  {
    loading: () => (
      <p className="p-6 text-sm text-muted-foreground">Chargement des statistiques du tribunal…</p>
    ),
  },
);
// Onglet Quartier : chargé à la demande, hors du JavaScript initial de la fiche (il n'est pas
// l'onglet d'arrivée).
const UrbanismeSection = dynamic(
  () =>
    import("@/components/sale-detail/UrbanismeSection").then((module) => module.UrbanismeSection),
  {
    loading: () => (
      <p className="p-6 text-sm text-muted-foreground">Chargement de l’urbanisme et du cadastre…</p>
    ),
  },
);
const ListingEnvironmentalRisks = dynamic(() =>
  import("@/components/sale-detail/ListingEnvironmentalRisks").then(
    (module) => module.ListingEnvironmentalRisks,
  ),
);
const ListingWeatherHistory = dynamic(() =>
  import("@/components/sale-detail/ListingWeatherHistory").then(
    (module) => module.ListingWeatherHistory,
  ),
);

/** Section 03 de la fiche, « Marché et comparables » : marché, quartier, statistiques, urbanisme. */
export function SaleDetailMarketSection({
  sale,
  displaySale,
  access,
  fullData,
  publicDemo,
  signedIn,
  authLoading,
  force,
  detailedMarketEstimate,
  marketComputedAt,
  marketLoading,
  marketActionable,
  ceilingOpen,
  startingPrice,
  rentReference,
  housingTension,
  statisticsAvailable,
  adjudicationStatisticsEnabled,
  propertyTypeVerified,
  cityBlocked,
}: {
  sale: AuctionSale;
  displaySale: AuctionSale;
  access: SaleAccessMode;
  fullData: boolean;
  publicDemo: boolean;
  signedIn: boolean;
  authLoading: boolean;
  /** Une ancre a demandé la section : ses blocs lourds montent sans attendre le défilement. */
  force: boolean;
  detailedMarketEstimate: MarketEstimate | null;
  marketComputedAt: string | null;
  marketLoading: boolean;
  marketActionable: boolean;
  ceilingOpen: boolean;
  startingPrice: number | null;
  rentReference: RentReference | null;
  housingTension: HousingTension | null;
  statisticsAvailable: boolean;
  adjudicationStatisticsEnabled: boolean;
  propertyTypeVerified: boolean;
  cityBlocked: boolean;
}) {
  return (
    <DetailSection id="marche">
      {access === "analysis" ? (
        <>
          <MarketSnapshot
            estimate={detailedMarketEstimate}
            computedAt={marketComputedAt}
            loading={marketLoading}
          />
          {marketActionable || ceilingOpen ? (
            <MarketEvidence marketEstimate={detailedMarketEstimate} marketLoading={marketLoading} />
          ) : (
            <p id="market" className={layoutStyles.fineprint}>
              Références insuffisantes pour afficher une estimation exploitable sur cette vente.
            </p>
          )}
        </>
      ) : null}
      {/* L'ancre `#quartier` des anciens liens mène au marché locatif et au quartier. */}
      <div id="quartier" className="grid scroll-mt-2 gap-5">
        {rentReference?.source.startsWith("anil_") || housingTension ? (
          <RentalMarketBlockLazy
            sale={displaySale}
            startingPriceEur={startingPrice}
            surfaceM2={getSaleSurface(displaySale).value}
            reference={rentReference}
            tension={housingTension}
          />
        ) : null}
      </div>
      {statisticsAvailable ? (
        fullData ? (
          <WhenNear
            force={force}
            placeholder="Chargement des statistiques du tribunal…"
            minHeight={480}
          >
            <ListingStatistics
              sale={sale}
              premium={fullData && adjudicationStatisticsEnabled}
              showUpcomingListings={access === "analysis"}
              publicDemo={publicDemo}
              propertyTypeVerified={propertyTypeVerified}
            />
          </WhenNear>
        ) : (
          <PremiumFeaturePreview
            title={
              signedIn && !publicDemo
                ? "Les statistiques du tribunal avec l’offre Analyse ou en débloquant cette vente"
                : "Les statistiques du tribunal avec l’offre Analyse"
            }
            description="Consultez les tendances, les adjudications et les indicateurs disponibles pour préparer votre enchère."
            labels={["Scénarios d’enchères", "Prix d’adjudication", "Activité du tribunal"]}
            unlockOffer={Boolean(signedIn && !publicDemo)}
          />
        )
      ) : null}
      {/* L'ancre `#urbanism` existe avant le chargement du bloc, pour `revealAnchor`. */}
      <div id="urbanism" className="scroll-mt-2">
        <WhenNear
          force={force}
          placeholder="Chargement de l’urbanisme et du cadastre…"
          minHeight={320}
        >
          <UrbanismeSection
            sale={displaySale}
            mapLocation={sale}
            loadStructuredUrbanism={
              access === "analysis" && !publicDemo && !authLoading && signedIn
            }
          />
        </WhenNear>
      </div>
      <WhenNear force={force} placeholder="Risques de la commune…">
        <ListingEnvironmentalRisks
          saleId={sale.id}
          demoProfile={publicDemo ? EXAMPLE_COMMUNE_RISKS : undefined}
          enabled={
            !cityBlocked &&
            Boolean(displaySale.city || displaySale.postal_code || listingCoordinates(displaySale))
          }
        />
        {!publicDemo ? <ListingWeatherHistory saleId={sale.id} /> : null}
      </WhenNear>
    </DetailSection>
  );
}
