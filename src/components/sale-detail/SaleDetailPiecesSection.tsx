"use client";

import { LaunchOfferIncludedTag } from "@/components/LaunchOfferIncludedTag";
import { DetailSection, WhenNear } from "@/components/sale-detail/SaleDetailLayout";
import { DocumentReadingSection } from "@/components/sale-detail/DocumentReadingSection";
import { SaleDocumentsSection } from "@/components/sale-detail/SaleDetailSections";
import type { SaleAccessMode } from "@/lib/query-keys";
import type { AuctionSale } from "@/lib/types";

/** Section 05 de la fiche, « Pièces du dossier » : la liste des pièces et leur lecture. */
export function SaleDetailPiecesSection({
  saleId,
  sale,
  documentsOpen,
  onDocumentsOpenChange,
  locked,
  force,
  readingEnabled,
  access,
  userKey,
}: {
  saleId: string;
  sale: AuctionSale;
  documentsOpen: boolean;
  onDocumentsOpenChange: (open: boolean) => void;
  locked: boolean;
  /** Une ancre a demandé la section : ses blocs lourds montent sans attendre le défilement. */
  force: boolean;
  readingEnabled: boolean;
  access: SaleAccessMode;
  userKey: string | undefined;
}) {
  return (
    <DetailSection id="pieces">
      <SaleDocumentsSection
        sale={sale}
        open={documentsOpen}
        onOpenChange={onDocumentsOpenChange}
        locked={locked}
      />
      <div className="grid gap-2">
        <LaunchOfferIncludedTag />
        <WhenNear force={force} placeholder="Lecture des pièces du dossier…">
          <DocumentReadingSection
            saleId={saleId}
            enabled={readingEnabled}
            access={access}
            userKey={userKey}
          />
        </WhenNear>
      </div>
    </DetailSection>
  );
}
