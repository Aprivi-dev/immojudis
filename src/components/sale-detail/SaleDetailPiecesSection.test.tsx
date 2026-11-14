// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { SaleDetailPiecesSection } from "./SaleDetailPiecesSection";

vi.mock("@/components/sale-detail/DocumentReadingSection", () => ({
  DocumentReadingSection: () => null,
}));
vi.mock("@/components/LaunchOfferIncludedTag", () => ({ LaunchOfferIncludedTag: () => null }));

afterEach(cleanup);

function renderSection(values: Partial<AuctionSale>) {
  return render(
    <SaleDetailPiecesSection
      saleId="sale-1"
      sale={{ ...EXAMPLE_SALE, sale_procedure: null, source_blocks: null, ...values }}
      documentsOpen={false}
      onDocumentsOpenChange={() => undefined}
      locked
      force={false}
      readingEnabled={false}
      access="discovery"
      userKey={undefined}
    />,
  );
}

const section = () => document.getElementById("pieces")!;

/**
 * Cible du lien « Où consulter le cahier » de la fiche des comptes : la même ligne que la fiche publique, avant la
 * liste des pièces (relecture de code et juridique-rgpd du 14/11/2026).
 */
describe("SaleDetailPiecesSection : où consulter le cahier", () => {
  it("saisie immobilière confirmée : greffe du juge de l'exécution ou avocat du créancier poursuivant", () => {
    renderSection({
      sale_venue_type: "tribunal",
      sale_legal_framework: "judicial_seizure",
      sale_verification_status: "verified",
    });
    expect(section().textContent).toContain(
      "Cahier des conditions de vente : Consultable au greffe du juge de l’exécution du tribunal judiciaire ou au cabinet de l’avocat du créancier poursuivant",
    );
    expect(
      screen
        .getByText(/Consultable au greffe/)
        .compareDocumentPosition(screen.getByText("Consulter les pièces du dossier")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("type de vente non confirmé : l'avis de vente", () => {
    renderSection({ sale_venue_type: "tribunal", sale_verification_status: "pending" });
    expect(section().textContent).toContain(
      "Cahier des conditions de vente : Le lieu de consultation figure dans l’avis de vente.",
    );
  });

  it("vente notariale confirmée : aucune ligne", () => {
    renderSection({
      sale_venue_type: "notary",
      sale_legal_framework: "voluntary_notarial",
      sale_verification_status: "verified",
    });
    expect(section().textContent).not.toContain("Cahier des conditions de vente :");
  });
});
