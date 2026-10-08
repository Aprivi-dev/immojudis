// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { FactReliabilityBadge } from "./FactReliabilityBadge";

afterEach(cleanup);

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return { ...EXAMPLE_SALE, ...overrides };
}

describe("FactReliabilityBadge", () => {
  it("shows the public presentation while preserving the internal status", () => {
    render(<FactReliabilityBadge sale={sale()} field="starting_price_eur" />);

    const badge = screen.getByRole("note", { name: /Mise à prix : Non vérifié/ });
    expect(badge.textContent).toBe("Non vérifié");
    expect(badge.getAttribute("data-fact-status")).toBe("to_confirm");
    expect(badge.getAttribute("data-fact-kind")).toBe("reported");
    expect(badge.getAttribute("title")).toContain("reprise automatiquement");
  });

  it("keeps the old internal status when a field is documented", () => {
    render(
      <FactReliabilityBadge
        sale={sale({
          source_checks: { starting_price_eur: { checked_at: "2026-09-12T10:00:00Z" } },
        })}
        field="starting_price_eur"
      />,
    );

    const badge = screen.getByRole("note", { name: /Mise à prix : Documenté/ });
    expect(badge.getAttribute("data-fact-status")).toBe("observed");
    expect(badge.getAttribute("data-fact-kind")).toBe("documented");
  });

  it("can be hidden when the displayed value is blocked by the AI review", () => {
    const { container } = render(
      <FactReliabilityBadge sale={sale()} field="starting_price_eur" blockedByAiReview />,
    );

    expect(container.querySelector('[data-fact-field="starting_price_eur"]')).toBeNull();
  });
});
