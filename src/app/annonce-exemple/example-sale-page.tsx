"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { MapboxPreconnect } from "@/components/MapboxPreconnect";
import Link from "next/link";
import { SaleDetailSkeleton } from "@/components/SaleDetailFallbacks";
import { Card, buttonClasses } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { loginPathWithRedirect } from "@/lib/navigation";
import type { MarketEstimate } from "@/lib/market.server";
import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import type { AuctionSale } from "@/lib/types";
import { trackProductEvent } from "@/lib/product-events";

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
  ceilingChoices,
  adjudicationStatisticsEnabled = false,
}: {
  example: { sale: AuctionSale; marketEstimate: MarketEstimate };
  /** Choix de départ de l'enchère plafond, les mêmes que les chiffres de l'accueil. */
  ceilingChoices?: CeilingUserChoices;
  /** Lu côté serveur (`ADJUDICATION_PRICE_STATISTICS_ENABLED`) : la démo montre l'onglet quand le drapeau est ouvert. */
  adjudicationStatisticsEnabled?: boolean;
}) {
  const { user } = useAuth();
  useEffect(() => {
    trackProductEvent("sample_report_viewed");
  }, []);
  return (
    <>
      {/* L'image d'attente de la vue aérienne vient de api.mapbox.com : connexion préparée tôt. */}
      <MapboxPreconnect />
      {/* Un repère `complementary` nommé : un `role="note"` seul reste hors de tout repère (RGAA 9.2). */}
      <aside
        aria-label="Exemple fictif"
        className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-semibold text-amber-950"
      >
        Exemple fictif : ce bien, son adresse et ses chiffres sont inventés pour illustrer
        l’analyse. Aucune vente réelle ne correspond à cette page.
      </aside>
      <AnalysisSaleDetailView
        sale={example.sale}
        marketEstimateOverride={example.marketEstimate}
        returnTo="/#exemples"
        backLabel="Retour aux exemples"
        publicDemo
        defaultCeilingChoices={ceilingChoices}
        adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      />
      {/* Fin de l'exemple : la suite est un compte gratuit et le catalogue, pas /offres (l'offre
          Analyse n'est pas encore souscriptible). */}
      <section
        aria-labelledby="example-next-title"
        className="mx-auto max-w-5xl px-4 pb-14 sm:px-6"
        data-testid="example-next-steps"
      >
        <Card className="grid gap-3">
          <h2 id="example-next-title" className="font-display text-2xl font-semibold">
            Essayez sur une vraie vente
          </h2>
          <p className="text-sm text-ink-soft">
            Cette analyse est un exemple fictif.{" "}
            {user
              ? "Parcourez le catalogue pour ouvrir la fiche d’une vente réelle."
              : "Un compte gratuit, sans carte bancaire, ouvre l’adresse, les photos et la fourchette de valeur des ventes du catalogue."}
          </p>
          <div className="flex flex-wrap gap-3">
            {user ? null : (
              <Link
                href={loginPathWithRedirect("/sales", { reason: "offre" })}
                className={buttonClasses({ variant: "primary" })}
              >
                Créer mon compte gratuit
              </Link>
            )}
            <Link
              href="/sales"
              className={buttonClasses({ variant: user ? "primary" : "secondary" })}
            >
              Explorer les ventes
            </Link>
          </div>
        </Card>
      </section>
    </>
  );
}
