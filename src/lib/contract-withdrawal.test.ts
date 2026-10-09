import { describe, expect, it } from "vitest";
import { computeWithdrawalRefundCents } from "./contract-withdrawal";

const periodStart = new Date("2026-10-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-31T00:00:00.000Z"); // 30 days

describe("computeWithdrawalRefundCents", () => {
  const base = { chargedCents: 2_900, periodStart, periodEnd };

  it("refunds everything in full mode", () => {
    expect(
      computeWithdrawalRefundCents({
        ...base,
        requestedAt: new Date("2026-10-20T00:00:00.000Z"),
        mode: "full",
      }),
    ).toBe(2_900);
  });

  it("keeps the part of the period already provided in prorata mode", () => {
    // 3 days started out of 30: 90 % of 29 EUR comes back.
    expect(
      computeWithdrawalRefundCents({
        ...base,
        requestedAt: new Date("2026-10-03T06:00:00.000Z"),
        mode: "prorata",
      }),
    ).toBe(Math.floor(2_900 * (27 / 30)));
  });

  it("counts a started day as provided", () => {
    const sameInstant = computeWithdrawalRefundCents({
      ...base,
      requestedAt: periodStart,
      mode: "prorata",
    });
    expect(sameInstant).toBeLessThanOrEqual(2_900);
    expect(sameInstant).toBe(Math.floor(2_900 * (30 / 30)));
    const nextHour = computeWithdrawalRefundCents({
      ...base,
      requestedAt: new Date("2026-10-01T01:00:00.000Z"),
      mode: "prorata",
    });
    expect(nextHour).toBe(Math.floor(2_900 * (29 / 30)));
  });

  it("refunds nothing once the period is over", () => {
    expect(
      computeWithdrawalRefundCents({
        ...base,
        requestedAt: new Date("2026-11-05T00:00:00.000Z"),
        mode: "prorata",
      }),
    ).toBe(0);
  });

  it("never refunds more than what is left of the charge", () => {
    expect(
      computeWithdrawalRefundCents({
        ...base,
        alreadyRefundedCents: 2_500,
        requestedAt: new Date("2026-10-02T00:00:00.000Z"),
        mode: "full",
      }),
    ).toBe(400);
    expect(
      computeWithdrawalRefundCents({
        ...base,
        alreadyRefundedCents: 2_900,
        requestedAt: new Date("2026-10-02T00:00:00.000Z"),
        mode: "full",
      }),
    ).toBe(0);
  });

  it("refunds nothing when no charge was made (trial) or the period is invalid", () => {
    expect(
      computeWithdrawalRefundCents({
        chargedCents: 0,
        periodStart,
        periodEnd,
        requestedAt: periodStart,
        mode: "full",
      }),
    ).toBe(0);
    expect(
      computeWithdrawalRefundCents({
        ...base,
        periodEnd: periodStart,
        requestedAt: periodStart,
        mode: "prorata",
      }),
    ).toBe(0);
  });
});
