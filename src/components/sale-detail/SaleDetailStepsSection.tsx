"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { SaleProcedurePanel } from "@/components/SaleProcedurePanel";
import { DetailSection } from "@/components/sale-detail/SaleDetailLayout";
import { SaleTimeline } from "@/components/sale-detail/SaleTimeline";
import { ListingPracticalDetails } from "@/components/sale-detail/SaleListing";
import { LawyerSection } from "@/components/sale-detail/SaleDetailSections";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import type { AiReviewProjectionReadModel, AiReviewRequestStatus } from "@/lib/ai-review-guard";
import { listingSaleStatus } from "@/lib/listing-evidence";
import type { SaleAccessMode } from "@/lib/query-keys";
import type { ReportSimulation } from "@/lib/report-simulation";
import type { AuctionSale } from "@/lib/types";

const PropertyReportActions = dynamic(
  () => import("@/components/PropertyReportActions").then((module) => module.PropertyReportActions),
  {
    loading: () => (
      <p className="mt-3 text-sm text-muted-foreground">Chargement des actions du rapport…</p>
    ),
  },
);
// « Mes questions pour l'avocat » (n° 92) : chargé à la demande, avec le repérage des points ouverts.
const LawyerQuestions = dynamic(() =>
  import("@/components/sale-detail/LawyerQuestions").then((module) => module.LawyerQuestions),
);

/**
 * Section 06 de la fiche, « Démarches » : déroulé de la vente, prochaines étapes, informations
 * pratiques, « Mon dossier » (offre Analyse), avocat, conditions de la vente et rapport.
 */
export function SaleDetailStepsSection({
  saleId,
  displaySale,
  access,
  fullData,
  publicDemo,
  userId,
  isTribunalSale,
  priceBlocked,
  dateBlocked,
  aiReviewProjections,
  aiReviewStatus,
  fileCard,
  participationOpen,
  onParticipationToggle,
  reportAvailable,
  surfaceEnteredByUser,
  reportSimulation,
}: {
  saleId: string;
  displaySale: AuctionSale;
  access: SaleAccessMode;
  fullData: boolean;
  publicDemo: boolean;
  userId: string | undefined;
  isTribunalSale: boolean;
  priceBlocked: boolean;
  dateBlocked: boolean;
  aiReviewProjections: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus: AiReviewRequestStatus;
  /**
   * Offre Analyse : le panneau résume le dossier ; la carte complète (plafond saisi à la main,
   * rappels, plafond à vérifier) est ici, à l'ancre `#mon-dossier`. `null` sinon.
   */
  fileCard: ReactNode;
  participationOpen: boolean;
  onParticipationToggle: () => void;
  /** « Conserver votre analyse » : offre Analyse, plafond ouvert et sans conflit de valorisation. */
  reportAvailable: boolean;
  surfaceEnteredByUser: boolean;
  reportSimulation: ReportSimulation | undefined;
}) {
  return (
    <DetailSection id="demarches">
      <SaleTimeline sale={displaySale} priceBlocked={priceBlocked} dateBlocked={dateBlocked} />
      <div className={panelStyles.steps}>
        <h3>Vos prochaines étapes</h3>
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
      <div className={panelStyles.practical}>
        <ListingPracticalDetails
          sale={displaySale}
          aiReviewProjections={aiReviewProjections}
          aiReviewStatus={aiReviewStatus}
        />
      </div>
      {fileCard}
      <LawyerSection sale={displaySale} />
      {fullData && isTribunalSale && userId && !publicDemo && !listingSaleStatus(displaySale) ? (
        <LawyerQuestions saleId={saleId} access={access} userKey={userId} />
      ) : null}
      <details className={panelStyles.disclosure} open={participationOpen}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            onParticipationToggle();
          }}
        >
          Voir toutes les conditions de la vente
        </summary>
        <SaleProcedurePanel sale={displaySale} />
      </details>
      {reportAvailable ? (
        <section
          id="rapport"
          aria-label="Sauvegarde et export du rapport"
          className={panelStyles.reportActions}
        >
          <h3>Conserver votre analyse</h3>
          <p>Sauvegardez le dossier ou exportez le rapport avec le scénario courant.</p>
          {surfaceEnteredByUser ? (
            <p data-testid="report-entered-surface">
              Le rapport reprend les seules données de l’annonce : un plafond calculé avec la
              surface saisie par vous n’y figure pas.
            </p>
          ) : null}
          <PropertyReportActions
            saleId={saleId}
            compact
            simulation={reportSimulation}
            requireSimulation
          />
        </section>
      ) : null}
    </DetailSection>
  );
}
