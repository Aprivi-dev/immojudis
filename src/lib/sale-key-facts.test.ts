import { describe, expect, it } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import { nextVisit, saleKeyFacts } from "@/lib/sale-key-facts";
import type { AuctionSale } from "@/lib/types";

const NOW = new Date("2026-10-01T08:00:00Z");

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return { ...EXAMPLE_SALE, ...overrides } as AuctionSale;
}

describe("saleKeyFacts", () => {
  it("gathers price, hearing, court and next visit of a court sale", () => {
    const facts = saleKeyFacts(sale(), NOW);

    expect(facts).toMatchObject({
      priceLabel: "Mise à prix",
      price: 95_000,
      eventLabel: "Audience annoncée",
      eventDate: "2026-10-15T09:30:00+02:00",
      status: null,
      timeConflict: false,
      venueLabel: "Tribunal",
      venueName: "Tribunal judiciaire de Bordeaux",
    });
    expect(facts.nextVisit).toContain("2 octobre 2026");
  });

  it("picks the earliest visit that is not over, and none once they are all over", () => {
    const visits = ["2026-10-07 à 10:30", "2026-09-20 à 14:00", "2026-10-02 à 14:00"];
    expect(nextVisit(sale({ visit_dates: visits }), NOW)).toContain("2 octobre 2026");
    expect(nextVisit(sale({ visit_dates: visits }), new Date("2026-10-03T08:00:00Z"))).toContain(
      "7 octobre 2026",
    );
    expect(nextVisit(sale({ visit_dates: visits }), new Date("2026-10-08T08:00:00Z"))).toBeNull();
    // The visit of the day is still announced.
    expect(nextVisit(sale({ visit_dates: visits }), new Date("2026-10-07T15:00:00Z"))).toContain(
      "7 octobre 2026",
    );
  });

  it("never announces a visit it cannot date", () => {
    expect(nextVisit(sale({ visit_dates: ["sur rendez-vous"] }), NOW)).toBeNull();
    expect(nextVisit(sale({ visit_dates: [] }), NOW)).toBeNull();
  });

  it("keeps the slot of a visit without the sales conditions that follow it", () => {
    const facts = nextVisit(
      sale({ visit_dates: ["2026-10-02 à 14:00 conditions de la vente au greffe"] }),
      NOW,
    );
    expect(facts).toContain("2 octobre 2026");
    expect(facts).not.toContain("conditions");
  });

  it("treats an absent or zero price as unknown", () => {
    expect(saleKeyFacts(sale({ starting_price_eur: 0 }), NOW).price).toBeNull();
    expect(saleKeyFacts(sale({ starting_price_eur: null }), NOW).price).toBeNull();
  });

  it("replaces the date by the status of a postponed sale and drops the visit", () => {
    const facts = saleKeyFacts(sale({ status: "postponed" }), NOW);

    expect(facts.status).toBe("Vente reportée · nouvelle date à confirmer");
    expect(facts.nextVisit).toBeNull();
  });

  it("leaves the court out when the file does not name it", () => {
    const withoutVenue = sale({
      sale_procedure: {
        ...(EXAMPLE_SALE as unknown as { sale_procedure: object }).sale_procedure,
        venue_name: null,
      },
      tribunal: null,
      tribunal_name: null,
    } as Partial<AuctionSale>);

    expect(saleKeyFacts(withoutVenue, NOW).venueName).toBeNull();
  });

  it("uses the vocabulary of the procedure for a notarial sale", () => {
    const facts = saleKeyFacts(
      sale({
        sale_venue_type: "notary",
        sale_procedure: null,
        source_blocks: {},
      } as Partial<AuctionSale>),
      NOW,
    );

    expect(facts.eventLabel).toBe("Séance annoncée");
    expect(facts.venueLabel).toBe("Étude ou organisateur");
    expect(facts.priceLabel).toBe("Mise à prix");
  });
});
