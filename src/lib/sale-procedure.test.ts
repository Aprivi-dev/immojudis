import { describe, expect, it } from "vitest";
import {
  getSaleProcedure,
  guaranteeLabel,
  lawyerRequirementLabel,
  overbidLabel,
  saleIsTribunalVenue,
  saleVerificationLabel,
  saleVenueLabel,
} from "@/lib/sale-procedure";
import type { AuctionSale } from "@/lib/types";

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-1",
    title: "Maison à Bordeaux",
    description: null,
    source_description: null,
    llm_display_description: null,
    about_description: null,
    city: "Bordeaux",
    department: "33",
    postal_code: "33000",
    address: "1 rue Exemple",
    tribunal: "TJ Bordeaux",
    tribunal_code: "bordeaux",
    tribunal_name: "TJ Bordeaux",
    tribunal_city: "Bordeaux",
    property_type: "house",
    starting_price_eur: 80_000,
    sale_date: "2026-09-15T09:00:00+02:00",
    visit_dates: [],
    lawyer_name: "Me Martin",
    lawyer_contact: null,
    adjudication_price_eur: null,
    latitude: 44.84,
    longitude: -0.58,
    occupancy_status: "vacant",
    habitable_surface_m2: 90,
    carrez_surface_m2: null,
    land_surface_m2: null,
    app_surface_m2: 90,
    app_surface_kind: "habitable",
    surface_scope: "total",
    surface_source: "listing",
    surface_confidence: 0.9,
    surface_evidence: null,
    rooms_count: 4,
    bedrooms_count: 3,
    bathrooms_count: 1,
    parking_count: 1,
    has_garden: true,
    has_terrace: false,
    has_garage: false,
    has_pool: false,
    has_air_conditioning: false,
    has_double_glazing: true,
    investment_score: null,
    investment_summary: null,
    score_version: null,
    score_confidence: null,
    score_factors: [],
    risk_notes: null,
    source_name: "avoventes",
    source_url: "https://avoventes.fr/vente/1",
    primary_source: "Avoventes",
    source_urls: [],
    source_blocks: null,
    source_blocks_by_source: null,
    dedupe_confidence: null,
    quality_flags: [],
    documents: [],
    documents_rich: [],
    media: [],
    risks: [],
    status: "upcoming",
    created_at: "2026-08-20T08:00:00Z",
    updated_at: "2026-08-20T08:00:00Z",
    ...overrides,
  };
}

describe("sale procedure presentation", () => {
  it("reads a verified procedure embedded in source blocks", () => {
    const procedure = getSaleProcedure(
      sale({
        source_blocks: {
          sale_procedure: {
            schema_version: "sale_procedure_v1",
            ruleset_version: "fr_auction_participation_2026-08-20",
            venue_type: "tribunal",
            legal_framework: "judicial_seizure",
            venue_name: "TJ Bordeaux",
            venue_address: "30 rue des Frères Bonie, Bordeaux",
            participation_mode: "in_person",
            organizer_name: "Me Martin",
            organizer_type: "pursuing_lawyer",
            organizer_contact: null,
            eligible_bar: "Barreau de Bordeaux",
            rules: {
              lawyer_required: true,
              lawyer_note: "Avocat du barreau compétent.",
              bid_method: "lawyer_mandate",
              guarantee: {
                amount_eur: 8000,
                rate_pct: 10,
                minimum_eur: 3000,
                status: "regulatory_verified",
                note: "Garantie légale minimale.",
              },
              financing_condition: false,
              cooling_off_period: false,
              payment_deadline_days: 60,
              overbid: {
                allowed: true,
                minimum_increase_pct: 10,
                window_days: 10,
                note: "Acte d'avocat.",
              },
            },
            verification: {
              status: "cross_checked",
              verified_at: "2026-08-20T09:30:00Z",
              case_source_count: 2,
              case_sources: [
                {
                  kind: "listing",
                  label: "Annonce",
                  source_name: "Avoventes",
                  url: "https://avoventes.fr/vente/1",
                },
              ],
              regulatory_sources: [],
              facts: [],
              issues: [],
            },
          },
        },
      }),
    );

    expect(procedure.venueType).toBe("tribunal");
    expect(procedure.verificationStatus).toBe("cross_checked");
    expect(lawyerRequirementLabel(procedure)).toBe("Avocat obligatoire pour enchérir");
    expect(guaranteeLabel(procedure)).toContain("8 000");
    expect(overbidLabel(procedure)).toBe("+10 % minimum · dans les 10 jours");
    expect(saleVerificationLabel(procedure.verificationStatus)).toBe("Recoupé");
  });

  it("keeps a legacy court-only inference visibly pending", () => {
    const procedure = getSaleProcedure(sale());

    expect(procedure.venueType).toBe("tribunal");
    expect(procedure.verificationStatus).toBe("pending");
    expect(saleVenueLabel(procedure.venueType)).toBe("Vente au tribunal");
    expect(lawyerRequirementLabel(procedure)).toBe("Représentation à confirmer");
    expect(procedure.issues).toContain("Qualification détaillée en cours de vérification.");
    expect(saleIsTribunalVenue(sale())).toBe(true);
  });

  it("does not expose tribunal activity on a confirmed notarial sale", () => {
    expect(
      saleIsTribunalVenue(
        sale({
          sale_venue_type: "notary",
          sale_verification_status: "verified",
          tribunal: null,
          tribunal_code: null,
          tribunal_name: null,
          tribunal_city: null,
          source_name: "notaires.fr",
        }),
      ),
    ).toBe(false);
  });
});
