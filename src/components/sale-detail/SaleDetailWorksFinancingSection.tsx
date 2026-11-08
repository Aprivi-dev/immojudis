"use client";

import dynamic from "next/dynamic";
import { PremiumFeaturePreview } from "@/components/PremiumFeaturePreview";
import type { FinancingDraft, FinancingResult } from "@/components/sale-detail/FinancingSimulator";
import type { ListingRentalDraft } from "@/components/sale-detail/ListingRental";
import { DetailSection, WhenNear } from "@/components/sale-detail/SaleDetailLayout";
import layoutStyles from "@/components/sale-detail/SaleDetailLayout.module.css";
import panelStyles from "@/components/sale-detail/SaleDetailPanels.module.css";
import type { AiReviewProjectionReadModel, AiReviewRequestStatus } from "@/lib/ai-review-guard";
import { maxWorksAtBid, type CeilingHypotheses } from "@/lib/bid-ceiling-engine";
import type { SaleAccessMode } from "@/lib/query-keys";
import type { AuctionSale } from "@/lib/types";
import type { WorksBreakdownItem } from "@/lib/works-breakdown";

const ListingWorks = dynamic(
  () => import("@/components/sale-detail/ListingWorks").then((module) => module.ListingWorks),
  {
    loading: () => <p className="p-6 text-sm text-muted-foreground">Chargement des travaux…</p>,
  },
);
const FinancingSimulator = dynamic(
  () =>
    import("@/components/sale-detail/FinancingSimulator").then(
      (module) => module.FinancingSimulator,
    ),
  {
    loading: () => <p className="p-6 text-sm text-muted-foreground">Chargement du financement…</p>,
  },
);
const ListingRental = dynamic(() =>
  import("@/components/sale-detail/ListingRental").then((module) => module.ListingRental),
);

/** Section 04 de la fiche, « Travaux et financement » : travaux, financement, simulation locative. */
export function SaleDetailWorksFinancingSection({
  saleId,
  displaySale,
  access,
  force,
  inputsToConfirm,
  retainedWorks,
  worksBreakdown,
  onWorksBreakdownChange,
  surface,
  onScenarioSelect,
  heroCeiling,
  ceilingHypotheses,
  aiReviewProjections,
  aiReviewStatus,
  financingLoading,
  projectCost,
  financingDraft,
  onFinancingDraftChange,
  onFinancingResultChange,
  acquisitionCost,
  monthlyDebtService,
  rentalDraft,
  onRentalDraftChange,
}: {
  saleId: string;
  displaySale: AuctionSale;
  access: SaleAccessMode;
  /** Une ancre a demandé la section : ses blocs lourds montent sans attendre le défilement. */
  force: boolean;
  /** Conflit de valorisation ou caractéristiques du calcul bloquées par la relecture IA. */
  inputsToConfirm: boolean;
  retainedWorks: number | null;
  worksBreakdown: readonly WorksBreakdownItem[] | undefined;
  onWorksBreakdownChange: (items: WorksBreakdownItem[], total: number) => void;
  surface: number | null;
  onScenarioSelect: (amount: number) => void;
  heroCeiling: number | null;
  ceilingHypotheses: CeilingHypotheses;
  aiReviewProjections: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus: AiReviewRequestStatus;
  /** Le compte et son profil sont en cours de lecture (le simulateur ne lit `initialDraft` qu'au montage). */
  financingLoading: boolean;
  projectCost: number | null;
  financingDraft: Partial<FinancingDraft> | null;
  onFinancingDraftChange: (draft: FinancingDraft) => void;
  onFinancingResultChange: (result: FinancingResult | null) => void;
  acquisitionCost: number | null;
  monthlyDebtService: number | null;
  rentalDraft: ListingRentalDraft | null;
  onRentalDraftChange: (draft: ListingRentalDraft) => void;
}) {
  return (
    <DetailSection id="travaux-financement">
      <div className={layoutStyles.stack}>
        <div className="grid min-w-0 gap-4">
          {access === "analysis" ? (
            <>
              {inputsToConfirm ? (
                <div className={panelStyles.warning} role="status">
                  <p>
                    Les caractéristiques nécessaires au calcul restent à confirmer. Votre détail
                    travaux peut être préparé, puis intégré au scénario après vérification.
                  </p>
                </div>
              ) : null}
              <WhenNear force={force} placeholder="Chargement des travaux…">
                <ListingWorks
                  sale={displaySale}
                  estimatedBudget={retainedWorks}
                  worksBreakdown={worksBreakdown}
                  onWorksBreakdownChange={onWorksBreakdownChange}
                  surface={surface}
                  onScenarioSelect={retainedWorks != null ? onScenarioSelect : undefined}
                  maxWorks={
                    heroCeiling != null
                      ? maxWorksAtBid(ceilingHypotheses, displaySale.starting_price_eur ?? 0)
                      : null
                  }
                />
              </WhenNear>
            </>
          ) : (
            <PremiumFeaturePreview
              title="Estimez vos travaux avec l’offre Analyse"
              description="Préparez une enveloppe par poste et intégrez-la à votre scénario d’achat."
              labels={["Budget travaux", "Détail par poste", "Coût du projet"]}
            />
          )}
        </div>
        <div id="financing" className="min-w-0 scroll-mt-2">
          {/* Le simulateur ne lit `initialDraft` qu'au montage : on attend le compte et son
              profil pour que l'apport du profil le préremplisse. */}
          {financingLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Chargement du financement…</p>
          ) : (
            <WhenNear force={force} placeholder="Chargement du financement…">
              <FinancingSimulator
                sale={displaySale}
                aiReviewProjections={aiReviewProjections}
                aiReviewStatus={aiReviewStatus}
                projectPriceOverride={projectCost}
                initialDraft={financingDraft}
                onDraftChange={onFinancingDraftChange}
                onResultChange={onFinancingResultChange}
                initialInsuranceRate={0.3}
              />
            </WhenNear>
          )}
        </div>
      </div>
      <WhenNear force={force} placeholder="Simulation locative…">
        <ListingRental
          saleId={saleId}
          acquisitionCost={acquisitionCost}
          monthlyDebtService={monthlyDebtService}
          initialDraft={rentalDraft}
          onDraftChange={onRentalDraftChange}
        />
      </WhenNear>
    </DetailSection>
  );
}
