// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { getListingDataCoverage, ListingDataCoverage } from "./ListingDataCoverage";

afterEach(cleanup);

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    documents: [{ url: "https://example.test/cahier.pdf", name: "Cahier des charges" }],
    documents_rich: [],
    source_name: "Source officielle",
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

    expect(coverage.percentage).toBe(91);
    expect(coverage.presentCount).toBe(10);
    expect(coverage.missing).toEqual([
      expect.objectContaining({ key: "surface", label: "Surface publiée" }),
    ]);
  });

  it("keeps missing fields explicit when the source has no usable values", () => {
    const coverage = getListingDataCoverage(
      sale({
        title: null,
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
      "price",
      "schedule",
      "visits",
      "organizer",
      "participation",
      "documents",
      "source",
    ]);
  });

  it("keeps the summary compact and reveals both lists on demand", async () => {
    const { container } = render(<ListingDataCoverage sale={sale()} />);

    expect(screen.getByRole("heading", { name: "Couverture des informations" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("Mesure détaillée · 130 critères")).toBeTruthy();
    expect(screen.getByText(/Le score mesure les informations reçues/)).toBeTruthy();
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(screen.getByText("Voir les détails")).toBeTruthy();
    fireEvent.click(screen.getByText("Voir les détails"));
    expect(details?.open).toBe(true);
    expect(screen.getByText("Informations présentes (11)")).toBeTruthy();
    expect(screen.getByText("Informations manquantes (0)")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});
