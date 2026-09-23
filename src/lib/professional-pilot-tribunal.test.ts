import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildTribunalPilot } from "@/lib/professional-pilot-tribunal";
import type { AuctionSale } from "@/lib/types";

const LISTING_URL = "https://avoventes.example/vente/123";
const CCV_URL = "https://avoventes.example/vente/123/ccv.pdf";
const PV_URL = "https://avoventes.example/vente/123/pv-descriptif.pdf";
const DIAGNOSTICS_URL = "https://avoventes.example/vente/123/diagnostics.pdf";

it("does not cite a jurisdiction reference as proof of sale-specific payment rules", () => {
  const pilot = buildTribunalPilot(EXAMPLE_SALE);
  const guarantee = pilot.facts.find((fact) => fact.label === "Consignation");
  expect(guarantee?.value).toBeNull();
  expect(guarantee?.sourceUrl).toBeNull();
});

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-tribunal-1",
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
    sale_venue_type: "tribunal",
    sale_legal_framework: "judicial_seizure",
    sale_verification_status: "cross_checked",
    sale_procedure: {
      schema_version: "sale_procedure_v1",
      ruleset_version: "fr_auction_participation_2026-08-20",
      venue_type: "tribunal",
      state_sale_method: "unknown",
      legal_framework: "judicial_seizure",
      venue_name: "TJ Bordeaux",
      venue_address: "30 rue des Frères Bonie, Bordeaux",
      participation_mode: "in_person",
      organizer_name: "Me Martin",
      organizer_type: "pursuing_lawyer",
      organizer_contact: "cabinet@example.test",
      eligible_bar: "Barreau de Bordeaux",
      rules: {
        lawyer_required: true,
        lawyer_note: "Avocat du barreau compétent.",
        bid_method: "lawyer_mandate",
        guarantee: {
          amount_eur: 8_000,
          rate_pct: 10,
          minimum_eur: 3_000,
          status: "regulatory_verified",
          note: "Garantie à confirmer dans les conditions de vente.",
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
        case_source_count: 1,
        case_sources: [{ kind: "listing", label: "Annonce", url: LISTING_URL }],
        regulatory_sources: [],
        facts: [
          {
            key: "competent_court",
            value: "TJ Bordeaux",
            status: "cross_checked",
            evidence: ["Le tribunal est indiqué dans l'avis."],
            source_url: LISTING_URL,
          },
        ],
        issues: [],
      },
    },
    property_type: "house",
    starting_price_eur: 80_000,
    sale_date: "2026-09-15T09:00:00+02:00",
    visit_dates: ["2026-09-04T14:00:00+02:00"],
    lawyer_name: "Me Martin",
    lawyer_contact: "cabinet@example.test",
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
    source_url: LISTING_URL,
    primary_source: "Avoventes",
    source_urls: [],
    source_blocks: null,
    source_blocks_by_source: null,
    dedupe_confidence: null,
    quality_flags: [],
    documents: [],
    documents_rich: [
      {
        url: CCV_URL,
        label: "Cahier des conditions de vente",
        type: "pdf",
        document_type: "cahier_conditions",
        extraction_status: "complete",
      },
      {
        url: PV_URL,
        label: "PV descriptif de l'huissier",
        type: "pdf",
        document_type: "pv_descriptif",
        extraction_status: "complete",
      },
      {
        url: DIAGNOSTICS_URL,
        label: "Diagnostics immobiliers",
        type: "pdf",
        document_type: "diagnostics",
        extraction_status: "complete",
      },
    ],
    media: [],
    risks: [
      {
        risk_type: "occupation",
        risk_label: "Occupation à vérifier",
        severity: 2,
        evidence: "Le PV mentionne l'occupation des lieux.",
        occurrences: [
          {
            document_url: PV_URL,
            document_label: "PV descriptif de l'huissier",
            document_type: "pv_descriptif",
            page_number: 2,
            excerpt: "Les lieux sont libres.",
            confidence: 0.9,
          },
        ],
      },
    ],
    status: "upcoming",
    created_at: "2026-08-20T08:00:00Z",
    updated_at: "2026-08-20T08:00:00Z",
    ...overrides,
  };
}

function fact(definition: ReturnType<typeof buildTribunalPilot>, label: string) {
  return definition.facts.find((item) => item.label === label);
}

