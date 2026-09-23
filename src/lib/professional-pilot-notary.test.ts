import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildNotaryPilot } from "@/lib/professional-pilot-notary";
import type { AuctionSale } from "@/lib/types";

const sourceUrl = "https://www.immobilier.notaires.fr/fr/annonce-immo/test";

function procedure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "sale_procedure_v1",
    ruleset_version: "fr_auction_participation_2026-08-20",
    venue_type: "notary",
    state_sale_method: "unknown",
    legal_framework: "voluntary_notarial",
    venue_name: "Office notarial de Bordeaux",
    venue_address: null,
    participation_mode: "online",
    organizer_name: "Me Alice Martin",
    organizer_type: "notary",
    organizer_contact: null,
    eligible_bar: null,
    rules: {
      lawyer_required: false,
      lawyer_note: "Modalités propres à la vente.",
      bid_method: "direct_or_sale_specific",
      guarantee: {
        amount_eur: null,
        rate_pct: null,
        minimum_eur: null,
        status: "pending_case_document",
        note: "À confirmer.",
      },
      financing_condition: null,
      cooling_off_period: null,
      payment_deadline_days: null,
      overbid: {
        allowed: null,
        minimum_increase_pct: null,
        window_days: null,
        note: "À confirmer.",
      },
    },
    verification: {
      status: "cross_checked",
      verified_at: "2026-09-20T09:00:00Z",
      case_source_count: 1,
      case_sources: [
        {
          kind: "listing",
          label: "Annonce notariale",
          source_name: "Notaires de France",
          url: sourceUrl,
        },
      ],
      regulatory_sources: [],
      facts: [],
      issues: [],
    },
    sale_window: {
      opens_at: "2026-10-16T10:00:00+02:00",
      closes_at: "2026-10-17T10:00:00+02:00",
    },
    ...overrides,
  };
}

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: "notary-sale-1",
    source_name: "notaires",
    source_url: sourceUrl,
    primary_source: "Immobilier.notaires",
    sale_venue_type: "notary",
    sale_legal_framework: "voluntary_notarial",
    sale_verification_status: "cross_checked",
    tribunal: null,
    tribunal_code: null,
    tribunal_name: null,
    tribunal_city: null,
    lawyer_name: "Me Alice Martin",
    sale_date: "2026-10-17T10:00:00+02:00",
    starting_price_eur: 180_000,
    property_type: "apartment",
    occupancy_status: "unknown",
    source_blocks: {
      type_transaction: "VNI",
      consignation: "10 000 €",
      seance_paiement: "Solde selon les conditions de la vente",
    },
    documents: [
      {
        url: "https://www.immobilier.notaires.fr/docs/cahier.pdf",
        name: "Cahier des charges",
        type: "pdf",
      },
      {
        url: "https://www.immobilier.notaires.fr/docs/dpe.pdf",
        name: "Diagnostic DPE",
        type: "pdf",
      },
    ],
    documents_rich: [
      {
        url: "https://www.immobilier.notaires.fr/docs/cahier.pdf",
        label: "Cahier des charges",
        type: "pdf",
        document_type: "cahier_conditions_vente",
        extraction_status: "complete",
      },
      {
        url: "https://www.immobilier.notaires.fr/docs/dpe.pdf",
        label: "Diagnostic DPE",
        type: "pdf",
        document_type: "diagnostics_techniques",
        extraction_status: "complete",
      },
    ],
    sale_procedure: procedure(),
    ...overrides,
  };
}

function fact(definition: ReturnType<typeof buildNotaryPilot>, label: string) {
  return definition.facts.find((item) => item.label === label);
}

describe("notarial professional pilot", () => {
  it("builds an interactive notarial decision brief with its online window", () => {
    const definition = buildNotaryPilot(sale());

    expect(definition.kind).toBe("notary");
    expect(fact(definition, "Type d'opération")?.value).toBe("Vente notariale interactive");
    expect(fact(definition, "Office notarial")?.value).toBe("Me Alice Martin");
    expect(fact(definition, "Consignation")?.value).toContain("10");
    expect(fact(definition, "Conditions de paiement")?.value).toContain("Solde");
    expect(definition.milestones[0]).toMatchObject({
      label: "Fenêtre d'enchères notariales en ligne",
      sourceUrl,
    });
    expect(definition.milestones[0]?.date).toContain("16 octobre 2026");
    expect(definition.checks.map((check) => check.id)).toEqual([
      "notary-official-source",
      "notary-operation",
      "notary-conditions",
      "notary-guarantee",
      "notary-calendar",
      "notary-visit",
      "notary-occupancy",
      "notary-diagnostics",
      "notary-financing",
      "notary-questions",
    ]);
  });

  it("uses a published session when no online window exists", () => {
    const definition = buildNotaryPilot(
      sale({
        sale_procedure: procedure({
          sale_window: undefined,
          sale_session: {
            opens_at: "2026-10-10T14:00:00+02:00",
            closes_at: "2026-10-10T16:00:00+02:00",
          },
          participation_mode: "in_person",
        }),
      }),
    );

    expect(definition.milestones[0]?.label).toBe("Séance notariale publiée");
    expect(definition.milestones[0]?.date).toContain("10 octobre 2026");
    expect(fact(definition, "Mode de participation")?.value).toBe("Sur place");
  });

  it("preserves the published guarantee when it contains a rate and a minimum", () => {
    const definition = buildNotaryPilot(
      sale({
        source_blocks: { consignation: "10 % de la mise à prix, minimum 5 000 €" },
      }),
    );
    expect(fact(definition, "Consignation")?.value).toBe("10 % de la mise à prix, minimum 5 000 €");
  });

  it("keeps missing case facts null and does not invent registration or approval rules", () => {
    const definition = buildNotaryPilot(
      sale({
        source_url: "javascript:alert(1)",
        sale_procedure: null,
        sale_legal_framework: "unknown",
        sale_verification_status: "pending",
        source_blocks: {},
        documents: [],
        documents_rich: [],
        lawyer_name: null,
        starting_price_eur: null,
        sale_date: null,
        visit_dates: [],
        property_type: null,
      }),
    );

    expect(fact(definition, "Type d'opération")?.value).toBeNull();
    expect(fact(definition, "Office notarial")?.value).toBeNull();
    expect(fact(definition, "Prix publié")?.value).toBeNull();
    expect(fact(definition, "Mode de participation")?.value).toBeNull();
    expect(fact(definition, "Consignation")?.value).toBeNull();
    expect(fact(definition, "Conditions de paiement")?.value).toBeNull();
    expect(definition.milestones[0]?.date).toBeNull();
    expect(definition.milestones[0]?.sourceUrl).toBeNull();
    expect(
      `${definition.facts.map((item) => `${item.label} ${item.detail ?? ""}`).join(" ")} ${definition.checks.map((item) => `${item.label} ${item.reason}`).join(" ")}`,
    ).not.toMatch(/inscription|agr[eé]ment/i);
  });

  it("rejects a sale that is not classified as notarial", () => {
    expect(() =>
      buildNotaryPilot(sale({ sale_venue_type: "tribunal", sale_procedure: null })),
    ).toThrow("pilote notarial");
  });
});
