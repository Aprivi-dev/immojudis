// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaleCountdown } from "./SaleCountdown";
import { nextParisMidnight, resolveSaleCountdownTarget } from "@/lib/sale-countdown";
import type { AuctionSale } from "@/lib/types";

function sale(fields: Partial<AuctionSale>): AuctionSale {
  return { id: "countdown", ...fields } as AuctionSale;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("sale countdown deadline", () => {
  it("uses Paris midnight across both daylight-saving transitions", () => {
    expect(nextParisMidnight("2026-03-29").toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(nextParisMidnight("2026-10-25").toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("recognizes a historical date without an hour and uses its Paris civil day", () => {
    const target = resolveSaleCountdownTarget(
      sale({
        sale_date: "2026-10-24T23:30:00Z",
        raw_payload: { sale_date: "25 octobre 2026" },
      }),
    );
    expect(target?.kind).toBe("day");
    expect(target?.target?.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("uses a valid closing window after the opening instant has passed", () => {
    const target = resolveSaleCountdownTarget(
      sale({
        sale_date: "2026-10-03T08:00:00Z",
        raw_payload: {
          source_sale_schedule: {
            opens_at: "2026-10-03T08:00:00Z",
            closes_at: "2026-10-04T14:00:00Z",
          },
        },
      }),
    );
    expect(target?.kind).toBe("window");
    expect(target?.target?.toISOString()).toBe("2026-10-04T14:00:00.000Z");
  });

  it("keeps a precise instant and rejects an invalid civil date", () => {
    expect(resolveSaleCountdownTarget(sale({ sale_date: "2026-10-03T14:00:00Z" }))?.kind).toBe(
      "instant",
    );
    expect(resolveSaleCountdownTarget(sale({ sale_date: "2026-02-30" }))).toBeNull();
  });

  it("does not label a date-only hearing as passed during the day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    render(
      <SaleCountdown
        sale={sale({ sale_date: "2026-10-03T00:00:00Z", raw_payload: { date_precision: "day" } })}
      />,
    );
    expect(screen.getByText("Aujourd'hui · heure à confirmer")).toBeTruthy();
    expect(screen.queryByText("Vente passée")).toBeNull();
  });

  it("does not invent an expired deadline from an incomplete public preview", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    render(<SaleCountdown sale={sale({ sale_date: "2026-10-02T00:00:00Z" })} precisionUnknown />);
    expect(screen.getByText("Échéance à confirmer")).toBeTruthy();
    expect(screen.queryByText("Vente passée")).toBeNull();
  });

  it("labels the countdown to the closing time of a bidding window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    render(
      <SaleCountdown
        variant="block"
        sale={sale({
          sale_date: "2026-10-03T08:00:00Z",
          raw_payload: {
            source_sale_schedule: {
              opens_at: "2026-10-03T08:00:00Z",
              closes_at: "2026-10-03T14:00:00Z",
            },
          },
        })}
      />,
    );
    expect(screen.getByText("Temps avant la clôture")).toBeTruthy();
    expect(screen.queryByText("Vente passée")).toBeNull();
  });
});
