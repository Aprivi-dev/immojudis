// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { AuctionSale } from "@/lib/types";
import { ListingCharacteristics } from "./ListingCharacteristics";

afterEach(cleanup);

function sale(blocks: Record<string, unknown> | null): AuctionSale {
  return {
    id: "sale-1",
    source_name: "cessions_etat",
    sale_venue_type: "state",
    status: "upcoming",
    sale_date: null,
    source_blocks: blocks,
  } as unknown as AuctionSale;
}

const BLOCK = {
  nature: [{ label: "Terrains nus", code: "terrain_nu", display: "Terrain nu" }],
  items: [
    { key: "insee_code", label: "Code INSEE", value: "17990", group: "identification" },
    {
      key: "buildability",
      label: "Constructibilité",
      value: "non constructible",
      group: "urbanisme",
    },
  ],
  surfaces: { land_surface_m2: "16246" },
  media: { photos: 3 },
  attachments: [{ kind_label: "Cahier des charges" }],
  procedure: { pending: true, listing_end_estimate: "2026-11-27" },
  manager: {
    service: "PRIE99 - SERVICE DE GESTION DOMANIALE",
    email: "pole@dgfip.finances.gouv.fr",
  },
};

describe("ListingCharacteristics", () => {
  it("shows the nature, the pending procedure badge and the published tiles", () => {
    render(<ListingCharacteristics sale={sale({ caracteristiques_bien: BLOCK })} />);

    const section = screen.getByRole("region", { name: "Caractéristiques du bien" });
    const badges = within(section).getByRole("list", { name: "Nature et procédure" });
    expect(within(badges).getByText("Terrain nu")).toBeTruthy();
    expect(within(badges).getByText("Procédure à venir")).toBeTruthy();
    expect(within(section).getByText("16 246 m²")).toBeTruthy();
    expect(within(section).getByText("Code INSEE")).toBeTruthy();
    expect(within(section).getByText("non constructible")).toBeTruthy();
    expect(within(section).getByText("Cahier des charges")).toBeTruthy();
    const mail = within(section).getByRole("link", { name: "pole@dgfip.finances.gouv.fr" });
    expect(mail.getAttribute("href")).toBe("mailto:pole@dgfip.finances.gouv.fr");
  });

  it("presents a Licitor listing as a source listing, not an official record", () => {
    // Bloc fictif au format écrit par la pipeline pour Licitor.
    const licitor = {
      source: "licitor",
      nature: [{ label: "Un appartement", display: "Un appartement" }],
      groups: { identification: "Annonce et procédure", lots: "Lots mis en vente" },
      items: [
        {
          key: "sale_type",
          label: "Type de vente",
          value: "Vente aux enchères publiques sur saisie immobilière",
          group: "identification",
        },
        { key: "lot_2", label: "2ème lot", value: "Une cave — mise à prix 1 000 €", group: "lots" },
      ],
      surfaces: { built_surface_m2: "42.5" },
      attachments: [{ label: "PV descriptif", kind_label: "Procès-verbal descriptif" }],
      procedure: {
        method_label: "Saisie immobilière",
        prices: { starting_price_eur: 50000, deposit_eur: 5000 },
        visits: ["Visite sur place lundi 2 novembre 2026 de 10h à 11h"],
      },
      dates: { published_on: "2026-09-04" },
    };
    render(
      <ListingCharacteristics
        sale={{
          ...sale({ caracteristiques_bien: licitor }),
          source_name: "licitor",
          sale_venue_type: "tribunal",
        }}
      />,
    );

    const section = screen.getByRole("region", { name: "Caractéristiques du bien" });
    expect(
      within(section).getByText("Informations publiées sur l’annonce de la source"),
    ).toBeTruthy();
    expect(within(section).queryByText("Informations publiées sur la fiche officielle")).toBeNull();
    expect(within(section).getByText("Annonce de la source")).toBeTruthy();
    expect(within(section).getByText("Saisie immobilière")).toBeTruthy();
    expect(
      within(section).getByText("Visite sur place lundi 2 novembre 2026 de 10h à 11h"),
    ).toBeTruthy();
    expect(within(section).getByText("Procès-verbal descriptif")).toBeTruthy();
    expect(within(section).getByText("Une cave — mise à prix 1 000 €")).toBeTruthy();
  });

  it("renders nothing when the source publishes no characteristic", () => {
    const { container } = render(<ListingCharacteristics sale={sale(null)} />);
    expect(container.innerHTML).toBe("");
  });
});
