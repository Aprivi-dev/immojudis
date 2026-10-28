import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "../example-sale";
import { assertReportSourceCurrent, reportSourceFingerprint } from "./source-integrity";

describe("saved report source integrity", () => {
  const snapshot = () => ({ sourceFingerprint: reportSourceFingerprint(EXAMPLE_SALE) });

  it("accepts the unchanged source despite capture timestamps", () => {
    expect(() =>
      assertReportSourceCurrent(snapshot(), {
        ...EXAMPLE_SALE,
        updated_at: "2030-01-01T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it.each([
    { investment_score: null },
    { carrez_surface_m2: 97.16, property_type: "apartment" },
    { occupancy_status: "vacant" },
    {
      risks: [
        { risk_type: "physical", risk_label: "Contrôle parasitaire incomplet", severity: null },
      ],
    },
  ])("rejects a report when its source facts were corrected: %j", (changes) => {
    expect(() =>
      assertReportSourceCurrent(snapshot(), {
        ...EXAMPLE_SALE,
        ...changes,
      } as typeof EXAMPLE_SALE),
    ).toThrow(/actualisées/);
  });

  it("requires refreshing legacy reports without a verifiable source fingerprint", () => {
    expect(() => assertReportSourceCurrent({}, EXAMPLE_SALE)).toThrow(/sauvegardez/);
  });

  describe("sale_conditions (migration 20261103110000)", () => {
    const conditions = { procedure: "online_tender", first_offer_eur: 200_000 };
    const notarial = { ...EXAMPLE_SALE, sale_conditions: conditions } as typeof EXAMPLE_SALE;

    it("keeps valid a notarial report saved before the column existed", () => {
      // Saved before the migration: fingerprint of the sale without the column.
      const before = { sourceFingerprint: reportSourceFingerprint(EXAMPLE_SALE) };
      expect(() => assertReportSourceCurrent(before, notarial)).not.toThrow();
      // The same fingerprint written with an explicit null column.
      const withNull = {
        sourceFingerprint: reportSourceFingerprint({ ...EXAMPLE_SALE, sale_conditions: null }),
      };
      expect(() => assertReportSourceCurrent(withNull, notarial)).not.toThrow();
    });

    it("reads a report saved with the conditions as current, and rejects changed conditions", () => {
      const after = { sourceFingerprint: reportSourceFingerprint(notarial) };
      expect(() => assertReportSourceCurrent(after, notarial)).not.toThrow();
      expect(() =>
        assertReportSourceCurrent(after, {
          ...notarial,
          sale_conditions: { ...conditions, negotiation_fee_rate: 0.05 },
        } as typeof EXAMPLE_SALE),
      ).toThrow(/actualisées/);
    });

    it("still rejects a corrected source on a report saved before the column", () => {
      const before = { sourceFingerprint: reportSourceFingerprint(EXAMPLE_SALE) };
      expect(() =>
        assertReportSourceCurrent(before, { ...notarial, occupancy_status: "vacant" } as never),
      ).toThrow(/actualisées/);
    });

    it("gives a tribunal sale the same fingerprint with or without an empty column", () => {
      expect(reportSourceFingerprint({ ...EXAMPLE_SALE, sale_conditions: null })).toBe(
        reportSourceFingerprint(EXAMPLE_SALE),
      );
    });
  });
});
