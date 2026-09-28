import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "./example-sale";
import { getFactReliability, getKeyFactReliabilities } from "./fact-reliability";
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
});
