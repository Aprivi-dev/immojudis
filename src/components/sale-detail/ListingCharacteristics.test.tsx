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

  it("presents restricted notarial documents without a link to downloadable pieces", () => {
    render(
      <ListingCharacteristics
        sale={sale({
          caracteristiques_bien: {
            ...BLOCK,
            attachments: [{ kind_label: "Diagnostic amiante" }],
            attachments_access: { restricted: true, note: "Accès après agrément de l’office." },
            manager: { service: "Office fictif", heading: "Office notarial" },
          },
        })}
      />,
    );

    const section = screen.getByRole("region", { name: "Caractéristiques du bien" });
    expect(within(section).getByText("Pièces du dossier (accès réservé)")).toBeTruthy();
    expect(within(section).getByText("Accès après agrément de l’office.")).toBeTruthy();
    expect(within(section).queryByRole("link", { name: "Consulter les pièces" })).toBeNull();
    expect(within(section).getByText("Office notarial")).toBeTruthy();
  });

  it("renders nothing when the source publishes no characteristic", () => {
    const { container } = render(<ListingCharacteristics sale={sale(null)} />);
    expect(container.innerHTML).toBe("");
  });
});
