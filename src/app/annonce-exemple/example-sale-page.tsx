"use client";

import dynamic from "next/dynamic";
import { SaleDetailSkeleton } from "@/components/SaleDetailFallbacks";
import type { MarketEstimate } from "@/lib/market.server";
import type { AuctionSale } from "@/lib/types";

const AnalysisSaleDetailView = dynamic(
  () =>
    import("@/components/SimplifiedSaleDetailView").then((module) => module.AnalysisSaleDetailView),
  { loading: () => <SaleDetailSkeleton /> },
);

/**
 * The example is chosen on the server (`?bien=`), so the page content is part of
 * the HTML sent to crawlers; nothing here reads the URL.
 */
export function ExampleSalePage({
  example,
}: {
  example: { sale: AuctionSale; marketEstimate: MarketEstimate };
}) {
  return (
    <>
      <div
        role="note"
        className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-950"
      >
        Exemple fictif : ce bien, son adresse et ses chiffres sont inventés pour illustrer
        l’analyse. Aucune vente réelle ne correspond à cette page.
      </div>
      <AnalysisSaleDetailView
        sale={example.sale}
        marketEstimateOverride={example.marketEstimate}
        returnTo="/#exemples"
        backLabel="Retour aux exemples"
        publicDemo
      />
    </>
  );
}
