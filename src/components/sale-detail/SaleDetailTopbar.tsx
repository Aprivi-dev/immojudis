"use client";

import Link from "next/link";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import { ListingActions } from "@/components/sale-detail/SaleListing";
import layoutStyles from "@/components/sale-detail/SaleDetailLayout.module.css";
import listingStyles from "@/components/sale-detail/SaleListing.module.css";
import { salesReturnHref, salesReturnLabel } from "@/lib/navigation";
import type { AuctionSale } from "@/lib/types";

/** Haut de la fiche vente : retour à la liste, fil d'Ariane et actions de l'annonce. */
export function SaleDetailTopbar({
  saleId,
  displaySale,
  returnTo,
  backLabel,
  cityBlocked,
  publicDemo,
  showFavorite,
}: {
  saleId: string;
  displaySale: AuctionSale;
  returnTo: string | undefined;
  backLabel: string | undefined;
  cityBlocked: boolean;
  publicDemo: boolean;
  showFavorite: boolean;
}) {
  return (
    <div className={listingStyles.topbar}>
      <div className={layoutStyles.crumbs}>
        <Link
          href={salesReturnHref(returnTo, saleId)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold text-brand-navy transition-colors hover:text-gold-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {backLabel ?? salesReturnLabel(returnTo)}
        </Link>
        <nav aria-label="Fil d’Ariane" className={layoutStyles.breadcrumb}>
          <ol>
            <li>
              <Link href="/">Accueil</Link>
            </li>
            <li>
              <Link href="/sales">Ventes</Link>
            </li>
            {displaySale.city && !cityBlocked ? (
              <li aria-current="page">{displaySale.city}</li>
            ) : null}
          </ol>
        </nav>
      </div>
      <ListingActions sale={displaySale} publicDemo={publicDemo} showFavorite={showFavorite} />
    </div>
  );
}