describe("tribunal professional pilot", () => {
  it("builds a source-backed lawyer preparation brief", () => {
    const definition = buildTribunalPilot(sale());

    expect(definition.kind).toBe("tribunal");
    expect(definition.title).toContain("audience");
    expect(definition.packetLabel).toContain("avocat");
    expect(definition.counterparty).toBe("Me Martin");
    expect(fact(definition, "Tribunal compétent")).toMatchObject({
      value: "TJ Bordeaux",
      sourceUrl: LISTING_URL,
    });
    expect(fact(definition, "Avocat / représentation")).toMatchObject({
      value: "Avocat obligatoire pour enchérir",
      detail: expect.stringContaining("Barreau de Bordeaux"),
    });
    expect(fact(definition, "Consignation")?.value).toContain("8");
    expect(fact(definition, "Délai de paiement")?.value).toContain("2 mois");
    expect(fact(definition, "Surenchère")?.value).toContain("10");
    expect(fact(definition, "Occupation")).toMatchObject({ value: "Libre", sourceUrl: PV_URL });
    expect(definition.milestones).toEqual([
      {
        label: "Audience d'adjudication",
        date: "2026-09-15T09:00:00+02:00",
        sourceUrl: LISTING_URL,
      },
      {
        label: "Créneau de visite publié",
        date: "2026-09-04T14:00:00+02:00",
        sourceUrl: LISTING_URL,
      },
    ]);
    expect(definition.checks.map((item) => item.id)).toEqual([
      "tribunal_assignment",
      "conditions_review",
      "descriptive_report_review",
      "occupation_confirmation",
      "consignation_confirmation",
      "diagnostics_review",
      "financing_confirmation",
      "lawyer_brief",
      "last_document_check",
    ]);
    expect(definition.checks.find((item) => item.id === "conditions_review")?.sourceUrl).toBe(
      CCV_URL,
    );

    const sourceUrls = [
      ...definition.facts.map((item) => item.sourceUrl),
      ...definition.milestones.map((item) => item.sourceUrl),
      ...definition.checks.map((item) => item.sourceUrl),
    ].filter((value): value is string => Boolean(value));
    expect(sourceUrls.every((value) => /^https?:\/\//.test(value))).toBe(true);
  });

  it("keeps procedure-specific claims unknown while qualification is pending", () => {
    const definition = buildTribunalPilot(
      sale({
        sale_procedure: null,
        sale_verification_status: "pending",
      }),
    );

    expect(fact(definition, "Type de vente")?.value).toBeNull();
    expect(fact(definition, "Tribunal compétent")?.value).toBeNull();
    expect(fact(definition, "Cadre juridique")?.value).toBeNull();
    expect(fact(definition, "Avocat / représentation")?.value).toBeNull();
    expect(fact(definition, "Consignation")?.value).toBeNull();
    expect(fact(definition, "Délai de paiement")?.value).toBeNull();
    expect(fact(definition, "Surenchère")?.value).toBeNull();
    expect(fact(definition, "Mode de participation")?.value).toBeNull();
    expect(fact(definition, "Mise à prix publiée")?.value).toContain("80");
    expect(fact(definition, "Occupation")?.value).toBe("Libre");
    expect(definition.counterparty).toBeNull();
  });

  it("does not retain unsafe links or expose untraceable values", () => {
    const definition = buildTribunalPilot(
      sale({
        source_url: "javascript:alert(1)",
        documents_rich: [
          {
            url: "javascript:alert(1)",
            label: "Cahier des conditions de vente",
            type: "pdf",
            document_type: "cahier_conditions",
            extraction_status: "complete",
          },
        ],
        risks: [],
        sale_procedure: {
          ...sale().sale_procedure,
          verification: {
            ...(sale().sale_procedure as { verification: Record<string, unknown> }).verification,
            case_sources: [{ kind: "listing", url: "javascript:alert(1)" }],
            facts: [
              {
                key: "competent_court",
                value: "TJ Bordeaux",
                status: "cross_checked",
                evidence: [],
                source_url: "javascript:alert(1)",
              },
            ],
          },
        },
      }),
    );

    expect(definition.counterparty).toBeNull();
    expect(definition.facts.every((item) => item.value === null && item.sourceUrl == null)).toBe(
      true,
    );
    expect(
      definition.milestones.every((item) => item.date === null && item.sourceUrl == null),
    ).toBe(true);
    expect(definition.checks.every((item) => item.sourceUrl == null)).toBe(true);
  });

  it("rejects a non-tribunal sale", () => {
    expect(() =>
      buildTribunalPilot(
        sale({
          sale_venue_type: "notary",
          sale_verification_status: "verified",
          sale_procedure: null,
          tribunal: null,
          tribunal_name: null,
          tribunal_code: null,
          tribunal_city: null,
        }),
      ),
    ).toThrow("pilote tribunal");
  });
});
