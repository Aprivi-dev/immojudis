// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import type { AuctionSale, SaleVenueType } from "@/lib/types";
import { publicSaleVenueCopy, SalePublicPreview } from "./SalePublicPreview";

afterEach(cleanup);

describe("SalePublicPreview", () => {
  it("keeps the requested section and search return in the login destination", () => {
    render(
      <SalePublicPreview
        saleId="sale-1"
        preview={{ id: "sale-1" } as AuctionSale}
        returnTo="/sales?city=Toulouse"
        requestedHash="#proofs"
      />,
    );
    const href = screen
      .getByRole("link", { name: /Créer mon compte gratuit/ })
      .getAttribute("href")!;
    expect(new URL(href, "https://example.test").searchParams.get("redirect")).toBe(
      "/sales/sale-1?from=%2Fsales%3Fcity%3DToulouse#proofs",
    );
  });

  it("announces the statistics of the tribunal in the unlock only while their flag is open", () => {
    const tribunal = { id: "sale-1", sale_venue_type: "tribunal" } as AuctionSale;
    const closed = render(
      <SalePublicPreview saleId="sale-1" preview={tribunal} returnTo="/sales" />,
    );
    const intro = (view: typeof closed) =>
      view.container.querySelector("#public-access-title")?.parentElement?.textContent ?? "";
    expect(intro(closed)).toContain("débloquer 3 ventes par mois");
    expect(intro(closed)).toContain("l’enchère plafond, la lecture des pièces");
    expect(intro(closed)).not.toContain("statistiques du tribunal");
    closed.unmount();

    const open = render(
      <SalePublicPreview
        saleId="sale-1"
        preview={tribunal}
        returnTo="/sales"
        adjudicationStatisticsEnabled
      />,
    );
    expect(intro(open)).toContain("les statistiques du tribunal");
  });

  it.each([
    ["tribunal", "Bien immobilier vendu au tribunal"],
    ["notary", "Bien immobilier vendu chez le notaire"],
    ["state", "Bien immobilier vendu par l’État"],
    ["online", "Bien immobilier vendu aux enchères"],
    ["unknown", "Bien immobilier vendu aux enchères"],
  ] satisfies Array<[SaleVenueType, string]>)(
    "explains the %s venue with a dedicated public title",
    (venueType, title) => {
      expect(publicSaleVenueCopy(venueType).title).toBe(title);
      expect(publicSaleVenueCopy(venueType).explanation.length).toBeGreaterThan(70);
    },
  );

  it("makes a notarial sale explicit without leaking protected listing data", () => {
    const { container } = renderPreview({
      sale_venue_type: "notary",
      sale_verification_status: "cross_checked",
      lawyer_contact: "confidential@example.test",
    });

    expect(screen.getByText("Bien immobilier vendu chez le notaire")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "vente chez le notaire",
    );
    expect(screen.getAllByText("Vente notariale").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Modalités à consulter dans le dossier")).toBeTruthy();
    expect(screen.getByText("Un seul catalogue, plusieurs procédures")).toBeTruthy();
    expect(container.textContent).toContain(
      "ventes immobilières au tribunal, chez le notaire et les ventes domaniales",
    );
    expect(container.textContent).not.toContain("confidential@example.test");
    expect(container.textContent).not.toContain("enchère plafond");
    expect(screen.queryByText(/Activité publique du tribunal/)).toBeNull();

    const cta = screen.getByRole("link", { name: /Créer mon compte gratuit/ });
    expect(cta.getAttribute("href")).toContain("mode=investor");
    expect(cta.getAttribute("href")).toContain(encodeURIComponent("/sales/sale-1?from=%2Fsales"));
  });

  it("keeps court-specific guidance without exposing court statistics in the public teaser", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      tribunal_code: "tj-bordeaux",
      tribunal_name: "Tribunal judiciaire de Bordeaux",
    });

    expect(screen.getByText("Avocat obligatoire pour enchérir")).toBeTruthy();
    expect(screen.getByText(/audience d’adjudication/)).toBeTruthy();
    expect(screen.queryByText(/Activité publique du tribunal/)).toBeNull();
  });

  it("shows the domanial method before price and avoids promising auctions", () => {
    const { container } = renderPreview({
      sale_venue_type: "state",
      sale_verification_status: "cross_checked",
      starting_price_eur: null,
    });
    expect(screen.getByText("Mode de cession")).toBeTruthy();
    expect(screen.getByText(/Prix non publié/)).toBeTruthy();
    expect(container.textContent).not.toContain("estimation de votre enchère plafond");
    expect(container.textContent).not.toContain("L'inscription et les enchères");
  });

  it("gives each sale its own heading, built from the facts of the sale", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      property_type: "apartment",
      app_surface_m2: 50,
      city: "Romainville",
      department: "93",
      sale_date: "2026-10-20T09:00:00+02:00",
      tribunal: "TJ Bobigny",
    });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toContain(
      "Appartement 50 m² à Romainville (93) – vente au tribunal le 20 octobre 2026",
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("never gives two different sales the same heading", () => {
    const facts = {
      sale_venue_type: "tribunal",
      property_type: "apartment",
      app_surface_m2: 50,
      city: "Romainville",
      department: "93",
      sale_date: "2026-10-20T09:00:00+02:00",
    } as const;
    const first = renderPreview({ ...facts, id: "005a914d-563c-427b-88a4-740cbf851afb" });
    const firstHeading = screen.getByRole("heading", { level: 1 }).textContent;
    first.unmount();
    renderPreview(
      { ...facts, id: "7c1e22ab-563c-427b-88a4-740cbf851afb" },
      "7c1e22ab-563c-427b-88a4-740cbf851afb",
    );
    const secondHeading = screen.getByRole("heading", { level: 1 }).textContent;
    expect(firstHeading).not.toBe(secondHeading);
  });

  it("shows what the catalogue card shows, without an account", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      property_type: "house",
      app_surface_m2: 92,
      rooms_count: 4,
      city: "Pau",
      department: "64",
      sale_date: "2026-10-20T07:30:00Z",
      tribunal: "TJ Pau",
      media: [{ type: "image", url: "https://example.test/property-photo.jpg" }],
    });
    const facts = screen.getByText("Type de bien").closest("dl")!;
    expect(facts.textContent).toContain("Maison");
    expect(facts.textContent).toContain("92 m²");
    expect(facts.textContent).toContain("4");
    expect(facts.textContent).toContain("Pau · 64");
    expect(facts.textContent).toContain("20 octobre 2026 à 9 h 30");
    expect(facts.textContent).toContain("Tribunal judiciaire de Pau");
    expect(screen.getByRole("img", { name: /Photo du bien/ })).toBeTruthy();
  });

  it("leaves out what is unknown and never prints a midnight time", () => {
    renderPreview({
      property_type: "land",
      app_surface_m2: null,
      rooms_count: null,
      sale_date: "2026-10-23T00:00:00+00:00",
    });
    const facts = screen.getByText("Type de bien").closest("dl")!;
    expect(facts.textContent).not.toContain("Surface");
    expect(facts.textContent).not.toContain("Pièces");
    expect(facts.textContent).toContain("23 octobre 2026");
    expect(facts.textContent).not.toMatch(/\d h \d{2}/);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("lists what the free account adds instead of a vague protection notice", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      sale_verification_status: "verified",
      photo_count: 5,
      has_visit_dates: true,
      document_count: 3,
    });
    expect(screen.queryByText(/protège les informations/)).toBeNull();
    const list = screen.getByText("Avec le compte gratuit, vous voyez aussi").parentElement!;
    expect(list.textContent).toContain("5 photos du bien");
    expect(list.textContent).toContain("dates et le lieu des visites");
    expect(list.textContent).toContain("3 pièces au dossier");
  });

  it("describes the property from its facts and teases the analysis without figures", () => {
    renderPreview({
      sale_venue_type: "tribunal",
      property_type: "house",
      app_surface_m2: 92,
      land_surface_m2: 640,
      city: "Pau",
      department: "64",
      has_garden: true,
    });
    const description = screen.getByRole("region", { name: "Le bien en bref" });
    expect(description.textContent).toContain(
      "Maison de 92 m², sur un terrain de 640 m², à Pau (64).",
    );
    expect(description.textContent).toContain("Jardin");
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.textContent).toContain("Enchère plafond conseillée");
    expect(teaser.textContent).toContain("000 000 €");
    expect(teaser.textContent).not.toMatch(/[1-9]\d* ?\d* €/);
  });

  it("does not promise a bid ceiling for a notarial sale", () => {
    renderPreview({ sale_venue_type: "notary" });
    const teaser = screen.getByRole("region", { name: "L’analyse de cette vente" });
    expect(teaser.textContent).not.toContain("plafond");
    expect(teaser.textContent).toContain("Ventes comparables");
  });

  it("has no structural accessibility violations", async () => {
    const { container } = renderPreview({
      sale_venue_type: "state",
      sale_verification_status: "verified",
    });
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});

function renderPreview(overrides: Partial<AuctionSale> = {}, saleId = "sale-1") {
  return render(
    <SalePublicPreview
      saleId={saleId}
      returnTo="/sales"
      preview={
        {
          id: "sale-1",
          starting_price_eur: 59_000,
          sale_venue_type: "notary",
          sale_verification_status: "cross_checked",
          ...overrides,
        } as AuctionSale
      }
    />,
  );
}
