"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { DepartmentAlertProposal } from "@/components/DepartmentAlertProposalLazy";
import { MapboxPreconnect } from "@/components/MapboxPreconnect";
import Link from "next/link";
import { SaleDetailSkeleton } from "@/components/SaleDetailFallbacks";
import { Card, Notice, buttonClasses } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { ceilingVenueScopeText } from "@/lib/fee-regime-labels";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import { HOME_TRIAL_NOTE } from "@/lib/launch-offer";
import { loginPathWithRedirect } from "@/lib/navigation";
import { FREE_ACCESS_LINE, MONTHLY_SALE_UNLOCKS } from "@/lib/sale-unlocks";
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
 * Sous la synthèse de l'exemple, à portée du visiteur convaincu : l'inscription, avec la même
 * phrase que sous le bouton de l'accueil (l'essai quand il est ouvert, sinon la ligne du compte
 * gratuit). Rien pour une personne connectée.
 */
function ExampleSummarySignup() {
  const { user } = useAuth();
  const trialOpen = useLaunchOffer().active;
  if (user) return null;
  return (
    <div
      className="mt-5 grid gap-2 border-t border-line-soft pt-5"
      data-testid="example-summary-cta"
    >
      <Link
        href={loginPathWithRedirect("/sales", { reason: "exemple" })}
        className={buttonClasses({ variant: "primary" })}
      >
        Créer mon compte gratuit
      </Link>
      <p className="text-sm text-ink-soft">{trialOpen ? HOME_TRIAL_NOTE : FREE_ACCESS_LINE}</p>
    </div>
  );
}

/**
 * Mention « Exemple fictif », en tête du contenu de la fiche : sous la pilule de navigation (avant la
 * page, l'en-tête fixe la barrait), aux couleurs `warning` de la charte. Un repère `complementary`
 * nommé : un `role="note"` seul reste hors de tout repère (RGAA 9.2).
 */
function ExampleFictionNotice() {
  return (
    <aside aria-label="Exemple fictif" className="mb-4">
      <Notice tone="warning" className="font-semibold">
        Exemple fictif : ce bien, son adresse et ses chiffres sont inventés pour illustrer
        l’analyse. Aucune vente réelle ne correspond à cette page.
      </Notice>
    </aside>
  );
}

/**
 * Fin de l'exemple, pour un visiteur : le même calcul sur les ventes réelles. Avec l'essai, sur toutes
 * les ventes qui ont un plafond (`open` : les régimes de frais ouverts ; jamais les ventes domaniales)
 * pendant l'essai, puis sur les déblocages du mois ; sans l'essai (ou état non lu), les déblocages seuls.
 */
function exampleNextStepsText(trialOpen: boolean, open?: readonly FeeRegimeKey[]): string {
  return trialOpen
    ? `Avec un compte gratuit, ce calcul sur les ventes réelles (${ceilingVenueScopeText(open)}) : sur toutes pendant ${ANALYSIS_TRIAL_DAYS} jours, puis sur ${MONTHLY_SALE_UNLOCKS} par mois. Sans carte bancaire.`
    : `Avec un compte gratuit, ce calcul sur ${MONTHLY_SALE_UNLOCKS} ventes réelles par mois. Sans carte bancaire.`;
}

/**
 * The example is chosen on the server (`?bien=`), so the page content is part of
 * the HTML sent to crawlers; nothing here reads the URL.
 */
export function ExampleSalePage({
  example,
  ceilingChoices,
  adjudicationStatisticsEnabled = false,
  openFeeRegimes,
}: {
  example: { sale: AuctionSale; marketEstimate: MarketEstimate };
  /** Choix de départ de l'enchère plafond, les mêmes que les chiffres de l'accueil. */
  ceilingChoices?: CeilingUserChoices;
  /** Lu côté serveur (`ADJUDICATION_PRICE_STATISTICS_ENABLED`) : la démo montre l'onglet quand le drapeau est ouvert. */
  adjudicationStatisticsEnabled?: boolean;
  /** Régimes de frais ouverts (`openFeeRegimesFromEnv`) ; absent : tous ceux dont les règles sont définies. */
  openFeeRegimes?: readonly FeeRegimeKey[];
}) {
  const { user } = useAuth();
  const trialOpen = useLaunchOffer().active;
  useEffect(() => {
    trackProductEvent("sample_report_viewed");
  }, []);
  return (
    <>
      {/* L'image d'attente de la vue aérienne vient de api.mapbox.com : connexion préparée tôt. */}
      <MapboxPreconnect />
      <AnalysisSaleDetailView
        topNotice={<ExampleFictionNotice />}
        sale={example.sale}
        marketEstimateOverride={example.marketEstimate}
        returnTo="/#essayer"
        backLabel="Retour aux exemples"
        summaryFooter={<ExampleSummarySignup />}
        publicDemo
        defaultCeilingChoices={ceilingChoices}
        adjudicationStatisticsEnabled={adjudicationStatisticsEnabled}
      />
      {/* Fin de l'exemple : la suite est un compte gratuit et le catalogue, pas /offres (l'offre
          Analyse n'est pas encore souscriptible). */}
      <section
        aria-labelledby="example-next-title"
        className="mx-auto max-w-5xl px-4 pb-6 sm:px-6"
        data-testid="example-next-steps"
      >
        <Card className="grid gap-3">
          <h2 id="example-next-title" className="font-display text-2xl font-semibold">
            Essayez sur une vraie vente
          </h2>
          <p className="text-sm text-ink-soft">
            {user
              ? "Cette analyse est un exemple fictif. Parcourez le catalogue pour ouvrir la fiche d’une vente réelle."
              : exampleNextStepsText(trialOpen, openFeeRegimes)}
          </p>
          <div className="flex flex-wrap gap-3">
            {user ? null : (
              <Link
                href={loginPathWithRedirect("/sales", { reason: "exemple" })}
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
      {/* Pour un vrai département : l'exemple est fictif, l'alerte porte sur le catalogue réel. */}
      <DepartmentAlertProposal className="mx-auto max-w-5xl px-4 pb-14 sm:px-6" />
    </>
  );
}
