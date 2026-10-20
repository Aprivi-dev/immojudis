import { describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { buildPlanEntitlements } from "./entitlements";
import { buildCeilingSnapshot } from "./ceiling-snapshot";

vi.mock("@/lib/sale-market-estimates", () => ({ getPrecomputedMarketEstimate: vi.fn() }));

const { buildReportSnapshot } = await import("./analysis");

function snapshotOf(sale: Partial<AuctionSale>) {
  const full = {
    id: "sale-venue",
    title: "Maison à Pau",
    city: "Pau",
    department: "64",
    property_type: "house",
    starting_price_eur: 92_000,
    app_surface_m2: 92,
    app_surface_kind: "habitable",
    ...sale,
  } as AuctionSale;
  return buildReportSnapshot({
    sale: full,
    marketEstimate: null,
    activeComparables: { scopeLabel: "", sales: [] },
    cadastreParcels: [],
    dpeDiagnostics: [],
    urbanPlanningSignals: [],
    valuationBacktest: null,
    ceilingSnapshot: buildCeilingSnapshot(full, null),
    plan: buildPlanEntitlements("analyse"),
  });
}

describe("type de vente du rapport", () => {
  it.each(["tribunal", "notary", "state"] as const)(
    "conserve le type de vente %s pour la page « Dossier de financement »",
    (venue) => {
      expect(snapshotOf({ sale_venue_type: venue }).sale.venueType).toBe(venue);
    },
  );

  it("garde le contrôle du type de vente, dont « conflict », pour la page « Dossier de financement »", () => {
    expect(
      snapshotOf({ sale_venue_type: "tribunal", sale_verification_status: "conflict" }).sale
        .venueVerificationStatus,
    ).toBe("conflict");
    expect(
      snapshotOf({ sale_venue_type: "tribunal", sale_verification_status: "verified" }).sale
        .venueVerificationStatus,
    ).toBe("verified");
  });

  it("garde « unknown » quand le type n'est pas qualifié", () => {
    expect(snapshotOf({ sale_venue_type: undefined }).sale.venueType).toBe("unknown");
  });
});
