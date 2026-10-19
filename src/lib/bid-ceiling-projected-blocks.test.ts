import { describe, expect, it } from "vitest";
import { buildCeilingHypotheses } from "@/lib/bid-ceiling-defaults";
import { computeCeilingPlan } from "@/lib/bid-ceiling-engine";
import { listingValuationConflict } from "@/lib/listing-evidence";
import type { CeilingMarketEstimate } from "@/lib/market-estimate-ceiling";
import type { AuctionSale } from "@/lib/types";

/**
 * `v_auction_sales_unlocked` does not serve the source blocks as they are (page text, completeness
 * evidence with the source urls, contacts, source names): it serves
 * `app_private.unlocked_ceiling_blocks` / `unlocked_ceiling_blocks_by_source`
 * (supabase/migrations/20261023100000_discovery_sale_unlocks.sql). The bid ceiling of an unlocked
 * sale must stay the one Analyse computes from the whole blocks.
 *
 * `projected` below is the output of those SQL functions, run on `full` with PostgreSQL 16 when the
 * fixtures were written (supabase/tests/460 asserts the same properties in the database). If the
 * ceiling starts reading another part of the blocks, this test must fail before the page does.
 */
type Fixture = {
  full: {
    source_blocks: Record<string, unknown>;
    observations: Array<{ source_name: string; raw_payload: { source_blocks: unknown } }>;
  };
  projected: { blocks: Record<string, unknown> | null; by: Record<string, unknown> };
};

const FIXTURES: Record<string, Fixture> = {
  fees_only_in_page_text: {
    full: {
      source_blocks: {
        page_text:
          "Annonce. Les frais préalables s’élèvent à 4 250,50 € TTC. Mise à prix 30 000 €.",
        titre: "Appartement",
        conditions: {
          consignation: "3 000 €",
        },
        avocat: "Me Dupont",
        listing_completeness: {
          source_field_observations: [
            {
              evidence: [
                {
                  source_url: "https://licitor.example/annonce/1",
                  locator: "p1",
                },
              ],
            },
          ],
        },
      },
      observations: [
        {
          source_name: "encheres",
          raw_payload: {
            source_blocks: {
              page_text: "Frais préalables : 9 999 €",
              paiement: {
                consignation_eur: "3 000 €",
              },
            },
          },
        },
      ],
    },
    projected: {
      by: {
        source_1: {
          "conditions.consignation": "3 000 €",
        },
        source_2: {
          "paiement.consignation_eur": "3 000 €",
        },
      },
      blocks: {
        _: "frais préalables s’élèvent à 4 250,50 €",
        "conditions.consignation": "3 000 €",
      },
    },
  },
  fees_in_kept_key_then_page_text: {
    full: {
      source_blocks: {
        frais_preliminaires: "Frais préalables : 2 800 € HT",
        page_text: "Frais préalables : 7 000 €",
        conditions_vente: "Consignation de 5 000 euros",
      },
      observations: [],
    },
    projected: {
      by: {
        source_1: {
          conditions_vente: "Consignation de 5 000 euros",
          frais_preliminaires: "Frais préalables : 2 800 € HT",
        },
      },
      blocks: {
        _: "Frais préalables : 7 000 €",
        conditions_vente: "Consignation de 5 000 euros",
        frais_preliminaires: "Frais préalables : 2 800 € HT",
      },
    },
  },
  first_match_out_of_range: {
    full: {
      source_blocks: {
        page_text: "Frais préalables : 120 € puis frais préalables : 6 000 €",
        paiement: "chèque de consignation",
      },
      observations: [],
    },
    projected: {
      by: {
        source_1: {
          paiement: "chèque de consignation",
        },
      },
      blocks: {
        _: "Frais préalables : 120 €",
        paiement: "chèque de consignation",
      },
    },
  },
  conflicting_deposits: {
    full: {
      source_blocks: {
        conditions: {
          consignation: "2 000 €",
        },
      },
      observations: [
        {
          source_name: "autre",
          raw_payload: {
            source_blocks: {
              conditions: {
                caution: "4 000 €",
              },
            },
          },
        },
      ],
    },
    projected: {
      by: {
        source_1: {
          "conditions.consignation": "2 000 €",
        },
        source_2: {
          "conditions.caution": "4 000 €",
        },
      },
      blocks: {
        "conditions.consignation": "2 000 €",
      },
    },
  },
  unicode_spaces: {
    full: {
      source_blocks: {
        page_text: "FRAIS PRÉALABLES : 5 250 € environ",
      },
      observations: [],
    },
    projected: {
      by: {},
      blocks: {
        _: "FRAIS PRÉALABLES : 5 250 €",
      },
    },
  },
  newline_between: {
    full: {
      source_blocks: {
        page_text: "Frais préalables\n4 000 €",
        titre_detail: "Une maison",
      },
      observations: [],
    },
    projected: {
      by: {},
      blocks: {
        titre_detail: "Une maison",
      },
    },
  },
  titre_detail_conflict: {
    full: {
      source_blocks: {
        titre_detail: "Appartement de 3 pièces",
        page_text: "sans objet",
        related: {
          frais: "autre annonce 1 000 €",
        },
      },
      observations: [],
    },
    projected: {
      by: {},
      blocks: {
        titre_detail: "Appartement de 3 pièces",
      },
    },
  },
  nothing_useful: {
    full: {
      source_blocks: {
        page_text: "Rien",
        avocat: "Me X",
        description: "Frais préalables 1 111 €",
      },
      observations: [],
    },
    projected: {
      by: {},
      blocks: {
        _: "Frais préalables 1 111 €",
      },
    },
  },
  nested_cost_path: {
    full: {
      source_blocks: {
        listing_completeness: {
          source_procedure_profile: {
            frais_de_poursuite: "1 500 €",
            consignation: ["3 500 €"],
          },
        },
      },
      observations: [],
    },
    projected: {
      by: {
        source_1: {
          "listing_completeness.source_procedure_profile.consignation[0]": "3 500 €",
          "listing_completeness.source_procedure_profile.frais_de_poursuite": "1 500 €",
        },
      },
      blocks: {
        "listing_completeness.source_procedure_profile.consignation[0]": "3 500 €",
        "listing_completeness.source_procedure_profile.frais_de_poursuite": "1 500 €",
      },
    },
  },
};

