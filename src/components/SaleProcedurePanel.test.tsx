// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SaleProcedureBadge } from "./SaleProcedureBadge";
import { SaleProcedurePanel, SaleProcedureSummary } from "./SaleProcedurePanel";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { saleWithoutListingSource } from "@/lib/property-report/entitlements";
import type { AuctionSale } from "@/lib/types";

describe("sale procedure identity", () => {
  afterEach(cleanup);

  it("shows the public family without disclosing contacts or participation rules", () => {
    const { container } = render(
      <SaleProcedureBadge
        sale={
          {
            sale_venue_type: "notary",
            sale_verification_status: "pending",
            lawyer_contact: "confidential@example.test",
          } as AuctionSale
        }
      />,
    );
    expect(screen.getByText("Vente notariale").title).toContain("En cours de vérification");
    expect(container.innerHTML).not.toContain("confidential");
    expect(container.innerHTML).not.toContain("Avocat obligatoire");
  });

  it("does not assume a notarial sale is voluntary or require a lawyer", () => {
    render(
      <SaleProcedureSummary
        sale={
          {
            sale_venue_type: "notary",
            sale_legal_framework: "judicial_partition",
            sale_verification_status: "verified",
          } as AuctionSale
        }
      />,
    );
    expect(screen.getByText("Licitation ou partage judiciaire")).toBeTruthy();
    expect(screen.getByText("Représentation à confirmer")).toBeTruthy();
    expect(screen.queryByText("Avocat obligatoire pour enchérir")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Voir les démarches et conditions de cette vente" })
        .getAttribute("href"),
    ).toBe("#participation");
  });

  it("keeps an unknown family explicit", () => {
    render(
      <SaleProcedureSummary
        sale={{ sale_venue_type: "unknown", sale_verification_status: "pending" } as AuctionSale}
      />,
    );
    expect(screen.getByText("Type de vente à confirmer")).toBeTruthy();
    expect(screen.getByText("Cadre juridique à confirmer")).toBeTruthy();
  });

  it("définit « surenchère » au survol dans les conditions d'une vente au tribunal (repasse n° 26)", () => {
    render(
      <SaleProcedurePanel
        sale={{ sale_venue_type: "tribunal", sale_verification_status: "verified" } as AuctionSale}
      />,
    );
    expect(screen.getByRole("button", { name: "Définition : surenchère" })).toBeTruthy();
  });
});

/**
 * Sans l'offre Analyse, la base (v_auction_sales_discovery, v_auction_sales_unlocked) sert la procédure sans
 * la source de l'annonce : la vérification reste lisible sans lien vers l'annonce ni nom de la source.
 */
describe("sale procedure sources without the listing source", () => {
  afterEach(cleanup);

  const LISTING_URL = "https://annonce-privee.example/vente/42";
  const example = (EXAMPLE_SALE.source_blocks as Record<string, unknown>).sale_procedure as Record<
    string,
    unknown
  >;
  const procedure = (caseSources: unknown[], regulatorySources: unknown[] = []) => ({
    ...example,
    verification: {
      ...(example.verification as Record<string, unknown>),
      case_sources: caseSources,
      regulatory_sources: regulatorySources,
    },
  });
  const listing = {
    kind: "listing",
    label: "Plateforme privée",
    source_name: "plateforme-privee",
    url: LISTING_URL,
  };
  const document = {
    kind: "document",
    label: "Cahier des conditions de vente",
    source_name: "plateforme-privee",
    url: "https://pieces.example/ccv.pdf",
  };
  const sale = (saleProcedure: unknown) =>
    ({ sale_venue_type: "tribunal", sale_procedure: saleProcedure }) as unknown as AuctionSale;

  it("links the listing for the offer, as before", () => {
    const { container } = render(
      <SaleProcedurePanel sale={sale(procedure([listing, document]))} />,
    );
    expect(screen.getByText(/Vérification Immojudis · 2 sources/)).toBeTruthy();
    expect(container.innerHTML).toContain(LISTING_URL);
    expect(screen.getAllByText("plateforme-privee").length).toBeGreaterThan(0);
  });

  it("keeps the document without the listing nor the source name once projected", () => {
    const { container } = render(
      <SaleProcedurePanel sale={saleWithoutListingSource(sale(procedure([listing, document])))} />,
    );
    expect(screen.getByText(/Vérification Immojudis · 1 source$/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Cahier des conditions de vente/ })).toBeTruthy();
    expect(container.innerHTML).not.toContain(LISTING_URL);
    expect(container.innerHTML).not.toContain("plateforme-privee");
  });

  it("shows no empty « Sources » block and no count when no source with a link is left", () => {
    render(<SaleProcedurePanel sale={saleWithoutListingSource(sale(procedure([listing])))} />);
    expect(screen.getByText("Vérification Immojudis")).toBeTruthy();
    expect(screen.queryByText(/0 source/)).toBeNull();
    expect(screen.queryByText("Sources contrôlées")).toBeNull();
    expect(screen.queryByText(/en cours de rattachement/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Plateforme privée/ })).toBeNull();
  });
});
