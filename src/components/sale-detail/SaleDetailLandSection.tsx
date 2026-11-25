"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { DetailSection, WhenNear } from "@/components/sale-detail/SaleDetailLayout";
import layoutStyles from "@/components/sale-detail/SaleDetailLayout.module.css";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import { EXAMPLE_COMMUNE_RISKS } from "@/lib/example-commune-risks";
import type { SaleAccessMode } from "@/lib/query-keys";
import { listingCoordinates } from "@/lib/sale-listing";
import type { AuctionSale } from "@/lib/types";

// Chargés à la demande, hors du JavaScript initial de la fiche : ces blocs sont repliés à l'arrivée.
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

/**
 * Un bloc replié de la section : son titre et une ligne qui dit ce qu'il contient. Replié, son
 * contenu n'est pas affiché, donc `WhenNear` ne le charge qu'à l'ouverture. Non contrôlé par React :
 * `revealAnchor` l'ouvre directement quand une ancre y mène.
 */
function Fold({
  id,
  title,
  summary,
  children,
}: {
  id?: string;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <details id={id} className={panelStyles.disclosure}>
      <summary>
        {title}
        <span className={layoutStyles.foldSummary}>{summary}</span>
      </summary>
      {children}
    </details>
  );
}

/**
 * Section 04 de la fiche, « Urbanisme et risques » : cadastre et règles d'urbanisme, risques de la
 * commune. Des données de contexte, longues : repliées à l'arrivée.
 */
export function SaleDetailLandSection({
  sale,
  displaySale,
  access,
  fullData,
  publicDemo,
  signedIn,
  authLoading,
  force,
  cityBlocked,
}: {
  sale: AuctionSale;
  displaySale: AuctionSale;
  access: SaleAccessMode;
  /** Les données de la vente sont ouvertes (offre Analyse, ou vente débloquée par le compte gratuit). */
  fullData: boolean;
  publicDemo: boolean;
  signedIn: boolean;
  authLoading: boolean;
  /** Une ancre a demandé la section : ses blocs lourds montent sans attendre le défilement. */
  force: boolean;
  cityBlocked: boolean;
}) {
  return (
    <DetailSection id="urbanisme-risques">
      <div className={layoutStyles.folds}>
        {/* L'ancre `#urbanism` existe avant le chargement du bloc, pour `revealAnchor`. */}
        <Fold
          id="urbanism"
          title="Urbanisme et cadastre"
          summary="Parcelle, zonage, règles du PLU et risques liés au terrain."
        >
          <WhenNear
            force={force}
            placeholder="Chargement de l’urbanisme et du cadastre…"
            minHeight={320}
          >
            <UrbanismeSection
              sale={displaySale}
              mapLocation={sale}
              loadStructuredUrbanism={fullData && !publicDemo && !authLoading && signedIn}
              // Interroger de nouveau les sources officielles reste à l'abonnement.
              officialLandRefresh={access === "analysis"}
            />
          </WhenNear>
        </Fold>
        <Fold
          title="Risques de la commune"
          summary="Risques naturels et technologiques, plans de prévention, arrêtés de catastrophe naturelle."
        >
          <WhenNear force={force} placeholder="Risques de la commune…">
            <ListingEnvironmentalRisks
              saleId={sale.id}
              demoProfile={publicDemo ? EXAMPLE_COMMUNE_RISKS : undefined}
              enabled={
                !cityBlocked &&
                Boolean(
                  displaySale.city || displaySale.postal_code || listingCoordinates(displaySale),
                )
              }
            />
            {!publicDemo ? <ListingWeatherHistory saleId={sale.id} /> : null}
          </WhenNear>
        </Fold>
      </div>
    </DetailSection>
  );
}