const estimate = {
  actionable: true,
  estimatedValueEur: 200_000,
  medianPricePerM2: 2_500,
  p75PricePerM2: 2_800,
  qualityLabel: "correcte",
  sampleSize: 12,
  source: "DVF normalisé",
} as CeilingMarketEstimate;

function saleWith(overrides: Partial<AuctionSale>): AuctionSale {
  return {
    id: "sale-1",
    department: "69",
    property_type: "apartment",
    occupancy_status: "vacant",
    starting_price_eur: 60_000,
    app_surface_m2: 70,
    app_surface_kind: "habitable",
    description: null,
    source_description: null,
    ...overrides,
  } as unknown as AuctionSale;
}

/**
 * PostgREST sends jsonb: keys come back shorter first, then in byte order. The ceiling reads the
 * first « frais préalables » of JSON.stringify(blocks), so the order is part of the contract.
 */
function inJsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inJsonbOrder);
  if (!value || typeof value !== "object") return value;
  const bytes = (key: string) => Buffer.from(key, "utf8");
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => {
        const l = bytes(left);
        const r = bytes(right);
        return l.length - r.length || Buffer.compare(l, r);
      })
      .map(([key, item]) => [key, inJsonbOrder(item)]),
  );
}

/** The sale as the Analyse view serves it: whole blocks, keyed by source name. */
function analysisSale(fixture: Fixture, overrides: Partial<AuctionSale> = {}): AuctionSale {
  const bySource: Record<string, unknown> = { "licitor:primary": fixture.full.source_blocks };
  fixture.full.observations.forEach((observation, index) => {
    bySource[`${observation.source_name}:${index + 1}`] = observation.raw_payload.source_blocks;
  });
  return saleWith({
    source_blocks: inJsonbOrder(fixture.full.source_blocks),
    source_blocks_by_source: inJsonbOrder(bySource),
    ...overrides,
  } as Partial<AuctionSale>);
}

/** The sale as the unlocked view serves it: the projected blocks. */
function unlockedSale(fixture: Fixture, overrides: Partial<AuctionSale> = {}): AuctionSale {
  return saleWith({
    source_blocks: fixture.projected.blocks,
    source_blocks_by_source: fixture.projected.by,
    ...overrides,
  } as Partial<AuctionSale>);
}

describe("bid ceiling of an unlocked sale: projected source blocks", () => {
  it.each(Object.entries(FIXTURES))(
    "%s: same hypotheses and same ceiling as Analyse",
    (_name, fixture) => {
      for (const overrides of [
        {},
        { description: "Mise à prix 60 000 euros, visite sur rendez-vous." },
        { source_description: "Frais préalables : 3 333 €" },
      ]) {
        const whole = buildCeilingHypotheses(analysisSale(fixture, overrides), estimate);
        const projected = buildCeilingHypotheses(unlockedSale(fixture, overrides), estimate);
        expect(projected.fees.fpt).toBe(whole.fees.fpt);
        expect(projected.feesSource).toEqual(whole.feesSource);
        expect(projected.consignation).toBe(whole.consignation);
        expect(projected).toEqual(whole);
        expect(computeCeilingPlan(projected)).toEqual(computeCeilingPlan(whole));
      }
    },
  );

  it.each(Object.entries(FIXTURES))("%s: same suspended estimate as Analyse", (_name, fixture) => {
    const overrides = { property_type: "land" } as Partial<AuctionSale>;
    expect(listingValuationConflict(unlockedSale(fixture, overrides))).toBe(
      listingValuationConflict(analysisSale(fixture, overrides)),
    );
  });

  it("keeps the preliminary fees that only the page text states, and the deposit of the conditions", () => {
    const fixture = FIXTURES.fees_only_in_page_text!;
    const hypotheses = buildCeilingHypotheses(unlockedSale(fixture), estimate);
    expect(hypotheses.fees.fpt).toBe(4_251);
    expect(hypotheses.consignation).toBe(3_000);
  });

  it("serves no page text, no source url, no source name", () => {
    for (const [name, fixture] of Object.entries(FIXTURES)) {
      const served = JSON.stringify(fixture.projected);
      expect(served, name).not.toMatch(
        /source_url|locator|https?:|licitor|encheres|:primary|Me Dupont/,
      );
      // The only free text is the excerpt of the preliminary fees, not the page.
      expect(served, name).not.toContain("Annonce.");
      expect(served, name).not.toContain("Mise à prix 30 000");
    }
  });
});
