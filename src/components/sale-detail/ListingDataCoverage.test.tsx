// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import {
  getFactReliability,
  getFactReliabilityForDisplay,
  getKeyFactReliabilities,
} from "@/lib/fact-reliability";
import type { PublicListingInformation } from "@/lib/listing-public-information";
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

function publicInformation(): PublicListingInformation {
  const items = [
    {
      id: "rooms_count",
      label: "Chambres",
      value: "3 chambres",
      status: "sourced" as const,
      explanation: "Information rattachée à la source indiquée.",
      sources: [
        {
          label: "PV descriptif",
          url: "https://example.test/pv.pdf",
          excerpt: "Le logement comprend trois chambres.",
          page: 4,
          capturedAt: "2026-09-12T10:00:00Z",
          kind: "document" as const,
        },
      ],
    },
    {
      id: "surface",
      label: "Surface habitable",
      value: "86 m²",
      status: "estimated" as const,
      explanation: "Valeur estimée à partir des informations disponibles.",
      sources: [],
    },
    {
      id: "occupancy_status",
      label: "Occupation",
      value: null,
      status: "reported" as const,
      explanation: "Cette information reste à confirmer avant de pouvoir être affichée.",
      sources: [],
    },
    {
      id: "heating_mode",
      label: "Chauffage",
      value: "Électrique",
      status: "reported" as const,
      explanation: "Information disponible, source à préciser.",
      sources: [],
    },
    {
      id: "dpe_class",
      label: "Classe DPE",
      value: null,
      status: "missing" as const,
      explanation: "La classe DPE n'est pas renseignée à ce jour.",
      sources: [],
    },
    {
      id: "address",
      label: "Adresse",
      value: "86 rue des Tests",
      status: "conflict" as const,
      explanation: "Des sources indiquent des valeurs différentes.",
      sources: [
        {
          label: "Annonce",
          url: "javascript:alert(1)",
          excerpt: "86 rue des Tests",
          page: null,
          capturedAt: null,
          kind: "listing" as const,
        },
        {
          label: "Document",
          url: "https://example.test/document.pdf",
          excerpt: "86 avenue des Tests",
          page: 2,
          capturedAt: null,
          kind: "document" as const,
        },
      ],
    },
  ];

  return {
    sections: [
      {
        id: "property",
        title: "Le bien",
        items: items.slice(0, 3),
      },
      {
        id: "energy",
        title: "Énergie",
        items: items.slice(3),
      },
    ],
    items,
    total: items.length,
    sourcedCount: 1,
    missingCount: 1,
    toConfirmCount: 4,
    priorityItems: items.slice(2),
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

  it("renders public information by theme without exposing collection metadata", async () => {
    const { container } = render(
      <ListingDataCoverage sale={sale()} publicInformation={publicInformation()} />,
    );

    const details = container.querySelectorAll("details");
    expect(details).toHaveLength(2);
    expect(details[0]?.open).toBe(true);
    expect(details[1]?.open).toBe(false);
    expect(screen.getByText("3 chambres")).toBeTruthy();
    expect(screen.getByText("PV descriptif · p.4")).toBeTruthy();
    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(screen.getAllByText("Source à préciser")).toHaveLength(2);
    expect(screen.getByText("Estimation")).toBeTruthy();
    expect(screen.getByText("Information manquante")).toBeTruthy();
    expect(screen.getByText("Sources à départager")).toBeTruthy();
    expect(screen.queryByText("rooms_count")).toBeNull();
    expect(screen.queryByText("130 critères")).toBeNull();
    expect(screen.queryByText("indice pondéré")).toBeNull();

    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });

  it("uses the public information model as an autonomous fallback", () => {
    render(<ListingDataCoverage sale={sale()} />);

    expect(screen.getByText("Le bien")).toBeTruthy();
    expect(screen.queryByText("130 critères")).toBeNull();
    expect(screen.queryByText("Synthèse de la collecte")).toBeNull();
  });

  it("opens source details for keyboard users and restores focus after closing", async () => {
    render(<ListingDataCoverage sale={sale()} publicInformation={publicInformation()} />);

    const sourceButton = screen.getByRole("button", { name: "Voir la source de Chambres" });
    sourceButton.focus();
    expect(document.activeElement).toBe(sourceButton);
    fireEvent.click(sourceButton);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chambres" })).toBeTruthy();
    expect(screen.getByText("Le logement comprend trois chambres.")).toBeTruthy();
    expect(screen.getByText("p. 4")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Ouvrir la source/ }).getAttribute("href")).toBe(
      "https://example.test/pv.pdf",
    );

    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(sourceButton));
  });

  it("explains reported information without inventing a source link", () => {
    render(<ListingDataCoverage sale={sale()} publicInformation={publicInformation()} />);

    const explainButton = screen.getByRole("button", {
      name: "Source à préciser pour Occupation",
    });
    fireEvent.click(explainButton);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByText("Cette information reste à confirmer avant de pouvoir être affichée."),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Ouvrir la source/ })).toBeNull();
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
});
