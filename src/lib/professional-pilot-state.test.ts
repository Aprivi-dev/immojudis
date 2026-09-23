import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { buildStatePilot } from "@/lib/professional-pilot-state";
import type { AuctionSale } from "@/lib/types";

const stateProcedure = (overrides: Record<string, unknown> = {}) => ({
  schema_version: "sale_procedure_v1",
  ruleset_version: "state-sale-pilot-test-v1",
  venue_type: "state",
  state_sale_method: "appel_offres",
  legal_framework: "state_sale",
  venue_name: "Direction départementale des finances publiques",
  venue_address: null,
  participation_mode: "unknown",
  organizer_name: null,
  organizer_type: "state_service",
  organizer_contact: null,
  eligible_bar: null,
  rules: {
    lawyer_required: null,
    lawyer_note: "",
    bid_method: "",
    guarantee: {
      amount_eur: null,
      rate_pct: null,
      minimum_eur: null,
      status: "unknown",
      note: "",
    },
    financing_condition: null,
    cooling_off_period: null,
    payment_deadline_days: null,
    overbid: {
      allowed: null,
      minimum_increase_pct: null,
      window_days: null,
      note: "",
    },
  },
  verification: {
    status: "verified",
    verified_at: "2026-09-23T09:00:00Z",
    case_source_count: 1,
    case_sources: [
      {
        kind: "listing",
        label: "Avis officiel",
        source_name: "Service vendeur",
        url: "https://domaine.example.test/avis/123",
      },
    ],
    regulatory_sources: [],
    facts: [
      {
        key: "state_sale_method",
        value: "appel_offres",
        status: "verified",
        evidence: ["Avis officiel"],
        source_url: "https://domaine.example.test/avis/123",
      },
    ],
    issues: [],
  },
  ...overrides,
});

function stateSale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    sale_venue_type: "state",
    sale_legal_framework: "state_sale",
    sale_verification_status: "verified",
    sale_procedure: stateProcedure(),
    source_url: "https://domaine.example.test/avis/123",
    source_name: "Cessions de l'État",
    primary_source: "Service vendeur",
    sale_date: "2026-10-14T12:00:00+02:00",
    visit_dates: ["2026-10-03 à 10:00"],
    starting_price_eur: 125_000,
    land_surface_m2: 1_000,
    source_blocks: {
      reference_cadastrale: "AB n° 12",
    },
    documents_rich: [
      {
        url: "https://domaine.example.test/documents/reglement.pdf",
        label: "Règlement de la consultation",
        type: "pdf",
        document_type: "reglement_consultation",
        extraction_status: "complete",
      },
      {
        url: "javascript:alert(1)",
        label: "Lien non sûr",
        type: "pdf",
        document_type: "notice",
        extraction_status: null,
      },
    ],
    documents: [],
    ...overrides,
  };
}

describe("state professional pilot", () => {
  it("exposes the disposal method, deadline, source documents and state-specific checks", () => {
    const pilot = buildStatePilot(stateSale());

    expect(pilot.kind).toBe("state");
    expect(pilot.facts.find((fact) => fact.label === "Mode de cession publié")).toMatchObject({
      value: "Appel d’offres",
      sourceUrl: "https://domaine.example.test/avis/123",
    });
    expect(pilot.facts.find((fact) => fact.label === "Pièces du dossier")).toMatchObject({
      value: "1 pièce · Règlement de la consultation",
      sourceUrl: "https://domaine.example.test/documents/reglement.pdf",
    });
    expect(pilot.milestones[0]).toMatchObject({
      label: "Date publiée à qualifier dans l'avis",
      date: "14 octobre 2026 à 12:00",
    });
    expect(
      pilot.facts.find((fact) => fact.label === "Référence parcellaire publiée")?.value,
    ).toContain("Section AB n° 12");

    expect(pilot.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "state-eligibility",
        "state-submission",
        "state-parcel",
        "state-urbanism",
        "state-easements",
      ]),
    );
    expect(pilot.checks.find((check) => check.id === "state-submission")?.label).toContain("canal");
  });

  it("keeps missing state facts null and does not invent a submission channel", () => {
    const pilot = buildStatePilot(
      stateSale({
        sale_procedure: null,
        source_url: "javascript:alert(1)",
        source_blocks: {},
        source_name: "Cessions de l'État",
        sale_date: null,
        visit_dates: [],
        starting_price_eur: null,
        land_surface_m2: null,
        documents: [],
        documents_rich: [],
      }),
    );

    expect(pilot.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Mode de cession publié", value: null }),
        expect.objectContaining({ label: "Échéance publiée", value: null }),
        expect.objectContaining({ label: "Prix publié", value: null }),
        expect.objectContaining({ label: "Pièces du dossier", value: null }),
        expect.objectContaining({ label: "Visites publiées", value: null }),
        expect.objectContaining({ label: "Référence parcellaire publiée", value: null }),
      ]),
    );
    expect(pilot.facts.some((fact) => /en ligne|plateforme|email/i.test(fact.value ?? ""))).toBe(
      false,
    );
    expect(pilot.checks.find((check) => check.id === "state-submission")?.reason).toContain(
      "à confirmer",
    );
  });

  it("filters unsafe document and source URLs", () => {
    const unsafe = stateProcedure({
      verification: {
        status: "verified",
        verified_at: null,
        case_source_count: 1,
        case_sources: [{ kind: "listing", url: "javascript:alert(1)" }],
        regulatory_sources: [],
        facts: [
          {
            key: "state_sale_method",
            value: "appel_offres",
            status: "verified",
            evidence: [],
            source_url: "javascript:alert(1)",
          },
        ],
        issues: [],
      },
    });
    const pilot = buildStatePilot(
      stateSale({
        sale_procedure: unsafe,
        source_url: "javascript:alert(1)",
        documents_rich: [
          {
            url: "javascript:alert(1)",
            label: "Règlement",
            type: "pdf",
            document_type: "notice",
            extraction_status: null,
          },
        ],
      }),
    );

    expect(
      pilot.facts.every((fact) => !fact.sourceUrl || /^https?:\/\//.test(fact.sourceUrl)),
    ).toBe(true);
    expect(
      pilot.milestones.every(
        (milestone) => !milestone.sourceUrl || /^https?:\/\//.test(milestone.sourceUrl),
      ),
    ).toBe(true);
    expect(
      pilot.checks.every((check) => !check.sourceUrl || /^https?:\/\//.test(check.sourceUrl)),
    ).toBe(true);
    expect(pilot.facts.find((fact) => fact.label === "Pièces du dossier")?.value).toBe(null);
  });
});
