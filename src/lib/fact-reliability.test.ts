import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "./example-sale";
import {
  getFactReliabilitiesFromClaims,
  getFactReliability,
  getFactReliabilityForDisplay,
  getKeyFactReliabilities,
} from "./fact-reliability";
import type { AuctionSale } from "./types";

const sale = (overrides: Partial<AuctionSale> = {}): AuctionSale => ({
  ...EXAMPLE_SALE,
  ...overrides,
});

describe("fact reliability", () => {
  it("requires a recorded source check before calling ordinary fields observed", () => {
    expect(getFactReliability(sale(), "sale_date").status).toBe("to_confirm");
    expect(getFactReliability(sale(), "starting_price_eur").status).toBe("to_confirm");
    expect(getFactReliability(sale(), "occupancy_status").status).toBe("to_confirm");
  });

  it("does not promote an ordinary value from an unrelated global source check", () => {
    const fact = getFactReliability(
      sale({
        source_checks: { canonical: { checked_at: "2026-09-12T10:00:00Z" } },
      }),
      "starting_price_eur",
    );

    expect(fact.status).toBe("to_confirm");
    expect(fact.detail).toContain("contrôle global de source");
    expect(fact.detail).toContain("pas rattaché à cette valeur");
  });

  it("accepts an explicitly field-linked source check as observed", () => {
    const fact = getFactReliability(
      sale({
        source_checks: { starting_price_eur: { checked_at: "2026-09-12T10:00:00Z" } },
      }),
      "starting_price_eur",
    );

    expect(fact.status).toBe("observed");
    expect(fact.detail).toContain("contrôle de source est enregistré");
  });

  it("does not transfer a canonical date check to a different displayed sale window", () => {
    const fact = getFactReliability(
      sale({
        sale_date: "2026-10-10T10:00:00Z",
        source_checks: { sale_date: { checked_at: "2026-09-12T10:00:00Z" } },
      }),
      "sale_date",
      "2026-10-10T11:00:00Z",
    );

    expect(fact.status).toBe("to_confirm");
    expect(fact.detail).toContain("modalités de vente");
  });

  it("keeps the fiche readable when a source check is malformed", () => {
    const fact = getFactReliability(
      sale({
        source_checks: { starting_price_eur: null } as unknown as AuctionSale["source_checks"],
      }),
      "starting_price_eur",
    );

    expect(fact.status).toBe("to_confirm");
  });

  it("marks an estimated or calculated surface as inferred", () => {
    expect(
      getFactReliability(
        sale({
          app_surface_m2: null,
          habitable_surface_m2: null,
          carrez_surface_m2: null,
          rooms_count: 1,
        }),
        "surface",
      ).status,
    ).toBe("inferred");

    expect(
      getFactReliability(sale({ quality_flags: ["surface_calculated_from_rooms"] }), "surface")
        .status,
    ).toBe("inferred");
  });

  it("exposes explicit source conflicts before any other status", () => {
    const reliabilities = getKeyFactReliabilities(
      sale({
        source_conflicts: [
          { field: "occupancy_status", selected: "vacant", alternative: "rented" },
        ],
      }),
    );

    expect(reliabilities.occupancy_status.status).toBe("conflict");
    expect(reliabilities.occupancy_status.detail).toContain("signaux contradictoires");
  });

  it("keeps a low confidence surface to confirm even when an excerpt exists", () => {
    const fact = getFactReliability(
      sale({ surface_confidence: 0.45, surface_evidence: "Surface 42 m²" }),
      "surface",
    );

    expect(fact.status).toBe("to_confirm");
    expect(fact.detail).toContain("confiance enregistrée reste faible");
  });

  it("does not invent proof for a missing value", () => {
    const fact = getFactReliability(sale({ sale_date: null }), "sale_date");

    expect(fact.status).toBe("to_confirm");
    expect(fact.detail).toContain("n'est pas renseignée");
    expect(fact.detail).not.toContain("observée");
  });

  it("keeps a candidate claim to confirm for every fiche key field", () => {
    const claims = (
      ["sale_date", "starting_price_eur", "surface_m2", "occupancy_status"] as const
    ).map((field_key) => ({
      field_key,
      fact_status: "candidate" as const,
      captured_at: "2026-09-28T09:00:00Z",
    }));

    const facts = getFactReliabilitiesFromClaims(sale(), claims);

    expect(facts.sale_date.status).toBe("to_confirm");
    expect(facts.starting_price_eur.status).toBe("to_confirm");
    expect(facts.surface.status).toBe("to_confirm");
    expect(facts.occupancy_status.status).toBe("to_confirm");
    expect(facts.surface.detail).toContain("pas encore vérifiée");
  });

  it("maps accepted claims to observed without returning claim provenance", () => {
    const knownSale = sale({ occupancy_status: "vacant" });
    const facts = getFactReliabilitiesFromClaims(knownSale, [
      {
        field_key: "sale_date",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.sale_date,
        captured_at: "2026-09-28T09:00:00Z",
      },
      {
        field_key: "starting_price_eur",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.starting_price_eur,
        captured_at: "2026-09-28T09:01:00Z",
      },
      {
        field_key: "surface_m2",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.app_surface_m2,
        captured_at: null,
      },
      {
        field_key: "occupancy_status",
        fact_status: "accepted",
        value_jsonb: knownSale.occupancy_status,
        captured_at: null,
      },
    ]);

    expect(facts.sale_date).toMatchObject({
      status: "observed",
      checkedAt: "2026-09-28T09:00:00Z",
    });
    expect(facts.starting_price_eur.status).toBe("observed");
    expect(facts.surface.status).toBe("observed");
    expect(facts.occupancy_status.status).toBe("observed");
    expect(JSON.stringify(facts)).not.toContain("source_url");
    expect(JSON.stringify(facts)).not.toContain("artifact");
  });

  it("maps Python canonical claim keys to their fiche fields", () => {
    const knownSale = sale({ occupancy_status: "vacant" });
    const facts = getFactReliabilitiesFromClaims(knownSale, [
      {
        field_key: "sale.sale_date",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.sale_date,
        captured_at: "2026-09-28T09:00:00Z",
      },
      {
        field_key: "sale.starting_price_eur",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.starting_price_eur,
        captured_at: "2026-09-28T09:01:00Z",
      },
      {
        field_key: "property.surface_m2",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.app_surface_m2,
        captured_at: null,
      },
      {
        field_key: "property.occupancy_status",
        fact_status: "accepted",
        value_jsonb: knownSale.occupancy_status,
        captured_at: null,
      },
    ]);

    expect(facts.sale_date.status).toBe("observed");
    expect(facts.starting_price_eur.status).toBe("observed");
    expect(facts.surface.status).toBe("observed");
    expect(facts.occupancy_status.status).toBe("observed");
  });

  it("gives conflicts precedence over accepted and candidate claims", () => {
    const facts = getFactReliabilitiesFromClaims(sale(), [
      {
        field_key: "sale_date",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.sale_date,
        captured_at: null,
      },
      { field_key: "date", fact_status: "candidate", captured_at: null },
      { field_key: "auction_date", fact_status: "conflicted", captured_at: null },
      { field_key: "starting_price_eur", fact_status: "conflicted", captured_at: null },
      { field_key: "surface_m2", fact_status: "conflicted", captured_at: null },
      { field_key: "occupancy", fact_status: "conflicted", captured_at: null },
    ]);

    expect(facts.sale_date.status).toBe("conflict");
    expect(facts.starting_price_eur.status).toBe("conflict");
    expect(facts.surface.status).toBe("conflict");
    expect(facts.occupancy_status.status).toBe("conflict");
  });

  it("does not mark an accepted claim observed when its value differs from the fiche", () => {
    const knownSale = sale({ occupancy_status: "vacant" });
    const facts = getFactReliabilitiesFromClaims(knownSale, [
      {
        field_key: "sale_date",
        fact_status: "accepted",
        value_jsonb: "2027-01-01T10:00:00Z",
        captured_at: null,
      },
      {
        field_key: "starting_price_eur",
        fact_status: "accepted",
        value_jsonb: 1,
        captured_at: null,
      },
      { field_key: "surface_m2", fact_status: "accepted", value_jsonb: 1, captured_at: null },
      {
        field_key: "occupancy_status",
        fact_status: "accepted",
        value_jsonb: "rented",
        captured_at: null,
      },
    ]);

    expect(facts.sale_date.status).toBe("conflict");
    expect(facts.starting_price_eur.status).toBe("conflict");
    expect(facts.surface.status).toBe("conflict");
    expect(facts.occupancy_status.status).toBe("conflict");
  });

  it("does not clear an unresolved legacy conflict with a matching accepted claim", () => {
    const conflictedSale = sale({
      source_conflicts: [
        { field: "starting_price_eur", selected: "120000", alternative: "125000" },
      ],
    });

    const facts = getFactReliabilitiesFromClaims(conflictedSale, [
      {
        field_key: "starting_price_eur",
        fact_status: "accepted",
        value_jsonb: conflictedSale.starting_price_eur,
        captured_at: "2026-09-28T09:00:00Z",
      },
    ]);

    expect(facts.starting_price_eur.status).toBe("conflict");
    expect(facts.starting_price_eur.detail).toContain("signaux contradictoires");
  });

  it("falls back to legacy reliability when the claim view has no rows", () => {
    const legacy = getKeyFactReliabilities(sale());
    expect(getFactReliabilitiesFromClaims(sale(), [])).toEqual(legacy);
  });

  it("keeps the displayed sale window cautious even when the accepted claim is observed", () => {
    const facts = getFactReliabilitiesFromClaims(sale(), [
      {
        field_key: "sale_date",
        fact_status: "accepted",
        value_jsonb: EXAMPLE_SALE.sale_date,
        captured_at: "2026-09-28T09:00:00Z",
      },
    ]);

    const displayed = getFactReliabilityForDisplay(
      sale(),
      "sale_date",
      "2026-10-10T11:00:00Z",
      facts,
    );
    expect(displayed.status).toBe("to_confirm");
    expect(displayed.detail).toContain("modalités de vente");
  });

  it("scopes land claims out of a displayed built surface", () => {
    const builtSale = sale({
      app_surface_m2: 80,
      habitable_surface_m2: 80,
      carrez_surface_m2: null,
      land_surface_m2: 900,
      app_surface_kind: "habitable",
      surface_scope: "total",
      surface_evidence: null,
      source_checks: null,
    });

    expect(
      getFactReliabilitiesFromClaims(builtSale, [
        {
          field_key: "property.land_surface_m2",
          fact_status: "accepted",
          value_jsonb: 900,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("to_confirm");
    expect(
      getFactReliabilitiesFromClaims(builtSale, [
        {
          field_key: "property.land_surface_m2",
          fact_status: "conflicted",
          value_jsonb: 901,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("to_confirm");
    expect(
      getFactReliabilitiesFromClaims(builtSale, [
        {
          field_key: "property.habitable_surface_m2",
          fact_status: "accepted",
          value_jsonb: 80,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("observed");
  });

  it("scopes built claims out of a displayed land surface", () => {
    const landSale = sale({
      property_type: "land",
      app_surface_m2: 900,
      app_surface_kind: "land",
      surface_scope: "land",
      land_surface_m2: 900,
      habitable_surface_m2: null,
      carrez_surface_m2: null,
      surface_evidence: null,
      source_checks: null,
    });

    expect(
      getFactReliabilitiesFromClaims(landSale, [
        {
          field_key: "property.surface_m2",
          fact_status: "accepted",
          value_jsonb: 900,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("observed");
    expect(
      getFactReliabilitiesFromClaims(landSale, [
        {
          field_key: "property.app_surface_m2",
          fact_status: "accepted",
          value_jsonb: 900,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("observed");
    expect(
      getFactReliabilitiesFromClaims(landSale, [
        {
          field_key: "property.habitable_surface_m2",
          fact_status: "conflicted",
          value_jsonb: 899,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("to_confirm");
    expect(
      getFactReliabilitiesFromClaims(landSale, [
        {
          field_key: "property.carrez_surface_m2",
          fact_status: "accepted",
          value_jsonb: 900,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("to_confirm");
    expect(
      getFactReliabilitiesFromClaims(landSale, [
        {
          field_key: "property.land_surface_m2",
          fact_status: "accepted",
          value_jsonb: 900,
          captured_at: null,
        },
      ]).surface.status,
    ).toBe("observed");
  });

  it("applies a parcel scope warning only to a displayed land surface", () => {
    const builtSale = sale({
      app_surface_m2: 80,
      habitable_surface_m2: 80,
      land_surface_m2: 900,
      app_surface_kind: "habitable",
      surface_scope: "total",
      surface_evidence: "Surface habitable : 80 m²",
      quality_flags: ["parcel_surface_scope_unverified"],
      source_checks: null,
    });
    expect(getFactReliability(builtSale, "surface").status).toBe("observed");

    const landSale = sale({
      property_type: "land",
      app_surface_m2: 900,
      app_surface_kind: "land",
      surface_scope: "land",
      land_surface_m2: 900,
      surface_evidence: null,
      quality_flags: ["parcel_surface_scope_unverified"],
      source_checks: null,
    });
    const fact = getFactReliability(landSale, "surface");
    expect(fact.status).toBe("to_confirm");
    expect(fact.detail).toContain("total des parcelles");
  });
});
