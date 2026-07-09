import { describe, expect, it } from "vitest";
import { buildMapboxSaleFeatureCollection, formatMapboxMarkerPrice } from "@/lib/mapbox-sales";
import type { AuctionSale } from "@/lib/types";

describe("mapbox sale features", () => {
  it("builds GeoJSON markers only for geocoded sales", () => {
    const collection = buildMapboxSaleFeatureCollection([
      sale({
        id: "sale-geocoded",
        title: "Maison familiale - plafond recommandé 220 000 euros",
        property_type: "house",
        city: "Bordeaux",
        tribunal_city: "Bordeaux",
        tribunal_name: "TJ Bordeaux",
        sale_date: "2026-10-12",
        starting_price_eur: 180_000,
        latitude: 44.837789,
        longitude: -0.57918,
        source_blocks: { dpe_classe: "D" },
      }),
      sale({
        id: "sale-no-latitude",
        title: "Appartement non géocodé",
        longitude: 2.3522,
      }),
      sale({
        id: "sale-no-longitude",
        title: "Maison non géocodée",
        latitude: 48.8566,
      }),
    ]);

    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0]).toEqual({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [-0.57918, 44.837789],
      },
      properties: {
        saleId: "sale-geocoded",
        title: "Maison familiale",
        priceLabel: "180K€",
        markerColor: "#fde047",
        markerTextColor: "#422006",
        dpeClass: "D",
        city: "Bordeaux",
        tribunal: "Bordeaux",
        saleDate: "2026-10-12",
        priceValue: 180_000,
      },
    });
  });

  it("formats compact marker price labels", () => {
    expect(formatMapboxMarkerPrice(null)).toBe("Prix");
    expect(formatMapboxMarkerPrice(180_000)).toBe("180K€");
    expect(formatMapboxMarkerPrice(1_200_000)).toBe("1,2M€");
    expect(formatMapboxMarkerPrice(12_000_000)).toBe("12M€");
  });
});

function sale(overrides: Partial<AuctionSale>): AuctionSale {
  return {
    id: "sale",
    title: null,
    description: null,
    source_description: null,
    llm_display_description: null,
    about_description: null,
    city: null,
    department: null,
    postal_code: null,
    address: null,
    tribunal: null,
    tribunal_code: null,
    tribunal_name: null,
    tribunal_city: null,
    property_type: null,
    starting_price_eur: null,
    sale_date: null,
    visit_dates: null,
    lawyer_name: null,
    lawyer_contact: null,
    adjudication_price_eur: null,
    latitude: null,
    longitude: null,
    occupancy_status: null,
    habitable_surface_m2: null,
    carrez_surface_m2: null,
    land_surface_m2: null,
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
    source_name: null,
    source_url: null,
    primary_source: null,
    source_urls: null,
    source_blocks: null,
    source_blocks_by_source: null,
    dedupe_confidence: null,
    quality_flags: null,
    documents: null,
    documents_rich: null,
    media: null,
    risks: null,
    status: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}
