// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import {
  getFactReliability,
  getFactReliabilityForDisplay,
  getKeyFactReliabilities,
} from "@/lib/fact-reliability";
import type { AuctionSale } from "@/lib/types";
import { getListingDataCoverage, ListingDataCoverage } from "./ListingDataCoverage";

afterEach(cleanup);

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    documents: [{ url: "https://example.test/cahier.pdf", name: "Cahier des charges" }],
    documents_rich: [],
    source_name: "Source officielle",
    occupancy_status: "vacant",
    source_url: "https://example.test/annonce",
    source_urls: [],
    ...overrides,
  };
}

describe("getListingDataCoverage", () => {
  it("reports the visible checklist without treating an inferred surface as published", () => {
    const coverage = getListingDataCoverage(
      sale({
        app_surface_m2: null,
        habitable_surface_m2: null,
        carrez_surface_m2: null,
        land_surface_m2: null,
        rooms_count: 1,
        property_type: "apartment",
      }),
    );

    expect(coverage.percentage).toBe(92);
    expect(coverage.presentCount).toBe(11);
    expect(coverage.missing).toEqual([
      expect.objectContaining({ key: "surface", label: "Surface publiée" }),
    ]);
  });

  it("keeps unknown occupation and unverified critical values actionable", () => {
    const coverage = getListingDataCoverage(sale({ occupancy_status: "unknown" }));
    expect(coverage.missing.map((item) => item.key)).toContain("occupation");
    expect(coverage.toConfirm.map((item) => item.key)).toContain("price");
    expect(coverage.toConfirm.map((item) => item.key)).not.toContain("occupation");
    expect(coverage.percentage).toBeLessThan(100);
  });

  it("keeps missing fields explicit when the source has no usable values", () => {
    const coverage = getListingDataCoverage(
      sale({
        title: null,
        occupancy_status: "unknown",
        description: null,
        source_description: null,
        llm_display_description: null,
        about_description: null,
        city: null,
        department: null,
        postal_code: null,
        address: null,
        property_type: "unknown",
        starting_price_eur: null,
        sale_date: null,
        visit_dates: [],
        sale_venue_type: "unknown",
        sale_verification_status: "pending",
        sale_procedure: null,
        source_blocks: null,
        lawyer_name: null,
        lawyer_contact: null,
        app_surface_m2: null,
        habitable_surface_m2: null,
        carrez_surface_m2: null,
        land_surface_m2: null,
        documents: [],
        documents_rich: [],
        source_name: null,
        primary_source: null,
        source_url: null,
        source_urls: [],
      }),
    );

    expect(coverage.presentCount).toBe(0);
    expect(coverage.missingCount).toBe(coverage.total);
    expect(coverage.missing.map((item) => item.key)).toEqual([
      "propertyType",
      "description",
      "location",
      "surface",
      "occupation",
      "price",
      "schedule",
      "visits",
      "organizer",
      "participation",
      "documents",
      "source",
    ]);
  });

  it("keeps the summary compact and reveals the exhaustive detail on demand", async () => {
    const { container } = render(<ListingDataCoverage sale={sale()} />);

    expect(container.querySelectorAll("details")).toHaveLength(1);
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(screen.getByText("Voir le détail des informations et de leur origine")).toBeTruthy();
    expect(screen.getByText("12/12 champs clés")).toBeTruthy();

    fireEvent.click(screen.getByText("Voir le détail des informations et de leur origine"));
    expect(details?.open).toBe(true);
    expect(screen.getByRole("heading", { name: "Synthèse de la collecte" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Origine des informations" })).toBeTruthy();
    expect(screen.getByText("Données collectées · source non rattachée")).toBeTruthy();
    expect(screen.getByText(/critères applicables/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Champs clés" })).toBeTruthy();
    expect(screen.getByText("12/12 présents")).toBeTruthy();
    expect(screen.getByText("Documenté")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "130 critères du dossier" })).toBeTruthy();
    expect(screen.queryByText("property_type")).toBeNull();
    expect(screen.queryByText("surface_habitable_m2")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Vérification et réserves" })).toBeTruthy();

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });

  it("keeps a masked key fact missing even when the API fact was observed", () => {
    const sourceSale = sale({ starting_price_eur: 92_000 });
    const facts = getKeyFactReliabilities(sourceSale);
    facts.starting_price_eur = getFactReliability(
      sale({
        starting_price_eur: 92_000,
        source_checks: { starting_price_eur: { checked_at: "2026-09-12T10:00:00Z" } },
      }),
      "starting_price_eur",
    );
    const maskedSale = sale({ starting_price_eur: null });
    const coverage = getListingDataCoverage(maskedSale, facts);

    expect(coverage.keyFacts.find((fact) => fact.key === "price")?.presentation).toMatchObject({
      kind: "missing",
      label: "Non renseigné",
    });
    expect(getFactReliabilityForDisplay(maskedSale, "starting_price_eur", null, facts).status).toBe(
      "observed",
    );
  });

  it("renders both structured lawyer contact channels without exposing metadata", () => {
    render(
      <ListingDataCoverage
        sale={sale({
          lawyer_contact: {
            phone: "01 23 45 67 89",
            email: "contact@example.fr",
            source: "internal-metadata",
          } as unknown as AuctionSale["lawyer_contact"],
        })}
      />,
    );

    fireEvent.click(screen.getByText("Voir le détail des informations et de leur origine"));
    expect(
      screen.getByText("Téléphone : 01 23 45 67 89 · Email : contact@example.fr"),
    ).toBeTruthy();
    expect(screen.queryByText("internal-metadata")).toBeNull();
  });
});
