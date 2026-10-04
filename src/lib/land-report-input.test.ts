import { describe, expect, it } from "vitest";
import { landLocationInputFromSale } from "./land-report-input";
import type { AuctionSale } from "./types";

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-test",
    title: null,
    description: null,
    source_description: null,
    llm_display_description: null,
    about_description: null,
    city: "Saint-Quentin",
    department: "02",
    postal_code: "02100",
    address: "17 rue Roland Garros, 02100 Saint-Quentin",
    tribunal: null,
    tribunal_code: null,
    tribunal_name: null,
    tribunal_city: null,
    sale_venue_type: "tribunal",
    sale_legal_framework: "judicial_seizure",
    sale_verification_status: "verified",
    sale_procedure: null,
    property_type: "Maison",
    starting_price_eur: 50_000,
    sale_date: "2026-10-14T00:00:00Z",
    visit_dates: [],
    lawyer_name: null,
    lawyer_contact: null,
    adjudication_price_eur: null,
    latitude: 49.84,
    longitude: 3.28,
    occupancy_status: null,
    habitable_surface_m2: 100,
    carrez_surface_m2: null,
    land_surface_m2: 698,
    app_surface_m2: null,
    app_surface_kind: null,
    surface_scope: null,
    surface_source: null,
    surface_confidence: null,
    surface_evidence: null,
    rooms_count: null,
    bedrooms_count: null,
    bathrooms_count: null,
    parking_count: null,
    has_garden: null,
    has_terrace: null,
    has_garage: null,
    has_pool: null,
    has_air_conditioning: null,
    has_double_glazing: null,
    investment_score: null,
    investment_summary: null,
    score_version: null,
    score_confidence: null,
    score_factors: null,
    risk_notes: null,
    source_name: "petites_affiches",
    source_url: "https://example.test/sale-test",
    primary_source: "https://example.test/sale-test",
    source_urls: [],
    source_blocks: null,
    source_blocks_by_source: null,
    dedupe_confidence: null,
    quality_flags: null,
    documents: null,
    documents_rich: [],
    media: [],
    risks: [],
    status: "active",
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe("land report input", () => {
  it("takes cadastral references from source text and ignores the AI display summary", () => {
    const input = landLocationInputFromSale(
      sale({
        source_description:
          "Description publiée : maison édifiée sur la parcelle cadastrée section CT n° 190.",
        llm_display_description:
          "Résumé automatique : la parcelle serait la section ZZ n° 999, à confirmer.",
      }),
    );

    expect(input.references ?? []).toEqual([
      expect.objectContaining({
        section: "CT",
        number: "190",
        source: "listing",
      }),
    ]);
    expect(input.references?.some((reference) => reference.section === "ZZ")).toBe(false);
  });

  it("does not promote a point-only cadastral candidate to a sold reference", () => {
    const input = landLocationInputFromSale(sale(), [
      {
        parcelKey: "02691-CT-0190",
        parcelId: "02691000CT0190",
        codeInsee: "02691",
        department: "02",
        city: "Saint-Quentin",
        section: "CT",
        parcelNumber: "0190",
        surfaceM2: 698,
        centroidLat: 49.84,
        centroidLng: 3.28,
        matchKind: "address_point",
        confidence: 0.91,
        sourceApi: "API Carto Cadastre",
      },
    ]);

    expect(input.codeInsee).toBeNull();
    expect(input.references ?? []).toHaveLength(0);
    expect(input.coordinates).toEqual({ latitude: 49.84, longitude: 3.28 });
  });
});
